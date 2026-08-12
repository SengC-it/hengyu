import crypto from 'node:crypto';
import { detectLiveH12Signals, h12AdvisoryBundle, H12_PRODUCTION_POLICY, normalizeFourHourKlines } from '../src/model/live-h12.mjs';

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

async function fetchSeries(symbol) {
  const bases = [
    'https://fapi.binance.com',
    'https://fapi1.binance.com',
    'https://fapi2.binance.com',
    'https://fapi3.binance.com',
    'https://fapi4.binance.com'
  ];
  const failures = [];
  for (const base of bases) {
    const url = new URL('/fapi/v1/klines', base);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', '4h');
    url.searchParams.set('limit', '220');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (response.ok) return normalizeFourHourKlines(symbol, await response.json());
      failures.push(`${url.hostname}:${response.status}`);
    } catch (error) {
      failures.push(`${url.hostname}:${error.cause?.code ?? error.name}`);
    }
  }
  throw new Error(`${symbol}: Binance futures endpoints unavailable (${failures.join(', ')})`);
}

async function main() {
  const now = Date.now();
  const pairs = await Promise.all(H12_PRODUCTION_POLICY.symbols.map(async symbol => [symbol, await fetchSeries(symbol)]));
  const signals = detectLiveH12Signals(Object.fromEntries(pairs), { now });
  const output = { mode: dryRun ? 'DRY_RUN' : 'PAPER_ONLY_PRODUCTION', scannedAt: new Date(now).toISOString(), signals: [] };
  for (const signal of signals) {
    const bundle = h12AdvisoryBundle(signal, { generatedAt: now });
    const result = dryRun ? { accepted: false, dryRun: true } : await post('/api/ingest', bundle);
    output.signals.push({ signalId: signal.signalId, symbol: signal.symbol, entryPrice: signal.entryPrice, stopPrice: signal.stopPrice, result });
  }
  if (!dryRun) {
    output.heartbeat = await post('/api/ingest', {
      kind: 'heartbeat',
      record: {
        service_name: 'github-actions-h12-worker',
        observed_at: new Date(now).toISOString(),
        status: 'HEALTHY',
        pnl_eligible: false,
        authorization_mode: 'PAPER_ONLY',
        live_orders_enabled: false,
        details: { hypothesisId: 'H12', symbols: H12_PRODUCTION_POLICY.symbols, signals: signals.length }
      }
    });
    output.emailDispatch = await post('/api/dispatch-email', { limit: 20 });
  }
  console.log(JSON.stringify(output, null, 2));
}

await main();
