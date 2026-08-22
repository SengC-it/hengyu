import fs from 'node:fs';
import path from 'node:path';
import { execFile as execFileCallback, spawn as spawnProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

export const HY_EXP_0023_REQUIRED_ALERTS = Object.freeze([
  'collector_death',
  'sequence_gap',
  'crossed_book',
  'snapshot_alignment_failure',
  'missing_receivedAt'
]);

function timestamp(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) throw new Error('invalid timestamp');
  return parsed;
}

function listFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function streamName(filePath) {
  const name = path.basename(filePath);
  if (name.startsWith('depth.diff')) return 'depth';
  if (name.startsWith('depth.snapshot')) return 'snapshot';
  if (name.startsWith('kline')) return 'kline';
  if (name.startsWith('exchangeInfo')) return 'exchangeInfo';
  if (name.startsWith('funding')) return 'funding';
  if (name.startsWith('universe')) return 'metadata';
  if (name.startsWith('segment')) return 'segment';
  return 'other';
}

function readNdjsonStats(filePath) {
  if (!filePath.endsWith('.ndjson')) return { events: 0, bySymbol: {} };
  const bySymbol = {};
  let events = 0;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean)) {
    events++;
    try {
      const record = JSON.parse(line);
      const symbol = String(record?.symbol ?? record?.data?.s ?? '').toUpperCase();
      if (symbol) {
        const row = bySymbol[symbol] ?? { bytes: 0, events: 0 };
        row.bytes += Buffer.byteLength(`${line}\n`);
        row.events++;
        bySymbol[symbol] = row;
      }
    } catch {
      // Hash/manifest verification handles malformed records; this metric remains observable.
    }
  }
  return { events, bySymbol };
}

export function measureHyExp0023Storage({
  root,
  startedAt,
  finishedAt,
  symbols = [],
  captureStart = '2026-08-23T12:00:00.000Z',
  developmentEndExclusive = '2027-03-01T00:00:00.000Z',
  finalOosEndExclusive = '2027-09-01T00:00:00.000Z'
} = {}) {
  const started = timestamp(startedAt);
  const finished = timestamp(finishedAt);
  const durationSeconds = Math.max((finished - started) / 1_000, 0.001);
  const byStream = {};
  const bySymbol = {};
  let totalBytes = 0;
  let totalEvents = 0;
  for (const filePath of listFiles(path.resolve(root))) {
    const stat = fs.statSync(filePath);
    const stream = streamName(filePath);
    const entry = byStream[stream] ?? { bytes: 0, events: 0, files: 0 };
    entry.bytes += stat.size;
    const fileMetrics = readNdjsonStats(filePath);
    const fileEvents = fileMetrics.events;
    entry.events += fileEvents;
    entry.files++;
    byStream[stream] = entry;
    totalBytes += stat.size;
    totalEvents += fileEvents;
    for (const [symbol, row] of Object.entries(fileMetrics.bySymbol)) {
      const symbolMetrics = bySymbol[symbol] ?? { bytes: 0, events: 0 };
      symbolMetrics.bytes += row.bytes;
      symbolMetrics.events += row.events;
      bySymbol[symbol] = symbolMetrics;
    }
  }
  const bytesPerSecond = totalBytes / durationSeconds;
  const eventsPerSecond = totalEvents / durationSeconds;
  const symbolCount = Math.max(1, symbols.length);
  const projectedBytes = end => Math.ceil(bytesPerSecond * Math.max(0, timestamp(end) - timestamp(captureStart)) / 1_000);
  const developmentBytes = projectedBytes(developmentEndExclusive);
  const finalOosBytes = Math.ceil(bytesPerSecond * Math.max(0, timestamp(finalOosEndExclusive) - timestamp(developmentEndExclusive)) / 1_000);
  for (const row of Object.values(byStream)) {
    row.bytesPerSecond = row.bytes / durationSeconds;
    row.eventsPerSecond = row.events / durationSeconds;
  }
  return {
    root: path.resolve(root),
    sampleWindow: { startedAt: new Date(started).toISOString(), finishedAt: new Date(finished).toISOString(), durationSeconds },
    symbols: [...symbols].sort(),
    totalBytes,
    totalEvents,
    bytesPerSecond,
    bytesPerSecondPerSymbol: bytesPerSecond / symbolCount,
    eventsPerSecond,
    bySymbol: Object.fromEntries(Object.entries(bySymbol).sort(([left], [right]) => left.localeCompare(right)).map(([symbol, row]) => [symbol, {
      ...row,
      bytesPerSecond: row.bytes / durationSeconds,
      eventsPerSecond: row.events / durationSeconds
    }])),
    bytesPerSecondDistribution: Object.fromEntries(Object.entries(byStream).map(([stream, row]) => [stream, row.bytes / durationSeconds])),
    eventsPerSecondDistribution: Object.fromEntries(Object.entries(byStream).map(([stream, row]) => [stream, row.events / durationSeconds])),
    projected4HourBytes: Math.ceil(bytesPerSecond * 4 * 3_600),
    byStream,
    projected30DayBytes: Math.ceil(bytesPerSecond * 30 * 86_400),
    projectedDevelopmentPeriodBytes: developmentBytes,
    projectedFinalOosPeriodBytes: finalOosBytes,
    projectedFullExperimentBytes: developmentBytes + finalOosBytes
  };
}

export function probeHyExp0023StorageCapacity(root) {
  try {
    const stats = fs.statfsSync(path.resolve(root));
    return {
      availableBytes: Number(stats.bavail) * Number(stats.bsize),
      filesystem: path.parse(path.resolve(root)).root,
      source: 'node:fs.statfsSync'
    };
  } catch (error) {
    return { availableBytes: null, filesystem: null, source: 'unavailable', error: error.message };
  }
}

export function evaluateHyExp0023StorageReadiness({
  metrics,
  capacity,
  durableStorage = false,
  retentionPlan = ''
} = {}) {
  const availableBytes = Number(capacity?.availableBytes);
  const requiredBytes = Number(metrics?.projectedFullExperimentBytes);
  const capacitySufficient = Number.isFinite(availableBytes) && Number.isFinite(requiredBytes) && availableBytes >= requiredBytes;
  return {
    ready: durableStorage === true && Boolean(String(retentionPlan).trim()) && capacitySufficient,
    durableStorage,
    retentionPlan: String(retentionPlan),
    capacitySufficient,
    availableBytes: Number.isFinite(availableBytes) ? availableBytes : null,
    requiredBytes: Number.isFinite(requiredBytes) ? requiredBytes : null
  };
}

export async function probeHyExp0023OsClockSyncState({ platform = process.platform, execFileImpl = execFile } = {}) {
  const command = platform === 'win32'
    ? { file: 'w32tm', args: ['/query', '/status'] }
    : { file: 'timedatectl', args: ['show', '--property=NTPSynchronized', '--value'] };
  try {
    const result = await execFileImpl(command.file, command.args);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const synchronized = platform === 'win32'
      ? /leap indicator:\s*0/i.test(output) || /source:\s*(?!free-running|local cmos clock)/i.test(output)
      : /^yes\s*$/im.test(output);
    return { synchronized, source: command.file, output: output.trim() };
  } catch (error) {
    return { synchronized: false, source: command.file, error: error.message };
  }
}

async function fetchServerTime({ fetchImpl = globalThis.fetch, endpoint = 'https://fapi.binance.com/fapi/v1/time' } = {}) {
  const requestStartedAt = Date.now();
  const response = await fetchImpl(endpoint, { method: 'GET' });
  if (response?.ok === false) throw new Error(`server time request failed: ${response.status}`);
  const body = typeof response?.text === 'function' ? await response.text() : JSON.stringify(await response.json());
  const receivedAt = Date.now();
  const data = JSON.parse(body);
  const serverTime = Number(data?.serverTime);
  const midpoint = (requestStartedAt + receivedAt) / 2;
  return {
    requestStartedAt,
    receivedAt,
    roundTripMs: receivedAt - requestStartedAt,
    midpoint,
    serverTime,
    driftMs: Number.isFinite(serverTime) ? serverTime - midpoint : null
  };
}

export async function measureHyExp0023ClockReadiness({
  fetchImpl = globalThis.fetch,
  clockSyncStateProvider = probeHyExp0023OsClockSyncState,
  serverTimeEndpoint,
  serverTimeSampleCount = 3,
  driftWarningThresholdMs = 100,
  driftStopThresholdMs = 500
} = {}) {
  const osState = await clockSyncStateProvider();
  const sampleCount = Math.max(1, Math.trunc(Number(serverTimeSampleCount)));
  const samples = [];
  let error = null;
  try {
    for (let index = 0; index < sampleCount; index++) {
      samples.push(await fetchServerTime({ fetchImpl, endpoint: serverTimeEndpoint }));
    }
  } catch (caught) {
    error = caught;
  }
  const validSamples = samples.filter(sample => Number.isFinite(sample.serverTime) && Number.isFinite(sample.driftMs));
  const maxAbsDriftMs = validSamples.length
    ? Math.max(...validSamples.map(sample => Math.abs(sample.driftMs)))
    : null;
  const latest = validSamples.at(-1) ?? null;
  const base = {
    ready: false,
    reason: null,
    osState,
    sampleCount,
    samples,
    validSampleCount: validSamples.length,
    maxAbsDriftMs,
    driftWarningThresholdMs,
    driftStopThresholdMs,
    requestStartedAt: latest?.requestStartedAt ?? null,
    receivedAt: latest?.receivedAt ?? null,
    roundTripMs: latest?.roundTripMs ?? null,
    midpoint: latest?.midpoint ?? null,
    serverTime: latest?.serverTime ?? null,
    driftMs: latest?.driftMs ?? null
  };
  if (osState?.synchronized !== true) return { ...base, reason: 'OS_CLOCK_NOT_SYNCHRONIZED', error: error?.message ?? null };
  if (error) return { ...base, reason: 'SERVER_TIME_UNAVAILABLE', error: error.message };
  if (validSamples.length !== sampleCount) return { ...base, reason: 'CLOCK_DRIFT_INVALID' };
  if (maxAbsDriftMs >= driftStopThresholdMs) return { ...base, reason: 'CLOCK_DRIFT_ABOVE_STOP_THRESHOLD' };
  return {
    ...base,
    ready: true,
    reason: maxAbsDriftMs >= driftWarningThresholdMs ? 'CLOCK_DRIFT_WARNING' : null
  };
}

export function evaluateHyExp0023Alerts({ activeAlerts = [] } = {}) {
  const active = new Set(activeAlerts);
  const missing = HY_EXP_0023_REQUIRED_ALERTS.filter(alert => !active.has(alert));
  return { ready: missing.length === 0, required: [...HY_EXP_0023_REQUIRED_ALERTS], active: [...active].sort(), missing };
}

export function appendHyExp0023Alert(filePath, event = {}) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const record = {
    schemaVersion: 1,
    experimentId: 'HY-EXP-0023',
    stream: 'engineering.alert',
    recordedAt: new Date().toISOString(),
    ...event
  };
  const handle = fs.openSync(target, 'a');
  try {
    fs.writeSync(handle, `${JSON.stringify(record)}\n`, null, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  return record;
}

export function readHyExp0023Heartbeat(filePath) {
  const target = path.resolve(filePath);
  if (!fs.existsSync(target)) return null;
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

/** Supervisor for a long-running engineering collector; never launches official capture. */
export function createHyExp0023Supervisor({
  spawnImpl = spawnProcess,
  command = process.execPath,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  maxRestarts = 5,
  restartBaseMs = 250,
  restartMaxMs = 10_000,
  heartbeatTimeoutMs = 15_000,
  heartbeatFile = null,
  progressReader = heartbeatFile == null ? null : () => readHyExp0023Heartbeat(heartbeatFile),
  alertFile = null,
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  onAlert = () => {}
} = {}) {
  let child = null;
  let stopped = true;
  let restartCount = 0;
  let reconnectCount = 0;
  let lastHeartbeatAt = null;
  let lastExitReason = null;
  let restartTimer = null;
  let segmentIndex = 0;
  let lastProgress = null;
  let lastProgressFingerprint = null;
  let lastDataProgressAt = null;
  let staleAlerted = false;
  const alerts = [];

  const alert = (type, details = {}) => {
    const event = { type, at: new Date(now()).toISOString(), ...details };
    alerts.push(event);
    if (alertFile) appendHyExp0023Alert(alertFile, event);
    onAlert(event);
    return event;
  };

  const startChild = (reason = 'initial') => {
    if (stopped) return null;
    segmentIndex++;
    const childArgs = [...args, '--mode', 'ENGINEERING_DRY_RUN', '--segment-id', `supervisor-segment-${segmentIndex}`];
    if (heartbeatFile && !childArgs.includes('--heartbeat-file')) childArgs.push('--heartbeat-file', heartbeatFile);
    if (alertFile && !childArgs.includes('--alert-file')) childArgs.push('--alert-file', alertFile);
    child = spawnImpl(command, childArgs, { cwd, env, stdio: 'inherit' });
    lastHeartbeatAt = now();
    lastDataProgressAt = lastHeartbeatAt;
    lastProgress = null;
    lastProgressFingerprint = null;
    staleAlerted = false;
    child?.on?.('error', error => {
      lastExitReason = `error:${error.message}`;
      alert('collector_death', { reason: lastExitReason, segmentId: segmentIndex });
    });
    child?.on?.('exit', (code, signal) => {
      if (stopped) return;
      lastExitReason = `exit:${code ?? 'null'}:${signal ?? 'none'}`;
      alert('collector_death', { reason: lastExitReason, segmentId: segmentIndex });
      if (restartCount >= maxRestarts) return;
      const delay = Math.min(restartMaxMs, restartBaseMs * 2 ** restartCount);
      restartCount++;
      reconnectCount++;
      restartTimer = setTimeoutImpl(() => {
        restartTimer = null;
        startChild(lastExitReason);
      }, delay);
    });
    return child;
  };

  return {
    start({ officialCaptureAuthorized = false } = {}) {
      if (officialCaptureAuthorized === true) throw new Error('official HY-EXP-0023 capture is not authorized');
      stopped = false;
      return startChild('initial');
    },
    stop() {
      stopped = true;
      if (restartTimer) clearTimeoutImpl(restartTimer);
      restartTimer = null;
      try { child?.kill?.('SIGTERM'); } catch { /* best effort graceful shutdown */ }
      child = null;
    },
    heartbeat({ at = now() } = {}) {
      lastHeartbeatAt = at;
      return { accepted: true, at };
    },
    checkHealth({ at = now() } = {}) {
      let progress = null;
      try { progress = progressReader?.() ?? null; } catch { progress = null; }
      if (progress && child?.pid != null && progress.processId != null && progress.processId !== child.pid) {
        progress = null;
      }
      if (progress) {
        const fingerprint = JSON.stringify({
          segmentId: progress.segmentId ?? null,
          eventCount: progress.eventCount ?? null,
          writtenBytes: progress.writtenBytes ?? null,
          lastDepthReceivedAt: progress.lastDepthReceivedAt ?? null,
          lastKlineReceivedAt: progress.lastKlineReceivedAt ?? null,
          lastExchangeEventAt: progress.lastExchangeEventAt ?? null
        });
        if (fingerprint !== lastProgressFingerprint) {
          lastDataProgressAt = at;
          lastProgressFingerprint = fingerprint;
        }
        lastProgress = progress;
      }
      const staleHeartbeat = lastHeartbeatAt != null && at - lastHeartbeatAt > heartbeatTimeoutMs;
      const staleData = progressReader != null
        && (lastDataProgressAt == null || at - lastDataProgressAt > heartbeatTimeoutMs);
      const stale = staleHeartbeat || staleData;
      if (stale && !staleAlerted) {
        staleAlerted = true;
        alert('stale_data', {
          reason: staleData ? 'collector_alive_without_market_data_progress' : 'stale_heartbeat',
          staleForMs: at - (staleData ? lastDataProgressAt : lastHeartbeatAt),
          heartbeat: progress
        });
        alert('collector_death', { reason: 'stale_data_requires_restart', segmentId: segmentIndex });
        try { child?.kill?.('SIGTERM'); } catch { /* exit handler owns bounded restart */ }
      }
      return {
        healthy: !stopped && child != null && !stale,
        stale,
        staleData,
        lastHeartbeatAt,
        lastDataProgressAt,
        progress: lastProgress,
        restartCount,
        reconnectCount
      };
    },
    diagnostics() {
      return {
        stopped,
        restartCount,
        reconnectCount,
        segmentIndex,
        lastHeartbeatAt,
        lastExitReason,
        lastDataProgressAt,
        progress: lastProgress,
        alerts: [...alerts]
      };
    }
  };
}
