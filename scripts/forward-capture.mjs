import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

const CONFIG = path.resolve(ROOT, flag('config', 'config/forward-capture.json'));
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

function symbols() {
  const universeFile = flag('universe-file');
  const configuredSymbols = Array.isArray(config.symbols) ? config.symbols.join(',') : '';
  let value = flag('symbols', configuredSymbols || null);
  if (universeFile) {
    const snapshotPath = path.resolve(ROOT, universeFile);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    if (!snapshot.pointInTime || snapshot.futureDataUsed) {
      throw new Error('universe snapshot is not point-in-time safe');
    }
    value = snapshot.symbols.join(',');
  }
  if (!value) throw new Error('symbols or --universe-file is required');
  const output = value.split(',').map(symbol => symbol.trim().toUpperCase()).filter(Boolean);
  if (!output.length) throw new Error('at least one symbol is required');
  if (output.some(symbol => !/^[A-Z0-9]+$/.test(symbol))) {
    throw new Error('symbols must contain only uppercase letters and digits');
  }
  return [...new Set(output)];
}

function universeSnapshot() {
  const universeFile = flag('universe-file');
  if (!universeFile) return null;
  const snapshotPath = path.resolve(ROOT, universeFile);
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  if (!snapshot.pointInTime || snapshot.futureDataUsed) throw new Error('universe snapshot is not point-in-time safe');
  return {
    path: path.relative(ROOT, snapshotPath).replaceAll('\\', '/'),
    sha256: sha256(snapshotPath),
    universeVersion: snapshot.universeVersion,
    observedAt: snapshot.observedAt,
    counts: snapshot.counts,
    symbols: snapshot.symbols
  };
}

function seconds() {
  const value = Number(flag('seconds', '60'));
  if (!Number.isInteger(value) || value < 5 || value > 86_400) {
    throw new Error('--seconds must be an integer from 5 to 86400');
  }
  return value;
}

function fundingPollSeconds() {
  const value = Number(flag('funding-poll-seconds', config.fundingPollSeconds ?? 60));
  if (!Number.isInteger(value) || value < 10 || value > 3_600) {
    throw new Error('fundingPollSeconds must be an integer from 10 to 3600');
  }
  return value;
}

function openInterestPollSeconds() {
  const value = Number(flag('open-interest-poll-seconds', config.openInterestPollSeconds ?? 0));
  if (value === 0) return 0;
  if (!Number.isInteger(value) || value < 10 || value > 3_600) {
    throw new Error('openInterestPollSeconds must be 0 or an integer from 10 to 3600');
  }
  return value;
}

function streamNames(symbolList, names) {
  return symbolList.flatMap(symbol => names.map(name => `${symbol.toLowerCase()}@${name}`));
}

function timestamp() {
  return new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function connect(url, output, summary) {
  let settled = false;
  let opened = false;
  let resolveReady;
  let resolveDone;
  let resolveFailed;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const done = new Promise(resolve => { resolveDone = resolve; });
  const failed = new Promise(resolve => { resolveFailed = resolve; });
  const socket = new WebSocket(url);
  const finish = error => {
    if (settled) return;
    settled = true;
    if (error) {
      summary.error = error.message;
      resolveFailed(error);
    }
    if (!opened) resolveReady(false);
    resolveDone();
  };
  socket.addEventListener('open', () => {
    opened = true;
    summary.connectedAt = Date.now();
    resolveReady(true);
  });
  socket.addEventListener('message', event => {
    const receivedAt = Date.now();
    let payload;
    try {
      payload = JSON.parse(String(event.data));
    } catch (error) {
      summary.parseErrors++;
      return;
    }
    const stream = payload.stream ?? 'raw';
    const data = payload.data ?? payload;
    output.write(`${JSON.stringify({ receivedAt, stream, data })}\n`);
    summary.messages++;
    if (data?.e === 'depthUpdate') {
      summary.depthUpdates++;
      const symbol = String(data.s ?? stream.split('@', 1)[0]).toUpperCase();
      if (!summary.depthAlignedSymbols.has(symbol)) {
        const buffer = summary.depthBuffers.get(symbol) ?? [];
        buffer.push({ receivedAt, stream, data });
        summary.depthBuffers.set(symbol, buffer);
      }
    }
    if (data?.e === 'forceOrder') summary.forceOrders++;
  });
  socket.addEventListener('error', () => finish(new Error(`WebSocket error: ${url}`)));
  socket.addEventListener('close', event => {
    if (!settled && event.code !== 1000) finish(new Error(`WebSocket closed ${event.code}: ${url}`));
    else finish();
  });
  summary.close = () => {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, 'capture complete');
    }
  };
  return { ready, done, failed };
}

async function fetchDepthSnapshot(symbol) {
  const url = `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=1000`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`depth snapshot ${symbol}: HTTP ${response.status}`);
  const payload = await response.json();
  return { symbol, receivedAt: Date.now(), payload };
}

async function fetchAlignedDepthSnapshot(symbol, summary) {
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const snapshot = await fetchDepthSnapshot(symbol);
      const snapshotId = Number(snapshot.payload.lastUpdateId);
      const buffer = summary.depthBuffers.get(symbol) ?? [];
      const aligned = buffer.some(row => {
        const firstUpdate = Number(row.data?.U);
        const lastUpdate = Number(row.data?.u);
        return firstUpdate <= snapshotId && snapshotId <= lastUpdate;
      });
      if (aligned) {
        summary.depthAlignedSymbols.add(symbol);
        summary.depthBuffers.delete(symbol);
        return snapshot;
      }
      lastError = `depth snapshot ${symbol}: no buffered update spans ${snapshotId}`;
    } catch (error) {
      lastError = error.message ?? String(error);
    }
    await delay(250);
  }
  throw new Error(lastError ?? `depth snapshot ${symbol}: alignment timeout`);
}

async function fetchFundingRate(symbol) {
  const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`funding rate ${symbol}: HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload) || !payload.length) throw new Error(`funding rate ${symbol}: empty response`);
  const latest = payload.at(-1);
  return {
    receivedAt: Date.now(),
    stream: `${symbol.toLowerCase()}@fundingRate`,
    data: { e: 'fundingRate', ...latest, s: symbol }
  };
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function pollFundingRates(symbolList, durationSeconds, output, summary) {
  const intervalMs = fundingPollSeconds() * 1_000;
  const stopAt = Date.now() + durationSeconds * 1_000;
  const seen = new Map();
  while (Date.now() < stopAt && !summary.stopRequested) {
    const results = await Promise.allSettled(symbolList.map(fetchFundingRate));
    for (const result of results) {
      if (result.status === 'rejected') {
        summary.errors.push(result.reason?.message ?? String(result.reason));
        continue;
      }
      const row = result.value;
      const key = `${row.data.s}:${row.data.fundingTime}`;
      if (seen.has(key)) continue;
      seen.set(key, true);
      output.write(`${JSON.stringify(row)}\n`);
      summary.messages++;
    }
    const remaining = stopAt - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(intervalMs, remaining));
  }
}

async function fetchOpenInterest(symbol) {
  const url = `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`open interest ${symbol}: HTTP ${response.status}`);
  const payload = await response.json();
  const value = Number(payload.openInterest);
  if (!Number.isFinite(value) || value < 0) throw new Error(`open interest ${symbol}: invalid value`);
  return {
    receivedAt: Date.now(),
    stream: `${symbol.toLowerCase()}@openInterest`,
    data: { e: 'openInterest', E: Date.now(), s: symbol, openInterest: payload.openInterest, time: payload.time ?? null }
  };
}

async function pollOpenInterest(symbolList, durationSeconds, output, summary, intervalSeconds) {
  if (!intervalSeconds) return;
  const intervalMs = intervalSeconds * 1_000;
  const stopAt = Date.now() + durationSeconds * 1_000;
  while (Date.now() < stopAt && !summary.stopRequested) {
    const results = await Promise.allSettled(symbolList.map(fetchOpenInterest));
    for (const result of results) {
      if (result.status === 'rejected') {
        summary.errors.push(result.reason?.message ?? String(result.reason));
        continue;
      }
      output.write(`${JSON.stringify(result.value)}\n`);
      summary.messages++;
    }
    const remaining = stopAt - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(intervalMs, remaining));
  }
}

async function main() {
  const symbolList = symbols();
  const duration = seconds();
  const universe = universeSnapshot();
  const captureId = flag('capture-id', config.captureId);
  const outputRoot = flag('output-root', config.outputRoot);
  if (!captureId || !outputRoot) throw new Error('capture id and output root are required');
  const runId = `${captureId}-${timestamp()}`;
  const startedAt = Date.now();
  const directory = path.join(ROOT, outputRoot, runId);
  fs.mkdirSync(directory, { recursive: true });
  const publicStreams = streamNames(symbolList, config.streams.public);
  const marketStreams = streamNames(symbolList, config.streams.market);
  const publicFile = path.join(directory, 'public.ndjson');
  const marketFile = path.join(directory, 'market.ndjson');
  const fundingFile = path.join(directory, 'funding.ndjson');
  const openInterestInterval = openInterestPollSeconds();
  const openInterestFile = path.join(directory, 'open-interest.ndjson');
  const publicOutput = fs.createWriteStream(publicFile, { flags: 'wx' });
  const marketOutput = fs.createWriteStream(marketFile, { flags: 'wx' });
  const fundingOutput = fs.createWriteStream(fundingFile, { flags: 'wx' });
  const openInterestOutput = openInterestInterval
    ? fs.createWriteStream(openInterestFile, { flags: 'wx' })
    : null;
  const summaries = [
    {
      endpoint: 'public',
      streams: publicStreams,
      messages: 0,
      depthUpdates: 0,
      forceOrders: 0,
      parseErrors: 0,
      depthBuffers: new Map(),
      depthAlignedSymbols: new Set()
    },
    {
      endpoint: 'market',
      streams: marketStreams,
      messages: 0,
      depthUpdates: 0,
      forceOrders: 0,
      parseErrors: 0,
      depthBuffers: new Map(),
      depthAlignedSymbols: new Set()
    }
  ];
  const fundingSummary = {
    endpoint: 'rest-funding',
    streams: symbolList.map(symbol => `${symbol.toLowerCase()}@fundingRate`),
    messages: 0,
    errors: [],
    stopRequested: false
  };
  const openInterestSummary = {
    endpoint: 'rest-open-interest',
    streams: symbolList.map(symbol => `${symbol.toLowerCase()}@openInterest`),
    messages: 0,
    errors: [],
    stopRequested: false
  };
  const fundingPromise = pollFundingRates(symbolList, duration, fundingOutput, fundingSummary)
    .catch(error => fundingSummary.errors.push(error.message ?? String(error)));
  const openInterestPromise = pollOpenInterest(
    symbolList,
    duration,
    openInterestOutput,
    openInterestSummary,
    openInterestInterval
  ).catch(error => openInterestSummary.errors.push(error.message ?? String(error)));
  const connections = [
    connect(`wss://fstream.binance.com/public/stream?streams=${publicStreams.join('/')}`, publicOutput, summaries[0]),
    connect(`wss://fstream.binance.com/market/stream?streams=${marketStreams.join('/')}`, marketOutput, summaries[1])
  ];
  await Promise.all(connections.map(connection => connection.ready));
  const snapshotResults = await Promise.allSettled(
    symbolList.map(symbol => fetchAlignedDepthSnapshot(symbol, summaries[0]))
  );
  const snapshots = snapshotResults
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value);
  const snapshotErrors = snapshotResults
    .filter(result => result.status === 'rejected')
    .map(result => result.reason?.message ?? String(result.reason));
  const captureTimer = delay(duration * 1000).then(() => null);
  const connectionFailure = Promise.race(connections.map(connection => connection.failed));
  const earlyFailure = await Promise.race([captureTimer, connectionFailure]);
  if (earlyFailure instanceof Error) {
    fundingSummary.stopRequested = true;
    openInterestSummary.stopRequested = true;
  }
  summaries.forEach(summary => summary.close?.());
  await Promise.all(connections.map(connection => connection.done));
  await fundingPromise;
  await openInterestPromise;
  await Promise.all([
    new Promise(resolve => publicOutput.end(resolve)),
    new Promise(resolve => marketOutput.end(resolve)),
    new Promise(resolve => fundingOutput.end(resolve)),
    openInterestOutput ? new Promise(resolve => openInterestOutput.end(resolve)) : Promise.resolve()
  ]);
  const errors = [
    ...snapshotErrors.map(error => `snapshot: ${error}`),
    ...summaries.filter(summary => summary.error)
      .map(summary => `${summary.endpoint}: ${summary.error}`),
    ...fundingSummary.errors.map(error => `funding: ${error}`),
    ...openInterestSummary.errors.map(error => `open_interest: ${error}`)
  ];
  const manifest = {
    status: errors.length ? 'failed' : 'complete',
    capture_id: captureId,
    run_id: runId,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    duration_seconds: duration,
    symbols: symbolList,
    universe,
    endpoints: [...summaries, fundingSummary, ...(openInterestInterval ? [openInterestSummary] : [])]
      .map(({ close, depthBuffers, depthAlignedSymbols, ...summary }) => summary),
    snapshots,
    errors,
    files: [publicFile, marketFile, fundingFile, ...(openInterestInterval ? [openInterestFile] : [])].map(file => ({
      path: path.relative(ROOT, file).replaceAll('\\', '/'),
      bytes: fs.statSync(file).size,
      sha256: sha256(file)
    }))
  };
  const manifestFile = path.join(directory, 'manifest.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({
    status: manifest.status,
    runId,
    directory: path.relative(ROOT, directory).replaceAll('\\', '/'),
    messages: summaries.reduce((total, summary) => total + summary.messages, 0),
    depthUpdates: summaries.reduce((total, summary) => total + summary.depthUpdates, 0),
    forceOrders: summaries.reduce((total, summary) => total + summary.forceOrders, 0),
    fundingRates: fundingSummary.messages,
    openInterestRows: openInterestSummary.messages,
    files: manifest.files
  }, null, 2));
  if (errors.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
