import { hasSupabaseConfig, selectRows } from './supabase.mjs';

const ADVISORY_SELECT = [
  'advisory_id', 'experiment_id', 'symbol', 'advisory_type', 'alert_level',
  'signal_at', 'expires_at', 'entry_reference', 'stop_reference', 'exit_reference',
  'gross_edge_bps', 'funding_edge_bps', 'fee_bps', 'slippage_bps', 'impact_bps',
  'latency_buffer_bps', 'uncertainty_bps', 'conservative_net_edge_bps',
  'status', 'pnl_eligible', 'created_at'
].join(',');

function numberOrNull(value) {
  return value == null ? null : Number(value);
}

export function publicSignal(row) {
  return {
    signalId: row.advisory_id,
    experimentId: row.experiment_id,
    generatedAt: row.signal_at,
    expiresAt: row.expires_at,
    alertLevel: row.alert_level,
    action: row.advisory_type,
    symbol: row.symbol,
    reference: {
      entryPrice: numberOrNull(row.entry_reference),
      stopPrice: numberOrNull(row.stop_reference),
      takeProfitPrice: numberOrNull(row.exit_reference),
      exitPrice: numberOrNull(row.exit_reference)
    },
    costs: {
      grossEdgeBps: numberOrNull(row.gross_edge_bps),
      fundingEdgeBps: numberOrNull(row.funding_edge_bps),
      feeBps: numberOrNull(row.fee_bps),
      slippageBps: numberOrNull(row.slippage_bps),
      impactBps: numberOrNull(row.impact_bps),
      latencyBufferBps: numberOrNull(row.latency_buffer_bps),
      uncertaintyBps: numberOrNull(row.uncertainty_bps),
      conservativeNetEdgeBps: numberOrNull(row.conservative_net_edge_bps)
    },
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

export async function dashboard(limit) {
  const [signals, alerts] = await Promise.all([readSignals(limit), readAlerts(limit)]);
  const signalRows = signals.rows;
  return {
    schemaVersion: 2,
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
