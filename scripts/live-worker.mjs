import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeAggTrade, normalizeForceOrder } from '../src/model/forward-data.mjs';
import { buildH9AdvisorySignal } from '../src/model/advisory-signal.mjs';
import { LiveH9Scanner, liveH9Policy } from '../src/model/live-h9.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'live-worker.json');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] == null) process.env[match[1]] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env.live.local'));

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function bool(value, fallback = false) {
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function integer(name, value, { minimum = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid ${name}`);
  return parsed;
}

function finite(name, value, { minimum = -Infinity, exclusiveMinimum = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (exclusiveMinimum ? parsed <= minimum : parsed < minimum)) {
    throw new Error(`invalid ${name}`);
  }
  return parsed;
}

function symbolsFrom(value) {
  const symbols = String(value ?? '').split(',').map(symbol => symbol.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length || symbols.some(symbol => !/^[A-Z0-9]+$/.test(symbol))) {
    throw new Error('symbols must be a comma-separated list of letters and digits');
  }
  return [...new Set(symbols)].sort();
}

function resolveRootFile(value) {
  return path.resolve(ROOT, value);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ensureDirectory(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function saveJson(file, value) {
  ensureDirectory(file);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonLine(file, value) {
  ensureDirectory(file);
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function delayOrStop(milliseconds, controller) {
  return Promise.race([delay(milliseconds), controller.promise]);
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

function log(level, message, details = null) {
  const suffix = details == null ? '' : ` ${JSON.stringify(details)}`;
  console.log(`[${new Date().toISOString()}] [${level}] ${message}${suffix}`);
}

function parseResponseBody(text) {
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
}

function signedBody(secret, body) {
  const timestamp = String(Date.now());
  const signature = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return { timestamp, signature };
}

async function postSigned({ baseUrl, secret, pathname, payload }) {
  const body = JSON.stringify(payload);
  const { timestamp, signature } = signedBody(secret, body);
  const url = new URL(pathname, baseUrl);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hengyu-timestamp': timestamp,
      'x-hengyu-signature': signature
    },
    body,
    signal: AbortSignal.timeout(20_000)
  });
  const text = await response.text();
  const result = parseResponseBody(text);
  if (!response.ok) {
    const error = new Error(`${pathname}_http_${response.status}`);
    error.status = response.status;
    error.payload = result;
    throw error;
  }
  return result;
}

class PendingQueue {
  constructor(file) {
    this.file = file;
  }

  read() {
    if (!fs.existsSync(this.file)) return [];
    const text = fs.readFileSync(this.file, 'utf8').trim();
    if (!text) return [];
    return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  }

  hasItems() {
    return this.read().length > 0;
  }

  enqueue(payload) {
    appendJsonLine(this.file, payload);
  }

  replace(rows) {
    ensureDirectory(this.file);
    if (!rows.length) {
      if (fs.existsSync(this.file)) fs.writeFileSync(this.file, '', 'utf8');
      return;
    }
    fs.writeFileSync(this.file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  }

  async flush(send) {
    const rows = this.read();
    const remaining = [];
    let sent = 0;
    for (const row of rows) {
      try {
        await send(row);
        sent++;
      } catch (error) {
        if (error.status >= 400 && error.status < 500) {
          log('ERROR', 'dropped invalid pending advisory', { status: error.status });
          continue;
        }
        remaining.push(row);
        log('WARN', 'pending advisory will be retried', { reason: error.message });
      }
    }
    this.replace(remaining);
    return { sent, remaining: remaining.length };
  }
}

async function fetchDepthSnapshot(symbol, signal = undefined) {
  const url = `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=1000`;
  const requestSignal = signal
    ? AbortSignal.any([AbortSignal.timeout(15_000), signal])
    : AbortSignal.timeout(15_000);
  const response = await fetch(url, { signal: requestSignal });
  if (!response.ok) throw new Error(`depth snapshot ${symbol}: HTTP ${response.status}`);
  const payload = await response.json();
  if (!Number.isSafeInteger(Number(payload.lastUpdateId))) throw new Error(`depth snapshot ${symbol}: invalid update id`);
  return { symbol, payload };
}

function applyLevels(map, levels) {
  for (const level of levels ?? []) {
    const price = Number(level[0]);
    const quantity = Number(level[1]);
    if (!(price > 0) || !Number.isFinite(quantity) || quantity < 0) throw new Error('invalid depth level');
    const key = String(price);
    if (quantity === 0) map.delete(key);
    else map.set(key, quantity);
  }
}

function sortedLevels(map, side, limit = 50) {
  return [...map.entries()]
    .map(([price, quantity]) => [Number(price), quantity])
    .filter(([price, quantity]) => price > 0 && quantity > 0)
    .sort((left, right) => side === 'bids' ? right[0] - left[0] : left[0] - right[0])
    .slice(0, limit);
}

class DepthBookManager {
  constructor({ symbols, onBook, signal }) {
    this.onBook = onBook;
    this.signal = signal;
    this.states = new Map(symbols.map(symbol => [symbol, {
      symbol,
      aligned: false,
      aligning: false,
      generation: 0,
      buffer: [],
      bids: new Map(),
      asks: new Map(),
      lastUpdateId: null,
      sequenceGaps: 0,
      lastError: null,
      lastBookAt: null
    }]));
  }

  resetAll() {
    for (const state of this.states.values()) {
      state.generation++;
      state.aligned = false;
      state.buffer = [];
      state.bids = new Map();
      state.asks = new Map();
      state.lastUpdateId = null;
    }
  }

  handleMessage(symbol, row) {
    const state = this.states.get(symbol);
    if (!state) return;
    state.buffer.push(row);
    if (state.buffer.length > 20_000) state.buffer.splice(0, state.buffer.length - 20_000);
    if (state.aligned) {
      const current = state.buffer.shift();
      if (!this.applyLive(state, current)) {
        state.sequenceGaps++;
        state.lastError = 'depth_sequence_gap';
        state.aligned = false;
        state.buffer = [current];
        void this.align(state);
      }
      return;
    }
    void this.align(state);
  }

  applyDelta(state, row) {
    applyLevels(state.bids, row.data.b ?? []);
    applyLevels(state.asks, row.data.a ?? []);
    state.lastUpdateId = Number(row.data.u);
    state.lastBookAt = row.receivedAt;
    const bids = sortedLevels(state.bids, 'bids');
    const asks = sortedLevels(state.asks, 'asks');
    if (!bids.length || !asks.length || bids[0][0] >= asks[0][0]) throw new Error('depth book is crossed or empty');
    this.onBook({
      symbol: state.symbol,
      eventTime: Number(row.data.E ?? row.data.T),
      receivedAt: row.receivedAt,
      updateId: state.lastUpdateId,
      bids,
      asks
    });
  }

  applyLive(state, row) {
    const firstUpdate = Number(row.data.U);
    const lastUpdate = Number(row.data.u);
    const previous = Number(row.data.pu);
    if (!(firstUpdate <= lastUpdate) || !Number.isSafeInteger(previous)) return false;
    if (lastUpdate <= state.lastUpdateId) return true;
    if (previous !== state.lastUpdateId) return false;
    try {
      this.applyDelta(state, row);
      return true;
    } catch (error) {
      state.lastError = error.message;
      return false;
    }
  }

  async align(state) {
    if (state.aligning) return;
    state.aligning = true;
    const generation = state.generation;
    const deadline = Date.now() + 30_000;
    try {
      while (Date.now() < deadline && generation === state.generation && !state.aligned) {
        const snapshot = await fetchDepthSnapshot(state.symbol, this.signal);
        if (generation !== state.generation) return;
        const snapshotId = Number(snapshot.payload.lastUpdateId);
        const index = state.buffer.findIndex(row => {
          const firstUpdate = Number(row.data.U);
          const lastUpdate = Number(row.data.u);
          return firstUpdate <= snapshotId && snapshotId <= lastUpdate;
        });
        if (index < 0) {
          await delay(250);
          continue;
        }
        const queued = state.buffer.splice(0).sort((left, right) => left.receivedAt - right.receivedAt);
        state.bids = new Map((snapshot.payload.bids ?? []).map(level => [String(Number(level[0])), Number(level[1])]));
        state.asks = new Map((snapshot.payload.asks ?? []).map(level => [String(Number(level[0])), Number(level[1])]));
        state.lastUpdateId = snapshotId;
        try {
          for (let cursor = index; cursor < queued.length; cursor++) {
            const row = queued[cursor];
            if (Number(row.data.u) <= state.lastUpdateId) continue;
            if (cursor !== index && Number(row.data.pu) !== state.lastUpdateId) {
              throw new Error('depth_sequence_gap_during_alignment');
            }
            this.applyDelta(state, row);
          }
        } catch (error) {
          state.sequenceGaps++;
          state.lastError = error.message;
          state.buffer = [];
          await delay(250);
          continue;
        }
        state.aligned = true;
        state.lastError = null;
      }
    } catch (error) {
      state.lastError = error.message;
    } finally {
      state.aligning = false;
    }
  }

  status() {
    const rows = [...this.states.values()];
    return {
      alignedSymbols: rows.filter(row => row.aligned).map(row => row.symbol),
      sequenceGaps: rows.reduce((total, row) => total + row.sequenceGaps, 0),
      lastBookAt: rows.reduce((latest, row) => Math.max(latest, row.lastBookAt ?? 0), 0) || null,
      errors: rows.filter(row => row.lastError).map(row => ({ symbol: row.symbol, error: row.lastError }))
    };
  }
}

function streamUrl(endpoint, streams) {
  return `wss://fstream.binance.com/${endpoint}/stream?streams=${streams.join('/')}`;
}

function streamNames(symbols, suffixes) {
  return symbols.flatMap(symbol => suffixes.map(suffix => `${symbol.toLowerCase()}@${suffix}`));
}

function createStopController() {
  let resolve;
  const abortController = new AbortController();
  const controller = {
    stopped: false,
    sockets: new Set(),
    signal: abortController.signal,
    promise: new Promise(done => { resolve = done; }),
    request(reason = 'stop requested') {
      if (controller.stopped) return;
      controller.stopped = true;
      controller.reason = reason;
      abortController.abort();
      for (const socket of controller.sockets) {
        try { socket.close(1000, reason); } catch { /* already closed */ }
      }
      resolve();
    }
  };
  return controller;
}

async function streamLoop({ label, url, controller, onOpen, onMessage }) {
  let backoff = 1_000;
  while (!controller.stopped) {
    let socket = null;
    let opened = false;
    const connection = new Promise(resolve => {
      let settled = false;
      const settle = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        socket = new WebSocket(url);
        controller.sockets.add(socket);
        socket.addEventListener('open', () => {
          opened = true;
          backoff = 1_000;
          log('INFO', `${label} connected`);
          try { onOpen?.(); } catch (error) { log('ERROR', `${label} open handler failed`, { reason: error.message }); }
        });
        socket.addEventListener('message', event => {
          try {
            const payload = JSON.parse(String(event.data));
            onMessage(payload);
          } catch (error) {
            log('WARN', `${label} message ignored`, { reason: error.message });
          }
        });
        socket.addEventListener('error', () => settle(new Error(`${label} websocket error`)));
        socket.addEventListener('close', event => {
          if (controller.stopped) settle(null);
          else settle(new Error(`${label} websocket closed ${event.code}`));
        });
      } catch (error) {
        settle(error);
      }
    });
    const reason = await Promise.race([connection, controller.promise.then(() => null)]);
    if (socket) controller.sockets.delete(socket);
    if (controller.stopped) break;
    if (reason) log('WARN', `${label} disconnected; reconnecting`, { reason: reason.message, opened });
    await delayOrStop(backoff, controller);
    backoff = Math.min(backoff * 2, 30_000);
  }
}

async function fundingLoop({ symbols, controller, metrics, intervalSeconds }) {
  const intervalMs = intervalSeconds * 1_000;
  while (!controller.stopped) {
    const results = await Promise.allSettled(symbols.map(async symbol => {
      const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`;
      const response = await fetch(url, {
        signal: AbortSignal.any([AbortSignal.timeout(15_000), controller.signal])
      });
      if (!response.ok) throw new Error(`funding ${symbol}: HTTP ${response.status}`);
      const rows = await response.json();
      if (!Array.isArray(rows) || !rows.length) throw new Error(`funding ${symbol}: empty response`);
      return rows.at(-1);
    }));
    for (const result of results) {
      if (result.status === 'fulfilled') metrics.fundingRows++;
      else metrics.fundingErrors++;
    }
    await delayOrStop(intervalMs, controller);
  }
}

function advisoryBundle(signal, event, scanner) {
  const bid = Number(event.decisionBook?.bids?.[0]?.[0]);
  const ask = Number(event.decisionBook?.asks?.[0]?.[0]);
  return {
    kind: 'advisory_bundle',
    record: {
      advisory: {
        advisory_id: crypto.randomUUID(),
        experiment_id: signal.experimentId,
        symbol: signal.symbol,
        advisory_type: signal.action,
        alert_level: signal.alertLevel,
        signal_at: iso(signal.signalTime),
        expires_at: iso(signal.expiresAt),
        reference_bid: Number.isFinite(bid) ? bid : null,
        reference_ask: Number.isFinite(ask) ? ask : null,
        entry_reference: signal.reference.entryPrice,
        stop_reference: signal.reference.stopPrice,
        exit_reference: signal.reference.takeProfitPrice,
        status: 'ACTIVE',
        pnl_eligible: true,
        authorization_mode: 'PAPER_ONLY',
        live_orders_enabled: false,
        dedupe_key: signal.delivery.dedupeKey,
        metadata: {
          source: 'local-live-worker',
          modelId: 'HENGYU-H9-LIVE-001',
          hypothesisId: signal.hypothesisId,
          targetRule: event.targetRule,
          takeProfitImpulseMultiplier: scanner.policy.takeProfitImpulseMultiplier,
          pressure: event.pressure,
          threshold: event.threshold,
          recoveryRatio: event.recoveryRatio,
          eventImpulseBps: signal.reference.eventImpulseBps,
          reviewRule: 'ENTRY_FIXED_TP_SL_FIRST_TOUCH_NO_TIME_EXIT',
          reasons: ['H9_FORCE_PRESSURE_RECOVERY']
        }
      },
      email: { requested: true }
    }
  };
}

function settings() {
  const config = readJson(CONFIG_FILE, {});
  const dryRun = hasFlag('dry-run') || bool(process.env.HENGYU_WORKER_DRY_RUN);
  const symbols = symbolsFrom(flag('symbols', process.env.HENGYU_WORKER_SYMBOLS || config.symbols?.join(',')));
  const apiBaseUrl = flag('api-base-url', process.env.HENGYU_API_BASE_URL || '');
  const secret = process.env.HENGYU_INGEST_SECRET || '';
  if (!dryRun && (!apiBaseUrl || !secret || secret.includes('replace-with-'))) {
    throw new Error('missing HENGYU_API_BASE_URL or HENGYU_INGEST_SECRET in .env.live.local');
  }
  const evaluationIntervalSeconds = integer(
    'evaluationIntervalSeconds',
    flag('evaluation-seconds', process.env.HENGYU_WORKER_EVALUATION_SECONDS || config.evaluationIntervalSeconds || 60),
    { minimum: 5 }
  );
  const heartbeatIntervalSeconds = integer(
    'heartbeatIntervalSeconds',
    process.env.HENGYU_WORKER_HEARTBEAT_SECONDS || config.heartbeatIntervalSeconds || 60,
    { minimum: 10 }
  );
  const takeProfitImpulseMultiplier = finite(
    'takeProfitImpulseMultiplier',
    process.env.HENGYU_WORKER_TP_MULTIPLIER || config.takeProfitImpulseMultiplier || 1,
    { minimum: 0, exclusiveMinimum: true }
  );
  const alertLevel = String(process.env.HENGYU_WORKER_ALERT_LEVEL || config.alertLevel || 'MEDIUM').toUpperCase();
  if (!['STRONG', 'MEDIUM', 'OBSERVE', 'NONE'].includes(alertLevel)) throw new Error('invalid HENGYU_WORKER_ALERT_LEVEL');
  return {
    config,
    symbols,
    dryRun,
    apiBaseUrl: apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`,
    secret,
    evaluationIntervalSeconds,
    heartbeatIntervalSeconds,
    takeProfitImpulseMultiplier,
    alertLevel,
    stateFile: resolveRootFile(flag('state-file', process.env.HENGYU_WORKER_STATE_FILE || config.stateFile || 'data/live/state.json')),
    pendingFile: resolveRootFile(flag('pending-file', process.env.HENGYU_WORKER_PENDING_FILE || config.pendingFile || 'data/live/pending-advisories.ndjson')),
    durationSeconds: flag('seconds') == null ? null : integer('seconds', flag('seconds'), { minimum: 1 }),
    fundingPollSeconds: integer('fundingPollSeconds', config.fundingPollSeconds || 60, { minimum: 10 })
  };
}

async function main() {
  const config = settings();
  log('INFO', 'starting Hengyu local live worker', {
    symbols: config.symbols,
    dryRun: config.dryRun,
    apiBaseUrl: config.dryRun ? null : config.apiBaseUrl,
    rule: 'ENTRY_FIXED_TP_SL_FIRST_TOUCH_NO_TIME_EXIT',
    takeProfitRule: `eventImpulse*${config.takeProfitImpulseMultiplier}`
  });
  const previousState = readJson(config.stateFile, null);
  const scanner = new LiveH9Scanner({
    symbols: config.symbols,
    state: previousState,
    policy: liveH9Policy({
      takeProfitImpulseMultiplier: config.takeProfitImpulseMultiplier,
      alertLevel: config.alertLevel
    })
  });
  const metrics = {
    marketMessages: 0,
    trades: 0,
    forceOrders: 0,
    markPrices: 0,
    fundingRows: 0,
    fundingErrors: 0,
    submissions: 0,
    submissionErrors: 0,
    heartbeats: 0
  };
  const controller = createStopController();
  const queue = new PendingQueue(config.pendingFile);
  const depth = new DepthBookManager({
    symbols: config.symbols,
    signal: controller.signal,
    onBook: row => {
      try { scanner.recordBook(row); } catch (error) { log('WARN', 'book ignored', { reason: error.message }); }
    }
  });
  const sendPayload = async payload => {
    if (config.dryRun) {
      log('INFO', 'dry-run advisory accepted locally', {
        dedupeKey: payload.record.advisory.dedupe_key,
        symbol: payload.record.advisory.symbol,
        alertLevel: payload.record.advisory.alert_level
      });
      return { accepted: true, dryRun: true };
    }
    const result = await postSigned({
      baseUrl: config.apiBaseUrl,
      secret: config.secret,
      pathname: '/api/ingest',
      payload
    });
    metrics.submissions++;
    if (result.email?.queued) {
      try {
        const dispatch = await postSigned({
          baseUrl: config.apiBaseUrl,
          secret: config.secret,
          pathname: '/api/dispatch-email',
          payload: { limit: 10 }
        });
        log('INFO', 'email outbox dispatched', { result: dispatch.result ?? [] });
      } catch (error) {
        log('WARN', 'email dispatch deferred; outbox remains pending', { reason: error.message });
      }
    } else if (result.email?.requested && !result.email?.configured) {
      log('WARN', 'advisory stored but Gmail address env is not configured on Vercel');
      const error = new Error('gmail_address_env_not_configured');
      error.status = 503;
      throw error;
    }
    return result;
  };
  const submitEvent = async event => {
    try {
      const signal = buildH9AdvisorySignal({
        event,
        policy: scanner.policy,
        generatedAt: event.decisionReceivedAt
      });
      const payload = advisoryBundle(signal, event, scanner);
      if (!config.dryRun) queue.enqueue(payload);
      await queue.flush(sendPayload);
      log('INFO', 'H9 advisory evaluated', {
        signalId: signal.signalId,
        symbol: signal.symbol,
        side: signal.side,
        alertLevel: signal.alertLevel,
        entry: signal.reference.entryPrice,
        stop: signal.reference.stopPrice,
        takeProfit: signal.reference.takeProfitPrice
      });
    } catch (error) {
      metrics.submissionErrors++;
      log('ERROR', 'H9 advisory submission failed', { reason: error.message });
    }
  };
  const sendHeartbeat = async now => {
    const depthStatus = depth.status();
    const status = depthStatus.alignedSymbols.length === config.symbols.length ? 'HEALTHY' : 'DEGRADED';
    const payload = {
      kind: 'heartbeat',
      record: {
        service_name: 'hengyu-local-live-worker',
        observed_at: iso(now),
        status,
        last_capture_at: iso(scanner.lastDataAt),
        pnl_eligible: false,
        details: {
          symbols: config.symbols,
          alignedSymbols: depthStatus.alignedSymbols,
          sequenceGaps: depthStatus.sequenceGaps,
          scanner: scanner.status(),
          metrics
        }
      }
    };
    if (config.dryRun) {
      log('INFO', 'dry-run heartbeat', { status, alignedSymbols: depthStatus.alignedSymbols });
      return;
    }
    try {
      await postSigned({ baseUrl: config.apiBaseUrl, secret: config.secret, pathname: '/api/ingest', payload });
      metrics.heartbeats++;
    } catch (error) {
      log('WARN', 'heartbeat failed', { reason: error.message });
    }
  };
  const onMarketMessage = payload => {
    const data = payload.data ?? payload;
    const stream = String(payload.stream ?? '');
    const symbol = String(data.s ?? stream.split('@', 1)[0]).toUpperCase();
    const receivedAt = Date.now();
    metrics.marketMessages++;
    try {
      if (data.e === 'aggTrade') {
        scanner.recordTrade({ ...normalizeAggTrade({ ...data, s: symbol }), receivedAt });
        metrics.trades++;
      } else if (data.e === 'forceOrder') {
        scanner.recordForceOrder({ ...normalizeForceOrder({ ...data, s: symbol }), receivedAt });
        metrics.forceOrders++;
      } else if (data.e === 'markPriceUpdate') {
        metrics.markPrices++;
      }
    } catch (error) {
      log('WARN', 'market event ignored', { type: data.e, symbol, reason: error.message });
    }
  };
  const onPublicMessage = payload => {
    const data = payload.data ?? payload;
    if (data.e !== 'depthUpdate') return;
    const stream = String(payload.stream ?? '');
    const symbol = String(data.s ?? stream.split('@', 1)[0]).toUpperCase();
    depth.handleMessage(symbol, { receivedAt: Date.now(), data });
  };
  const publicStreams = streamNames(config.symbols, ['depth@100ms']);
  const marketStreams = streamNames(config.symbols, ['aggTrade', 'forceOrder', 'markPrice@1s']);
  const loops = [
    streamLoop({
      label: 'public depth stream',
      url: streamUrl('public', publicStreams),
      controller,
      onOpen: () => depth.resetAll(),
      onMessage: onPublicMessage
    }),
    streamLoop({
      label: 'market stream',
      url: streamUrl('market', marketStreams),
      controller,
      onMessage: onMarketMessage
    }),
    fundingLoop({
      symbols: config.symbols,
      controller,
      metrics,
      intervalSeconds: config.fundingPollSeconds
    })
  ];
  let tickBusy = false;
  let lastHeartbeatAt = 0;
  const tick = async () => {
    if (tickBusy) return;
    tickBusy = true;
    try {
      const now = Date.now();
      const events = scanner.tick(now);
      saveJson(config.stateFile, scanner.snapshot());
      if (!config.dryRun && queue.hasItems()) await queue.flush(sendPayload);
      for (const event of events) await submitEvent(event);
      if (!lastHeartbeatAt || now - lastHeartbeatAt >= config.heartbeatIntervalSeconds * 1_000) {
        lastHeartbeatAt = now;
        await sendHeartbeat(now);
      }
    } catch (error) {
      log('ERROR', 'worker tick failed', { reason: error.message });
    } finally {
      tickBusy = false;
    }
  };
  const timer = setInterval(() => void tick(), 1_000);
  const signalStop = reason => controller.request(reason);
  process.once('SIGINT', () => signalStop('SIGINT'));
  process.once('SIGTERM', () => signalStop('SIGTERM'));
  if (config.durationSeconds != null) setTimeout(() => signalStop('duration complete'), config.durationSeconds * 1_000);
  await tick();
  await controller.promise;
  clearInterval(timer);
  await Promise.allSettled(loops);
  await tick();
  saveJson(config.stateFile, scanner.snapshot());
  log('INFO', 'Hengyu local live worker stopped', { reason: controller.reason, scanner: scanner.status() });
  process.exit(0);
}

main().catch(error => {
  log('ERROR', 'Hengyu local live worker stopped before startup', { reason: error.message });
  process.exitCode = 1;
});
