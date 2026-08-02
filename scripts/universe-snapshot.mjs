import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUniverseSnapshot } from '../src/model/universe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_POLICY_FILE = path.join(ROOT, 'config', 'universe-policy.json');

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

function integerFlag(name, fallback, { minimum = 0 } = {}) {
  const value = Number(flag(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
  return value;
}

function outputFile() {
  const value = flag('output');
  if (value) return path.resolve(ROOT, value);
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  return path.join(ROOT, 'data', 'raw', 'universe', `snapshot-${stamp}.json`);
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

function toPolicy(config) {
  return {
    ...config,
    minListingAgeMs: Number(config.minListingAgeDays ?? 30) * 86_400_000
  };
}

async function fetchDepth(symbol) {
  const url = `https://fapi.binance.com/fapi/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=20`;
  try {
    const payload = await getJson(url);
    return {
      symbol,
      asOf: Date.now(),
      bids: payload.b,
      asks: payload.a,
      lastUpdateId: payload.lastUpdateId
    };
  } catch (error) {
    return { symbol, error: error.message ?? String(error) };
  }
}

async function mapWithConcurrency(rows, concurrency, fn) {
  const result = [];
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const index = cursor++;
      result[index] = await fn(rows[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return result;
}

async function main() {
  const policyFile = path.resolve(ROOT, flag('policy', DEFAULT_POLICY_FILE));
  const config = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  const exchangeInfoPayload = await getJson('https://fapi.binance.com/fapi/v1/exchangeInfo');
  const tickerPayload = await getJson('https://fapi.binance.com/fapi/v1/ticker/24hr');
  const roughCandidates = (exchangeInfoPayload.symbols ?? []).filter(row => {
    const quote = String(row.quoteAsset ?? row.marginAsset ?? '').toUpperCase();
    return String(row.contractType ?? '').toUpperCase() === 'PERPETUAL'
      && (config.allowedQuoteAssets ?? ['USDT', 'USDC']).map(value => String(value).toUpperCase()).includes(quote)
      && String(row.status ?? '').toUpperCase() === 'TRADING';
  });
  const tickerBySymbol = new Map((Array.isArray(tickerPayload) ? tickerPayload : []).map(row => [String(row.symbol).toUpperCase(), row]));
  const volumeCandidates = roughCandidates
    .map(row => ({ row, ticker: tickerBySymbol.get(String(row.symbol).toUpperCase()) }))
    .filter(({ ticker }) => ticker && Number(ticker.quoteVolume) >= Number(config.minTierBQuoteVolumeUsdt ?? 1_000_000))
    .sort((left, right) => Number(right.ticker.quoteVolume) - Number(left.ticker.quoteVolume));
  const depthLimit = Math.max(integerFlag('depth-candidates', 250, { minimum: 1 }), Number(config.maxSymbols ?? 200));
  const depthRows = await mapWithConcurrency(
    volumeCandidates.slice(0, depthLimit).map(({ row }) => String(row.symbol).toUpperCase()),
    integerFlag('concurrency', 8, { minimum: 1 }),
    fetchDepth
  );
  const depths = depthRows.filter(row => !row.error);
  const depthErrors = depthRows.filter(row => row.error);
  const observedAt = Date.now();
  const snapshot = buildUniverseSnapshot({
    exchangeInfo: exchangeInfoPayload.symbols ?? [],
    tickers: Array.isArray(tickerPayload) ? tickerPayload : [],
    depths,
    observedAt,
    policy: toPolicy(config)
  });
  const output = {
    ...snapshot,
    source: {
      exchangeInfoEndpoint: '/fapi/v1/exchangeInfo',
      tickerEndpoint: '/fapi/v1/ticker/24hr',
      depthEndpoint: '/fapi/v1/depth?limit=20',
      depthCandidates: depthRows.length,
      depthErrors
    },
    authorization: 'PAPER_ONLY',
    privateEndpointsUsed: false,
    orderPlacement: false
  };
  const file = outputFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({
    status: 'complete',
    output: path.relative(ROOT, file).replaceAll('\\', '/'),
    universeVersion: snapshot.universeVersion,
    counts: snapshot.counts,
    symbols: snapshot.symbols
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
