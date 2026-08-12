import { sendJson, methodAllowed } from './_lib/http.mjs';
import { dispatchPendingEmails } from './_lib/gmail.mjs';
import { insertRow } from './_lib/supabase.mjs';
import { ingestAdvisoryBundle } from './ingest.mjs';
import { detectLiveH12Signals, fetchLiveH12Series, h12AdvisoryBundle, H12_PRODUCTION_POLICY } from '../src/model/live-h12.mjs';

function authorized(request) {
  const expected = process.env.CRON_SECRET || process.env.HENGYU_CRON_SECRET || '';
  return Boolean(expected) && request.headers.authorization === `Bearer ${expected}`;
}

export default async function handler(request, response) {
  if (request.method !== 'GET') return methodAllowed(response, ['GET']);
  if (!authorized(request)) return sendJson(response, 401, { error: 'unauthorized' });
  const now = Date.now();
  try {
    const pairs = await Promise.all(H12_PRODUCTION_POLICY.symbols.map(async symbol => [
      symbol, await fetchLiveH12Series(symbol)
    ]));
    const signals = detectLiveH12Signals(Object.fromEntries(pairs), { now });
    const ingested = [];
    for (const signal of signals) {
      ingested.push(await ingestAdvisoryBundle(h12AdvisoryBundle(signal, { generatedAt: now }).record));
    }
    await insertRow('hengyu_system_heartbeats', {
      service_name: 'vercel-h12-worker',
      observed_at: new Date(now).toISOString(),
      status: 'HEALTHY',
      pnl_eligible: false,
      details: { hypothesisId: 'H12', region: process.env.VERCEL_REGION ?? null, signals: signals.length }
    });
    const emails = await dispatchPendingEmails(20);
    return sendJson(response, 200, {
      ok: true,
      strategy: 'H12',
      mode: 'SIGNAL_ONLY',
      authorization: 'PAPER_ONLY',
      scannedAt: new Date(now).toISOString(),
      signals: signals.map(signal => signal.signalId),
      ingested,
      emails
    });
  } catch (error) {
    return sendJson(response, 503, { error: 'h12_scan_failed', reason: error.message });
  }
}
