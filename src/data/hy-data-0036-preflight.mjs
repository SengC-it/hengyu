import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HY_DATA_0036_SYMBOLS } from './hy-data-0036-contract.mjs';
import { createBinancePublicRestGovernor } from './hy-data-0036-rest.mjs';
import { readHostNtpEvidence } from './hy-data-0036-clock.mjs';

const PUBLIC_ENDPOINT = 'wss://fstream.binance.com/public/stream';
const MARKET_ENDPOINT = 'wss://fstream.binance.com/market/stream';

function addWsListener(socket, event, handler) {
  if (typeof socket.addEventListener === 'function') socket.addEventListener(event, handler);
  else socket[`on${event}`] = handler;
}

function websocketPreflight({ endpoint, params, webSocketFactory, timeoutMs = 10_000, now = () => Date.now() }) {
  return new Promise(resolve => {
    let socket;
    let settled = false;
    const startedAt = now();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { socket?.close?.(1000, 'ENGINEERING_PREFLIGHT_COMPLETE'); } catch { /* preflight close is best effort */ }
      resolve(Object.freeze({ endpoint, ...result, elapsedMs: now() - startedAt }));
    };
    const timeout = setTimeout(() => finish({ ok: false, reason: 'WS_SUBSCRIPTION_TIMEOUT' }), timeoutMs);
    try {
      socket = webSocketFactory(endpoint);
      addWsListener(socket, 'open', () => {
        try {
          socket.send(JSON.stringify({ method: 'SUBSCRIBE', params, id: 1 }));
        } catch {
          finish({ ok: false, reason: 'WS_SUBSCRIBE_SEND_FAILED' });
        }
      });
      addWsListener(socket, 'message', event => {
        try {
          const value = typeof (event?.data ?? event) === 'string' ? JSON.parse(event.data ?? event) : (event.data ?? event);
          if (value && value.result === null && value.id === 1) finish({ ok: true, subscriptionConfirmed: true });
        } catch {
          finish({ ok: false, reason: 'WS_INVALID_CONTROL_RESPONSE' });
        }
      });
      addWsListener(socket, 'error', () => finish({ ok: false, reason: 'WS_ERROR' }));
      addWsListener(socket, 'close', () => finish({ ok: false, reason: 'WS_CLOSED_BEFORE_CONFIRMATION' }));
    } catch {
      finish({ ok: false, reason: 'WS_CONNECT_FAILED' });
    }
  });
}

async function localSpoolEvidence(rootDir, minimumBytes) {
  let availableBytes = null;
  try {
    await fs.mkdir(rootDir, { recursive: true });
    if (typeof fs.statfs === 'function') {
      const stat = await fs.statfs(rootDir);
      availableBytes = Number(stat.bavail) * Number(stat.bsize);
    }
  } catch { availableBytes = null; }
  const required = minimumBytes == null ? null : Number(minimumBytes);
  return Object.freeze({
    rootDir: path.resolve(rootDir),
    availableBytes,
    requiredBytes: Number.isFinite(required) ? required : null,
    sufficient: Number.isFinite(required) && availableBytes !== null && availableBytes >= required
  });
}

/**
 * Performs only engineering checks. A non-PASS result is a hard firewall for
 * the 60-minute canary; it never starts a collector or writes research data.
 */
export async function runEngineeringPreflight({
  fetchImpl = globalThis.fetch,
  restGovernor = null,
  hostNtpEvidenceImpl = readHostNtpEvidence,
  webSocketFactory = url => new WebSocket(url),
  rootDir = path.join(os.tmpdir(), 'engineering', 'hy-data-0036', 'preflight'),
  remoteStorage = null,
  minimumLocalSpoolBytes = null,
  now = () => Date.now(),
  wsTimeoutMs = 10_000
} = {}) {
  const governor = restGovernor ?? createBinancePublicRestGovernor({ fetchImpl, now });
  const checks = {};
  const failures = [];
  const rateStateBefore = governor.state();
  const rateLimitBlocked = rateStateBefore.status === 'IP_RATE_LIMIT_BANNED';
  let timeResponse = null;
  if (rateStateBefore.blocked) {
    checks.binanceRest = Object.freeze({ ok: false, status: rateStateBefore.status, reason: 'RATE_LIMIT_COOLDOWN_ACTIVE' });
    failures.push(rateStateBefore.status);
  } else {
    try {
      timeResponse = await governor.request('https://fapi.binance.com/fapi/v1/time', { method: 'GET', headers: { accept: 'application/json' } });
      checks.binanceRest = Object.freeze({ ok: timeResponse.response.ok, status: timeResponse.response.status, reason: timeResponse.response.ok ? null : `HTTP_${timeResponse.response.status}` });
      if (!timeResponse.response.ok) failures.push(`BINANCE_REST_HTTP_${timeResponse.response.status}`);
    } catch (error) {
      checks.binanceRest = Object.freeze({ ok: false, status: error.code ?? 'ERROR', reason: error.code ?? 'REST_PREFLIGHT_FAILED' });
      failures.push(error.code ?? 'REST_PREFLIGHT_FAILED');
    }
  }

  let clock;
  try { clock = await hostNtpEvidenceImpl({ now }); } catch { clock = { status: 'CLOCK_UNTRUSTED', clockSource: 'HOST_NTP_EVIDENCE', synchronized: false, offsetMs: null, evidenceMethod: 'CHECK_FAILED' }; }
  checks.hostClock = Object.freeze(clock);
  if (clock.status !== 'CLOCK_TRUSTED') failures.push('CLOCK_UNTRUSTED');

  checks.localSpool = await localSpoolEvidence(rootDir, minimumLocalSpoolBytes);
  if (!checks.localSpool.sufficient) failures.push('LOCAL_SPOOL_CAPACITY_NOT_CONFIGURED_OR_INSUFFICIENT');

  checks.remoteStorage = Object.freeze({
    configured: remoteStorage?.configured === true,
    verified: remoteStorage?.verified === true,
    providerNeutral: true,
    reason: remoteStorage?.configured === true ? null : 'STORAGE_BACKEND_NOT_CONFIGURED'
  });
  if (!checks.remoteStorage.configured) failures.push('STORAGE_BACKEND_NOT_CONFIGURED');

  const publicWs = await websocketPreflight({
    endpoint: PUBLIC_ENDPOINT,
    params: [`${HY_DATA_0036_SYMBOLS[0].toLowerCase()}@bookTicker`],
    webSocketFactory,
    timeoutMs: wsTimeoutMs,
    now
  });
  const marketWs = await websocketPreflight({
    endpoint: MARKET_ENDPOINT,
    params: [`${HY_DATA_0036_SYMBOLS[0].toLowerCase()}@aggTrade`],
    webSocketFactory,
    timeoutMs: wsTimeoutMs,
    now
  });
  checks.publicWebSocket = publicWs;
  checks.marketWebSocket = marketWs;
  if (!publicWs.ok) failures.push('PUBLIC_WS_PREFLIGHT_FAILED');
  if (!marketWs.ok) failures.push('MARKET_WS_PREFLIGHT_FAILED');

  const rest = governor.diagnostics;
  const status = failures.length ? (rateLimitBlocked || rest.http418Count > 0 ? 'PREFLIGHT_RATE_LIMIT_BLOCKED' : 'PREFLIGHT_FAIL') : 'PREFLIGHT_PASS';
  return Object.freeze({
    schemaVersion: 1,
    artifactType: 'HY_DATA_0036_ENGINEERING_PREFLIGHT',
    datasetId: 'HY-DATA-0036',
    mode: 'ENGINEERING_DRY_RUN',
    checkedAt: new Date(now()).toISOString(),
    status,
    failures: Object.freeze([...new Set(failures)]),
    checks,
    rest: Object.freeze({ ...rest, responseLog: governor.responseLog() }),
    safety: Object.freeze({ publicMarketDataOnly: true, privateStream: false, accountApi: false, orderApi: false, scheduler: false, gmail: false, paperOnly: true, signalOnly: true, pnlComputed: false, researchEligible: false, formalCollectionActivated: false }),
    canaryAllowed: status === 'PREFLIGHT_PASS'
  });
}
