import { sendJson, methodAllowed } from './_lib/http.mjs';
import { dispatchPendingEmails, gmailStatus } from './_lib/gmail.mjs';
import { insertRow } from './_lib/supabase.mjs';
import { verifyGitHubActionsOidc } from './_lib/github-oidc.mjs';
import { ingestAdvisoryBundle } from './ingest.mjs';
import {
  evaluateLiveH12Scan,
  fetchLiveH12Market,
  fetchLiveH12Series,
  h12AdvisoryBundle,
  h12ScanDiagnosticRecord,
  normalizeH12Scheduler,
  H12_PRODUCTION_POLICY
} from '../src/model/live-h12.mjs';

async function authorized(request) {
  const expected = process.env.CRON_SECRET || process.env.HENGYU_CRON_SECRET || '';
  const authorization = request.headers.authorization ?? '';
  if (expected && authorization === `Bearer ${expected}`) return true;
  if (!authorization.startsWith('Bearer ')) return false;
  return verifyGitHubActionsOidc(authorization.slice('Bearer '.length));
}

export default async function handler(request, response) {
  if (request.method !== 'GET') return methodAllowed(response, ['GET']);
  if (!await authorized(request)) return sendJson(response, 401, { error: 'unauthorized' });
  const scanStartedAt = Date.now();
  try {
    const requestUrl = new URL(request.url ?? '/api/h12-scan', 'https://hengyu.local');
    const scheduler = normalizeH12Scheduler({
      source: requestUrl.searchParams.get('scheduler_source') ?? 'vercel-h12-scan',
      attempt: requestUrl.searchParams.get('scheduler_attempt') ?? 1
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
    const diagnostics = evaluated.diagnostics;
    await insertRow('hengyu_scan_diagnostics', h12ScanDiagnosticRecord(diagnostics), { onConflict: 'scan_key' });
    const ingested = [];
    for (const signal of signals) {
      ingested.push(await ingestAdvisoryBundle(h12AdvisoryBundle(signal, { generatedAt: decisionTime }).record));
    }
    let emails = { status: 'SKIPPED', reason: 'gmail_not_configured', dispatched: [] };
    if (gmailStatus().configured) {
      try {
        emails = { status: 'DISPATCHED', dispatched: await dispatchPendingEmails(20) };
      } catch (error) {
        emails = { status: 'FAILED', reason: 'gmail_dispatch_failed', dispatched: [] };
      }
    }
    await insertRow('hengyu_system_heartbeats', {
      service_name: 'vercel-h12-worker',
      observed_at: new Date(decisionTime).toISOString(),
      status: emails.status === 'FAILED' ? 'DEGRADED' : 'HEALTHY',
      pnl_eligible: false,
       details: {
         hypothesisId: 'H12',
         region: process.env.VERCEL_REGION ?? null,
         signals: signals.length,
         scanStatus: diagnostics.status,
         noSignalReasons: diagnostics.reasons,
         schedulerDelayMs: diagnostics.schedulerDelayMs,
         schedulerSource: diagnostics.schedulerSource,
         schedulerAttempt: diagnostics.schedulerAttempt,
         emailDispatch: emails.status
       }
    });
    return sendJson(response, 200, {
      ok: true,
      strategy: 'H12',
      mode: 'SIGNAL_ONLY',
      authorization: 'PAPER_ONLY',
      scannedAt: new Date(decisionTime).toISOString(),
      scanStatus: diagnostics.status,
      diagnostics,
      signals: signals.map(signal => signal.signalId),
      ingested,
      emails
    });
  } catch (error) {
    return sendJson(response, 503, { error: 'h12_scan_failed', reason: error.message });
  }
}
