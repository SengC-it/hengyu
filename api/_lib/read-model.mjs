import { hasSupabaseConfig, selectRows } from './supabase.mjs';
import { experimentValidation } from '../../src/model/experiment-status.mjs';

const ADVISORY_SELECT = [
  'advisory_id', 'experiment_id', 'symbol', 'advisory_type', 'alert_level',
  'signal_at', 'expires_at', 'reference_bid', 'reference_ask', 'entry_reference', 'stop_reference', 'exit_reference',
  'gross_edge_bps', 'funding_edge_bps', 'fee_bps', 'spread_bps', 'slippage_bps', 'impact_bps',
  'latency_buffer_bps', 'uncertainty_bps', 'conservative_net_edge_bps',
  'status', 'pnl_eligible', 'created_at', 'decision_at', 'scheduler_delay_ms',
  'theoretical_open', 'executable_price', 'holding_period_ms', 'funding_cost_bps',
  'funding_event_count', 'mae_bps', 'mfe_bps', 'mark_to_market_drawdown_bps', 'metadata'
].join(',');

function numberOrNull(value) {
  return value == null ? null : Number(value);
}

export function publicSignal(row) {
  return {
    signalId: row.advisory_id,
    experimentId: row.experiment_id,
    generatedAt: row.signal_at,
    decisionTime: row.decision_at ?? row.signal_at,
    expiresAt: row.expires_at,
    alertLevel: row.alert_level,
    action: row.advisory_type,
    symbol: row.symbol,
    reference: {
      entryPrice: numberOrNull(row.entry_reference),
      executablePrice: numberOrNull(row.executable_price ?? row.entry_reference),
      bidPrice: numberOrNull(row.reference_bid),
      askPrice: numberOrNull(row.reference_ask),
      theoreticalOpen: numberOrNull(row.theoretical_open),
      stopPrice: numberOrNull(row.stop_reference),
      takeProfitPrice: numberOrNull(row.exit_reference),
      exitPrice: numberOrNull(row.exit_reference),
      maximumHoldMs: row.holding_period_ms == null ? null : Number(row.holding_period_ms)
    },
    costs: {
      grossEdgeBps: numberOrNull(row.gross_edge_bps),
      fundingEdgeBps: numberOrNull(row.funding_edge_bps),
      feeBps: numberOrNull(row.fee_bps),
      spreadBps: numberOrNull(row.spread_bps),
      slippageBps: numberOrNull(row.slippage_bps),
      impactBps: numberOrNull(row.impact_bps),
      latencyBufferBps: numberOrNull(row.latency_buffer_bps),
      uncertaintyBps: numberOrNull(row.uncertainty_bps),
      conservativeNetEdgeBps: numberOrNull(row.conservative_net_edge_bps),
      fundingCostBps: numberOrNull(row.funding_cost_bps),
      fundingEventCount: row.funding_event_count == null ? null : Number(row.funding_event_count)
    },
    schedulerDelayMs: row.scheduler_delay_ms == null ? null : Number(row.scheduler_delay_ms),
    pathMetrics: {
      maeBps: numberOrNull(row.mae_bps),
      mfeBps: numberOrNull(row.mfe_bps),
      markToMarketDrawdownBps: numberOrNull(row.mark_to_market_drawdown_bps)
    },
    validation: experimentValidation(row.experiment_id),
    status: row.status,
    pnlEligible: row.pnl_eligible === true,
    manualOnly: true
  };
}

export async function readSignals(limit) {
  if (!hasSupabaseConfig()) return { configured: false, rows: [] };
  const rows = await selectRows('hengyu_advisories', {
    select: ADVISORY_SELECT,
    order: 'signal_at.desc',
    limit
  });
  return { configured: true, rows: Array.isArray(rows) ? rows.map(publicSignal) : [] };
}

export async function readAlerts(limit) {
  if (!hasSupabaseConfig()) return { configured: false, rows: [] };
  const rows = await selectRows('hengyu_email_outbox', {
    select: 'outbox_id,advisory_id,alert_level,status,attempts,sent_at,created_at',
    order: 'created_at.desc',
    limit
  });
  return {
    configured: true,
    rows: Array.isArray(rows) ? rows.map(row => ({
      outboxId: row.outbox_id,
      advisoryId: row.advisory_id,
      alertLevel: row.alert_level,
      status: row.status,
      attempts: row.attempts,
      sentAt: row.sent_at,
      createdAt: row.created_at
    })) : []
  };
}

export function publicScanDiagnostic(row) {
  return {
    scanId: row.scan_id,
    scanKey: row.scan_key,
    serviceName: row.service_name,
    strategyId: row.strategy_id,
    experimentId: row.experiment_id,
    observedAt: row.observed_at,
    decisionTime: row.decision_at,
    signalTime: row.signal_time,
    theoreticalOpenAt: row.theoretical_open_at,
    schedulerDelayMs: row.scheduler_delay_ms == null ? null : Number(row.scheduler_delay_ms),
    status: row.status,
    regimePass: row.regime_pass,
    breadth: row.breadth == null ? null : Number(row.breadth),
    btcFastSma: numberOrNull(row.btc_fast_sma),
    btcSlowSma: numberOrNull(row.btc_slow_sma),
    candidateCount: Number(row.candidate_count ?? 0),
    signalCount: Number(row.signal_count ?? 0),
    missedCount: Number(row.missed_count ?? 0),
    reasons: Array.isArray(row.reasons) ? row.reasons : [],
    regime: row.regime ?? {},
    symbols: row.symbols ?? {},
    details: row.details ?? {},
    paperOnly: true
  };
}

export async function readScanDiagnostics(limit) {
  if (!hasSupabaseConfig()) return { configured: false, rows: [], error: null };
  try {
    const rows = await selectRows('hengyu_scan_diagnostics', {
      select: 'scan_id,scan_key,service_name,strategy_id,experiment_id,observed_at,decision_at,signal_time,theoretical_open_at,scheduler_delay_ms,status,regime_pass,breadth,btc_fast_sma,btc_slow_sma,candidate_count,signal_count,missed_count,reasons,regime,symbols,details',
      order: 'observed_at.desc',
      limit
    });
    return { configured: true, rows: Array.isArray(rows) ? rows.map(publicScanDiagnostic) : [], error: null };
  } catch (error) {
    return { configured: true, rows: [], error: error.message };
  }
}

export async function dashboard(limit) {
  const [signals, alerts, scans] = await Promise.all([readSignals(limit), readAlerts(limit), readScanDiagnostics(limit)]);
  const signalRows = signals.rows;
  const latestScan = scans.rows[0] ?? null;
  return {
    schemaVersion: 3,
    dataStatus: signals.configured && alerts.configured ? 'ok' : 'not_configured',
    ...{
      mode: 'SIGNAL_ONLY',
      authorization: 'PAPER_ONLY',
      liveOrdersEnabled: false,
      orderPlacementEnabled: false,
      humanConfirmationRequired: true,
      accountAccess: false
    },
    signals: signalRows,
    alerts: alerts.rows,
    scans: scans.rows,
    latestScan,
    diagnostics: {
      status: scans.error ? 'UNAVAILABLE' : latestScan ? 'AVAILABLE' : 'NO_SCAN_RECORDED',
      error: scans.error,
      latestReasons: latestScan?.reasons ?? [],
      latestStatus: latestScan?.status ?? null
    },
    experiments: {
      'HY-EXP-0018': experimentValidation('HY-EXP-0018')
    },
    counts: {
      signals: signalRows.length,
      alerts: alerts.rows.length,
      strong: signalRows.filter(row => row.alertLevel === 'STRONG').length,
      medium: signalRows.filter(row => row.alertLevel === 'MEDIUM').length,
      observe: signalRows.filter(row => row.alertLevel === 'OBSERVE').length,
      noTrade: signalRows.filter(row => row.action === 'NO_TRADE').length
    }
  };
}
