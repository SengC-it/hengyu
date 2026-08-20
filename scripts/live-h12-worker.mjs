import crypto from 'node:crypto';
import {
  evaluateLiveH12Scan,
  fetchLiveH12Market,
  fetchLiveH12Series,
  h12AdvisoryBundle,
  h12ScanDiagnosticRecord,
  normalizeH12Scheduler,
  H12_PRODUCTION_POLICY
} from '../src/model/live-h12.mjs';

const baseUrl = process.env.HENGYU_API_BASE_URL || 'https://hengyu-research.vercel.app';
const secret = process.env.HENGYU_INGEST_SECRET || '';
const dryRun = ['1', 'true', 'yes'].includes(String(process.env.HENGYU_WORKER_DRY_RUN || '').toLowerCase())
  || process.argv.includes('--dry-run');

function signedHeaders(body) {
  const timestamp = String(Date.now());
  return {
    'content-type': 'application/json',
    'x-hengyu-timestamp': timestamp,
    'x-hengyu-signature': crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  };
}

async function post(pathname, payload) {
  if (!secret) throw new Error('HENGYU_INGEST_SECRET is required');
  const body = JSON.stringify(payload);
  const response = await fetch(new URL(pathname, baseUrl), {
    method: 'POST', headers: signedHeaders(body), body, signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  let result;
  try { result = text ? JSON.parse(text) : {}; } catch { result = { raw: text }; }
  if (!response.ok) throw new Error(`${pathname}: HTTP ${response.status} ${JSON.stringify(result)}`);
  return result;
}

async function main() {
  const scanStartedAt = Date.now();
  const scheduler = normalizeH12Scheduler({
    source: process.env.HENGYU_SCHEDULER_SOURCE || 'github-actions-h12-worker',
    attempt: process.env.HENGYU_SCHEDULER_ATTEMPT || 1
  });
  const pairs = await Promise.all(H12_PRODUCTION_POLICY.symbols.map(async symbol => {
    const [series, market] = await Promise.all([
      fetchLiveH12Series(symbol),
      fetchLiveH12Market(symbol).catch(error => ({ error: error.message }))
    ]);
    return { symbol, series, market };
  }));
  const decisionTime = Date.now();
  const evaluated = evaluateLiveH12Scan(
    Object.fromEntries(pairs.map(row => [row.symbol, row.series])),
    {
      marketBySymbol: Object.fromEntries(pairs.map(row => [row.symbol, row.market])),
      now: decisionTime,
      scanStartedAt,
      schedulerSource: scheduler.source,
      schedulerAttempt: scheduler.attempt
    }
  );
  const signals = evaluated.signals;
  const output = {
    mode: dryRun ? 'DRY_RUN' : 'PAPER_ONLY_PRODUCTION',
    scannedAt: new Date(decisionTime).toISOString(),
    scanStatus: evaluated.status,
    diagnostics: evaluated.diagnostics,
    signals: []
  };
  if (!dryRun) {
    output.diagnostic = await post('/api/ingest', {
      kind: 'scan_diagnostic',
      record: h12ScanDiagnosticRecord(evaluated.diagnostics, { serviceName: 'github-actions-h12-worker' })
    });
  }
  for (const signal of signals) {
    const bundle = h12AdvisoryBundle(signal, { generatedAt: decisionTime });
    const result = dryRun ? { accepted: false, dryRun: true } : await post('/api/ingest', bundle);
    output.signals.push({ signalId: signal.signalId, symbol: signal.symbol, entryPrice: signal.entryPrice, stopPrice: signal.stopPrice, result });
  }
  if (!dryRun) {
    output.heartbeat = await post('/api/ingest', {
      kind: 'heartbeat',
      record: {
        service_name: 'github-actions-h12-worker',
        observed_at: new Date(decisionTime).toISOString(),
        status: 'HEALTHY',
        pnl_eligible: false,
        authorization_mode: 'PAPER_ONLY',
        live_orders_enabled: false,
        details: {
          hypothesisId: 'H12',
          symbols: H12_PRODUCTION_POLICY.symbols,
          signals: signals.length,
          schedulerSource: evaluated.diagnostics.schedulerSource,
          schedulerAttempt: evaluated.diagnostics.schedulerAttempt
        }
      }
    });
    output.emailDispatch = await post('/api/dispatch-email', { limit: 20 });
  }
  console.log(JSON.stringify(output, null, 2));
}

await main();
