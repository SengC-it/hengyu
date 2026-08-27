import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createInflateRaw, createGunzip, createGzip } from 'node:zlib';
import { finished } from 'node:stream/promises';
import { buildSeries } from './hy-exp-0039-email-signal.mjs';
import {
  DEFAULT_CHUNK_BYTES,
  DEFAULT_HTTP_CONCURRENCY,
  downloadArchiveWithResume,
  markPartitionParsed,
  commitDerivedPartition,
  isPartitionSkipEligible,
  loadPartitionState,
  objectKeyFromCanonicalUrl
} from './hy-exp-0040-transport.mjs';

export const HY_EXP_0040 = 'HY-EXP-0040';
export const WINDOW_START = Date.parse('2024-08-26T00:00:00Z');
export const WINDOW_END = Date.parse('2026-08-26T00:00:00Z');
export const DEVELOPMENT_START = WINDOW_START;
export const DEVELOPMENT_END = Date.parse('2025-08-26T00:00:00Z');
export const VALIDATION_START = DEVELOPMENT_END;
export const VALIDATION_END = WINDOW_END;
export const MINUTE = 60 * 1000;
export const FIVE_MINUTES = 5 * MINUTE;
export const FIFTEEN_MINUTES = 15 * MINUTE;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const MAX_HOLD_MS = 12 * HOUR;
export const FIXED_SYMBOLS = Object.freeze([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
  'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'
]);
export const COSTS_BPS = Object.freeze({ 18: 18, 27: 27, 36: 36 });
export const MODEL_LAMBDAS = Object.freeze([0.01, 0.1, 1, 10]);
export const FEATURE_NAMES = Object.freeze([
  'buySellNotionalImbalance1m',
  'buySellNotionalImbalance5m',
  'buySellNotionalImbalance15m',
  'buySellNotionalImbalance1h',
  'tradeCountImbalance1m',
  'tradeCountImbalance5m',
  'tradeCountImbalance15m',
  'tradeCountImbalance1h',
  'signedNotional5m',
  'signedNotional15m',
  'signedNotional1h',
  'CVDChange5m',
  'CVDChange15m',
  'CVDChange1h',
  'tradeIntensity1m',
  'tradeIntensity5m',
  'tradeIntensity15m',
  'notionalIntensity1m',
  'notionalIntensity5m',
  'notionalIntensity15m',
  'relativeTradeIntensity24h',
  'relativeNotionalIntensity24h',
  'largeTradeImbalance5m',
  'largeTradeImbalance15m',
  'largeTradeImbalance1h',
  'flowAcceleration1mVsPrior5m',
  'flowAcceleration5mVsPrior1h',
  'priceImpactProxy',
  'CVDPriceDivergence',
  'aggressiveBuyExhaustionProxy',
  'aggressiveSellExhaustionProxy',
  'absorptionBuyProxy',
  'absorptionSellProxy',
  'atrPercent',
  'realizedVolatility1h',
  'fundingRate',
  'markContractBasisBps',
  'btcReturn4h',
  'btcRegime',
  'sideSign'
]);

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function crc32Update(value, buffer) {
  let output = value;
  for (const byte of buffer) output = CRC_TABLE[(output ^ byte) & 0xff] ^ (output >>> 8);
  return output >>> 0;
}

function finite(value) {
  return Number.isFinite(value);
}

function iso(value) {
  return new Date(value).toISOString();
}

function monthKeys(start, end) {
  const output = [];
  const cursor = new Date(start);
  cursor.setUTCDate(1);
  while (cursor.getTime() < end) {
    output.push({
      key: cursor.toISOString().slice(0, 7),
      start: cursor.getTime(),
      end: Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1)
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return output;
}

function dayKeys(start, end) {
  const output = [];
  for (let cursor = Math.floor(start / DAY) * DAY; cursor < end; cursor += DAY) {
    output.push({ key: iso(cursor).slice(0, 10), start: cursor, end: cursor + DAY });
  }
  return output;
}

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => consume());
  await Promise.all(workers);
  return results;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 30_000) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function decodeXml(value) {
  return String(value)
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function parseObjectListing(xml) {
  const objects = [];
  for (const match of String(xml).matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const content = match[1];
    const key = content.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
    const size = content.match(/<Size>([\s\S]*?)<\/Size>/)?.[1];
    if (!key || !size) continue;
    objects.push({
      key: decodeXml(key),
      bytes: Number(size),
      lastModified: decodeXml(content.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1] ?? ''),
      etag: decodeXml(content.match(/<ETag>([\s\S]*?)<\/ETag>/)?.[1] ?? '')
    });
  }
  return objects;
}

async function listOfficialObjects(prefix) {
  const objects = [];
  let continuationToken = null;
  do {
    let url = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision/?list-type=2&prefix='
      + encodeURIComponent(prefix);
    if (continuationToken) url += '&continuation-token=' + encodeURIComponent(continuationToken);
    const response = await fetchWithTimeout(url);
    if (!response.ok) throw new Error('BINANCE_OBJECT_LIST_FAILED:' + response.status + ':' + prefix);
    const xml = await response.text();
    objects.push(...parseObjectListing(xml));
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    continuationToken = truncated
      ? decodeXml(xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? '')
      : null;
    if (truncated && !continuationToken) throw new Error('BINANCE_OBJECT_LIST_TOKEN_MISSING:' + prefix);
  } while (continuationToken);
  return objects;
}

export function parseChecksumText(value) {
  const match = String(value).match(/[a-f0-9]{64}/i);
  if (!match) throw new Error('BINANCE_CHECKSUM_FORMAT_INVALID');
  return match[0].toLowerCase();
}

export async function headArchive(url, { fetchImpl = fetchWithTimeout } = {}) {
  const response = await fetchImpl(url, { method: 'HEAD' });
  return {
    url,
    status: response.status,
    bytes: Number(response.headers.get('content-length') || 0),
    lastModified: response.headers.get('last-modified'),
    etag: response.headers.get('etag')
  };
}

async function fetchChecksum(url, { fetchImpl = fetchWithTimeout } = {}) {
  const checksumUrl = url + '.CHECKSUM';
  const response = await fetchImpl(checksumUrl);
  if (!response.ok) throw new Error('BINANCE_CHECKSUM_UNAVAILABLE:' + response.status + ':' + checksumUrl);
  return { checksumUrl, sha256: parseChecksumText(await response.text()) };
}

export async function discoverArchives({
  symbols = FIXED_SYMBOLS,
  start = WINDOW_START,
  end = WINDOW_END,
  headImpl = headArchive,
  checksumImpl = fetchChecksum
} = {}) {
  const useOfficialListing = headImpl === headArchive && checksumImpl === fetchChecksum;
  const monthlyListings = useOfficialListing
    ? new Map((await Promise.all(symbols.map(async symbol => [
      symbol,
      await listOfficialObjects('data/futures/um/monthly/aggTrades/' + symbol + '/')
    ]))).map(([symbol, objects]) => [
      symbol,
      new Map(objects
        .filter(object => object.key.endsWith('.zip') && !object.key.includes('part-'))
        .map(object => [object.key.slice(-11, -4), object]))
    ]))
    : null;
  const jobs = symbols.flatMap(symbol => monthKeys(start, end).map(month => ({ symbol, month })));
  const perPartition = await mapConcurrent(jobs, 4, async ({ symbol, month }) => {
    const monthlyUrl = 'https://data.binance.vision/data/futures/um/monthly/aggTrades/'
      + symbol + '/' + symbol + '-aggTrades-' + month.key + '.zip';
    const listedMonthly = monthlyListings?.get(symbol)?.get(month.key) ?? null;
    const monthly = listedMonthly
      ? {
        status: 200,
        bytes: listedMonthly.bytes,
        lastModified: listedMonthly.lastModified,
        etag: listedMonthly.etag
      }
      : await headImpl(monthlyUrl);
    if (monthly.status === 200 && monthly.bytes > 0) {
      const checksum = await checksumImpl(monthlyUrl);
      return [{
        symbol,
        cadence: 'monthly',
        period: month.key,
        url: monthlyUrl,
        bytes: monthly.bytes,
        lastModified: monthly.lastModified ?? null,
        etag: monthly.etag ?? null,
        checksumUrl: checksum.checksumUrl,
        sha256: checksum.sha256
      }];
    }
    if (![404, 403].includes(monthly.status)) {
      throw new Error('BINANCE_MONTHLY_HEAD_FAILED:' + symbol + ':' + month.key + ':' + monthly.status);
    }
    const dailyStart = Math.max(start, month.start);
    const dailyEnd = Math.min(end, month.end);
    const dailyFiles = dayKeys(dailyStart, dailyEnd);
    if (!dailyFiles.length) throw new Error('BINANCE_DAILY_FALLBACK_EMPTY:' + symbol + ':' + month.key);
    return mapConcurrent(dailyFiles, 4, async day => {
      const dailyUrl = 'https://data.binance.vision/data/futures/um/daily/aggTrades/'
        + symbol + '/' + symbol + '-aggTrades-' + day.key + '.zip';
      const daily = await headImpl(dailyUrl);
      if (daily.status !== 200 || daily.bytes <= 0) {
        throw new Error('BINANCE_DAILY_PARTITION_MISSING:' + symbol + ':' + day.key + ':' + daily.status);
      }
      const checksum = await checksumImpl(dailyUrl);
      return {
        symbol,
        cadence: 'daily',
        period: day.key,
        url: dailyUrl,
        bytes: daily.bytes,
        lastModified: daily.lastModified ?? null,
        etag: daily.etag ?? null,
        checksumUrl: checksum.checksumUrl,
        sha256: checksum.sha256
      };
    });
  });
  return perPartition.flat();
}

export async function downloadAndVerifyArchive(file, {
  root = path.resolve(process.cwd(), '..', 'data', 'cache', HY_EXP_0040, 'download'),
  ...options
} = {}) {
  return downloadArchiveWithResume(file, {
    root,
    chunkBytes: DEFAULT_CHUNK_BYTES,
    concurrency: DEFAULT_HTTP_CONCURRENCY,
    ...options
  });
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const result = await handle.read(buffer, 0, length, position);
  if (result.bytesRead !== length) throw new Error('ZIP_READ_TRUNCATED:' + position + ':' + length);
  return buffer;
}

function findSignature(buffer, signature) {
  for (let index = buffer.length - 4; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === signature) return index;
  }
  return -1;
}

function parseZip64Extra(extra, values) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const type = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const payload = extra.subarray(offset + 4, offset + 4 + size);
    if (type === 0x0001) {
      let cursor = 0;
      if (values.uncompressedSize === 0xffffffff && cursor + 8 <= payload.length) {
        values.uncompressedSize = Number(payload.readBigUInt64LE(cursor)); cursor += 8;
      }
      if (values.compressedSize === 0xffffffff && cursor + 8 <= payload.length) {
        values.compressedSize = Number(payload.readBigUInt64LE(cursor)); cursor += 8;
      }
      if (values.localOffset === 0xffffffff && cursor + 8 <= payload.length) {
        values.localOffset = Number(payload.readBigUInt64LE(cursor)); cursor += 8;
      }
    }
    offset += 4 + size;
  }
}

async function zipMemberInfo(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    const tailLength = Math.min(stat.size, 131_072);
    const tail = await readAt(handle, stat.size - tailLength, tailLength);
    const eocdLocal = findSignature(tail, ZIP_EOCD);
    if (eocdLocal < 0) throw new Error('ZIP_EOCD_MISSING');
    const eocd = stat.size - tailLength + eocdLocal;
    let entries = tail.readUInt16LE(eocdLocal + 10);
    let centralOffset = tail.readUInt32LE(eocdLocal + 16);
    if (entries === 0xffff || centralOffset === 0xffffffff) {
      const locator = await readAt(handle, eocd - 20, 20);
      if (locator.readUInt32LE(0) !== ZIP64_LOCATOR) throw new Error('ZIP64_LOCATOR_MISSING');
      const zip64Offset = Number(locator.readBigUInt64LE(8));
      const header = await readAt(handle, zip64Offset, 56);
      if (header.readUInt32LE(0) !== ZIP64_EOCD) throw new Error('ZIP64_EOCD_MISSING');
      entries = Number(header.readBigUInt64LE(32));
      centralOffset = Number(header.readBigUInt64LE(48));
    }
    if (entries !== 1) throw new Error('ZIP_EXPECTED_ONE_MEMBER:' + entries);
    const central = await readAt(handle, centralOffset, 46);
    if (central.readUInt32LE(0) !== ZIP_CENTRAL) throw new Error('ZIP_CENTRAL_MISSING');
    const nameLength = central.readUInt16LE(28);
    const extraLength = central.readUInt16LE(30);
    const commentLength = central.readUInt16LE(32);
    const extra = await readAt(handle, centralOffset + 46 + nameLength, extraLength);
    const values = {
      method: central.readUInt16LE(10),
      crc: central.readUInt32LE(16),
      compressedSize: central.readUInt32LE(20),
      uncompressedSize: central.readUInt32LE(24),
      localOffset: central.readUInt32LE(42)
    };
    parseZip64Extra(extra, values);
    const local = await readAt(handle, values.localOffset, 30);
    if (local.readUInt32LE(0) !== ZIP_LOCAL) throw new Error('ZIP_LOCAL_MISSING');
    const localNameLength = local.readUInt16LE(26);
    const localExtraLength = local.readUInt16LE(28);
    return {
      method: values.method,
      crc: values.crc,
      compressedSize: values.compressedSize,
      uncompressedSize: values.uncompressedSize,
      dataStart: values.localOffset + 30 + localNameLength + localExtraLength,
      commentLength
    };
  } finally {
    await handle.close();
  }
}

async function streamZipCsv(file, onLine) {
  const member = await zipMemberInfo(file);
  if (![0, 8].includes(member.method)) throw new Error('ZIP_UNSUPPORTED_METHOD:' + member.method);
  const input = fs.createReadStream(file, {
    start: member.dataStart,
    end: member.dataStart + member.compressedSize - 1
  });
  const decoded = member.method === 8 ? input.pipe(createInflateRaw()) : input;
  let text = '';
  let crc = 0xffffffff;
  let uncompressedBytes = 0;
  for await (const chunk of decoded) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    crc = crc32Update(crc, buffer);
    uncompressedBytes += buffer.length;
    text += buffer.toString('utf8');
    const lines = text.split(/\r?\n/);
    text = lines.pop() ?? '';
    for (const line of lines) await onLine(line);
  }
  if (text) await onLine(text);
  if (uncompressedBytes !== member.uncompressedSize) throw new Error('ZIP_UNCOMPRESSED_SIZE_MISMATCH');
  if ((crc ^ 0xffffffff) >>> 0 !== member.crc) throw new Error('ZIP_CRC_MISMATCH');
}

function parseBoolean(value) {
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error('AGGTRADE_MAKER_FLAG_INVALID:' + value);
}

export function parseAggTradeCsvLine(line, label = 'aggTrade') {
  const values = String(line).trim().split(',');
  if (!values.length || !values[0] || !Number.isInteger(Number(values[0]))) return null;
  if (values.length < 7) throw new Error(label + ':TOO_FEW_FIELDS');
  const aggregateTradeId = Number(values[0]);
  const price = Number(values[1]);
  const quantity = Number(values[2]);
  const firstTradeId = Number(values[3]);
  const lastTradeId = Number(values[4]);
  const timestamp = Number(values[5]);
  const isBuyerMaker = parseBoolean(values[6].toLowerCase());
  for (const [name, value] of Object.entries({ aggregateTradeId, price, quantity, firstTradeId, lastTradeId, timestamp })) {
    if (!finite(value)) throw new Error(label + ':NON_FINITE_' + name);
  }
  if (!(aggregateTradeId >= 0) || !(price > 0) || !(quantity > 0)
    || !(firstTradeId >= 0) || !(lastTradeId >= firstTradeId) || !(timestamp >= 0)) {
    throw new Error(label + ':INVALID_NATIVE_VALUES');
  }
  return {
    aggregateTradeId,
    firstTradeId,
    lastTradeId,
    price,
    quantity,
    timestamp,
    isBuyerMaker,
    aggressorSide: isBuyerMaker ? 'SELL' : 'BUY',
    quoteNotional: price * quantity
  };
}

function parseAggTradeCsvLineLegacy(line, label = 'aggTrade') {
  const values = String(line).trim().split(',');
  if (!values.length || !values[0] || !/^-?\\d+$/.test(values[0])) return null;
  if (values.length < 7) throw new Error(label + ':TOO_FEW_FIELDS');
  const aggregateTradeId = Number(values[0]);
  const price = Number(values[1]);
  const quantity = Number(values[2]);
  const firstTradeId = Number(values[3]);
  const lastTradeId = Number(values[4]);
  const timestamp = Number(values[5]);
  const isBuyerMaker = parseBoolean(values[6].toLowerCase());
  for (const [name, value] of Object.entries({ aggregateTradeId, price, quantity, firstTradeId, lastTradeId, timestamp })) {
    if (!finite(value)) throw new Error(label + ':NON_FINITE_' + name);
  }
  if (!(aggregateTradeId >= 0) || !(price > 0) || !(quantity > 0)
    || !(firstTradeId >= 0) || !(lastTradeId >= firstTradeId) || !(timestamp >= 0)) {
    throw new Error(label + ':INVALID_NATIVE_VALUES');
  }
  return {
    aggregateTradeId,
    firstTradeId,
    lastTradeId,
    price,
    quantity,
    timestamp,
    isBuyerMaker,
    aggressorSide: isBuyerMaker ? 'SELL' : 'BUY',
    quoteNotional: price * quantity
  };
}

export function validateNativeAggTradeRows(rows, label = 'aggTrade') {
  let previous = null;
  for (const row of rows) {
    if (!row || !finite(row.aggregateTradeId) || !finite(row.timestamp)
      || !finite(row.price) || !finite(row.quantity)) throw new Error(label + ':NON_FINITE');
    if (previous && row.aggregateTradeId <= previous.aggregateTradeId) {
      throw new Error(label + ':DUPLICATE_OR_OUT_OF_ORDER_ID');
    }
    if (previous && row.timestamp < previous.timestamp) throw new Error(label + ':TIMESTAMP_REVERSED');
    previous = row;
  }
  return { rows: rows.length, status: 'PASS' };
}

export async function parseAggTradeArchive(file, {
  symbol,
  start = WINDOW_START,
  end = WINDOW_END,
  previous = null,
  onTrade = () => {}
} = {}) {
  let last = previous;
  let rows = 0;
  let inWindow = 0;
  await streamZipCsv(file, async line => {
    const row = parseAggTradeCsvLine(line, symbol + '/aggTrade');
    if (!row) return;
    rows += 1;
    if (last && row.aggregateTradeId <= last.aggregateTradeId) {
      throw new Error(symbol + ':AGGTRADE_ID_NOT_STRICTLY_INCREASING:' + row.aggregateTradeId);
    }
    if (last && row.timestamp < last.timestamp) {
      throw new Error(symbol + ':AGGTRADE_TIMESTAMP_REVERSED:' + row.timestamp);
    }
    last = row;
    if (row.timestamp >= start && row.timestamp < end) {
      inWindow += 1;
      await onTrade(row);
    }
  });
  return { rows, inWindow, last };
}

class MaxHeap {
  constructor() { this.rows = []; }
  compare(left, right) { return left.value > right.value; }
  push(row) {
    this.rows.push(row);
    let index = this.rows.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.rows[parent], this.rows[index])) break;
      [this.rows[parent], this.rows[index]] = [this.rows[index], this.rows[parent]];
      index = parent;
    }
  }
  pop() {
    const result = this.rows[0];
    const last = this.rows.pop();
    if (last && this.rows.length) {
      this.rows[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let best = index;
        if (left < this.rows.length && !this.compare(this.rows[best], this.rows[left])) best = left;
        if (right < this.rows.length && !this.compare(this.rows[best], this.rows[right])) best = right;
        if (best === index) break;
        [this.rows[best], this.rows[index]] = [this.rows[index], this.rows[best]];
        index = best;
      }
    }
    return result;
  }
  peek() { return this.rows[0] ?? null; }
}

class MinHeap extends MaxHeap {
  compare(left, right) { return left.value < right.value; }
}

class RollingP95 {
  constructor() {
    this.lower = new MaxHeap();
    this.upper = new MinHeap();
    this.where = new Map();
    this.queue = [];
    this.queueHead = 0;
    this.count = 0;
    this.lowerCount = 0;
    this.upperCount = 0;
    this.nextId = 1;
  }
  clean(heap, side) {
    while (heap.peek() && this.where.get(heap.peek().id) !== side) heap.pop();
  }
  rebalance() {
    const targetLower = Math.ceil(this.count * 0.95);
    this.clean(this.lower, 'lower');
    this.clean(this.upper, 'upper');
    while (this.lowerCount > targetLower) {
      const row = this.lower.pop();
      if (!row || this.where.get(row.id) !== 'lower') continue;
      this.where.set(row.id, 'upper');
      this.lowerCount -= 1;
      this.upperCount += 1;
      this.upper.push(row);
      this.clean(this.lower, 'lower');
    }
    while (this.lowerCount < targetLower && this.upper.peek()) {
      const row = this.upper.pop();
      if (!row || this.where.get(row.id) !== 'upper') continue;
      this.where.set(row.id, 'lower');
      this.upperCount -= 1;
      this.lowerCount += 1;
      this.lower.push(row);
      this.clean(this.upper, 'upper');
    }
  }
  add(time, value) {
    const row = { id: this.nextId++, time, value };
    this.queue.push(row);
    const lowerTop = this.lower.peek();
    if (!lowerTop || value <= lowerTop.value) {
      this.where.set(row.id, 'lower'); this.lowerCount += 1; this.lower.push(row);
    } else {
      this.where.set(row.id, 'upper'); this.upperCount += 1; this.upper.push(row);
    }
    this.count += 1;
    this.rebalance();
  }
  removeBefore(cutoff) {
    while (this.queueHead < this.queue.length && this.queue[this.queueHead].time < cutoff) {
      const row = this.queue[this.queueHead];
      this.queueHead += 1;
      const side = this.where.get(row.id);
      if (side === 'lower') this.lowerCount -= 1;
      if (side === 'upper') this.upperCount -= 1;
      this.where.delete(row.id);
      this.count -= 1;
    }
    if (this.queueHead > 100_000 && this.queueHead * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.queueHead);
      this.queueHead = 0;
    }
    this.rebalance();
  }
  value() {
    this.clean(this.lower, 'lower');
    return this.count > 0 ? this.lower.peek()?.value ?? null : null;
  }
  snapshot() {
    return {
      rows: this.queue.slice(this.queueHead).map(row => ({ time: row.time, value: row.value }))
    };
  }
}

export function serializeAggTradeRollingCheckpoint({
  symbol,
  lastTrade,
  CVD,
  rolling,
  lastCompletedMinute,
  derivedFileOffset,
  derivedFileSha256,
  bucketCount,
  validBucketCount,
  missingBucketCount,
  archiveKey,
  archiveRows,
  archiveRowsInWindow
} = {}) {
  return {
    schemaVersion: 1,
    symbol,
    lastAggregateTradeId: lastTrade?.aggregateTradeId ?? null,
    lastTimestamp: lastTrade?.timestamp ?? null,
    lastTrade: lastTrade ?? null,
    CVD,
    prior24hTradeDistribution: rolling?.snapshot?.() ?? { rows: [] },
    lastCompletedMinute: lastCompletedMinute ?? null,
    derivedFileOffset,
    derivedFileSha256,
    bucketCount,
    validBucketCount,
    missingBucketCount,
    archiveRows,
    archiveRowsInWindow,
    archiveKey: archiveKey ?? null
  };
}

export function restoreAggTradeRollingCheckpoint(checkpoint = {}) {
  const rolling = new RollingP95();
  for (const row of checkpoint.prior24hTradeDistribution?.rows ?? []) {
    if (finite(row.time) && finite(row.value) && row.value >= 0) rolling.add(row.time, row.value);
  }
  return {
    rolling,
    lastTrade: checkpoint.lastTrade ?? null,
    CVD: finite(checkpoint.CVD) ? checkpoint.CVD : 0,
    lastCompletedMinute: checkpoint.lastCompletedMinute ?? null
  };
}

function emptyBucket(openTime) {
  return {
    openTime,
    closeTime: openTime + MINUTE,
    missing: true,
    buyNotional: null,
    sellNotional: null,
    buyQty: null,
    sellQty: null,
    buyTradeCount: null,
    sellTradeCount: null,
    totalNotional: null,
    totalTrades: null,
    signedNotional: null,
    CVD: null,
    largeBuyNotional: null,
    largeSellNotional: null,
    largeTradeImbalance: null,
    largeThresholdP95: null,
    largeThresholdReady: false
  };
}

function createBucket(openTime, threshold, thresholdReady, cvd) {
  return {
    openTime,
    closeTime: openTime + MINUTE,
    missing: false,
    buyNotional: 0,
    sellNotional: 0,
    buyQty: 0,
    sellQty: 0,
    buyTradeCount: 0,
    sellTradeCount: 0,
    totalNotional: 0,
    totalTrades: 0,
    signedNotional: 0,
    CVD: cvd,
    largeBuyNotional: 0,
    largeSellNotional: 0,
    largeTradeImbalance: 0,
    largeThresholdP95: threshold,
    largeThresholdReady: thresholdReady,
    _trades: []
  };
}

function finalizeBucket(bucket, rolling, writer) {
  for (const trade of bucket._trades) rolling.add(trade.timestamp, trade.quoteNotional);
  delete bucket._trades;
  if (bucket.totalNotional > 0) {
    bucket.largeTradeImbalance = (bucket.largeBuyNotional - bucket.largeSellNotional)
      / (bucket.largeBuyNotional + bucket.largeSellNotional || 1);
  }
  return writer.write(bucket);
}

async function createGzipWriter(file) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const output = fs.createWriteStream(file, { flags: 'w' });
  const gzip = createGzip({ level: 6 });
  gzip.pipe(output);
  return {
    async write(value) {
      if (!gzip.write(JSON.stringify(value) + '\\n')) await new Promise(resolve => gzip.once('drain', resolve));
    },
    async close() {
      gzip.end();
      await finished(output);
    }
  };
}

async function createGzipWriterCorrect(file, { append = false } = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const output = fs.createWriteStream(file, { flags: append ? 'a' : 'w' });
  const gzip = createGzip({ level: 6 });
  gzip.pipe(output);
  return {
    async write(value) {
      if (!gzip.write(JSON.stringify(value) + String.fromCharCode(10))) {
        await new Promise(resolve => gzip.once('drain', resolve));
      }
    },
    async close() {
      gzip.end();
      await finished(output);
    },
    async checkpoint() {
      await new Promise((resolve, reject) => gzip.flush(error => error ? reject(error) : resolve()));
      return { bytes: fs.statSync(file).size, sha256: sha256File(file) };
    }
  };
}

export async function processAggTradeArchives({
  symbol,
  archives,
  outputPath,
  start = WINDOW_START,
  end = WINDOW_END,
  checkpointRoot = null,
  downloadOptions = {},
  onPartitionState = async () => {}
} = {}) {
  const sortedArchives = archives.slice().sort((left, right) => left.period.localeCompare(right.period));
  const downloadRoot = checkpointRoot ?? downloadOptions.root ?? path.resolve(process.cwd(), '..', 'data', 'cache', HY_EXP_0040, 'download');
  const checkpointPath = path.join(downloadRoot, symbol + '.rolling-state.json');
  const committed = sortedArchives.filter(archive => isPartitionSkipEligible(archive, downloadRoot));
  const latestCommitted = committed.at(-1) ? loadPartitionState(committed.at(-1), downloadRoot) : null;
  const savedCheckpoint = latestCommitted?.checkpoint ?? (() => {
    try { return JSON.parse(fs.readFileSync(checkpointPath, 'utf8')); } catch { return null; }
  })();
  if (savedCheckpoint?.derivedFileOffset != null && fs.existsSync(outputPath)) {
    const currentSize = fs.statSync(outputPath).size;
    if (currentSize < savedCheckpoint.derivedFileOffset) throw new Error('DERIVED_CHECKPOINT_OUTPUT_TRUNCATED');
    fs.truncateSync(outputPath, savedCheckpoint.derivedFileOffset);
  }
  const writer = await createGzipWriterCorrect(outputPath, { append: Boolean(savedCheckpoint && fs.existsSync(outputPath)) });
  const restored = restoreAggTradeRollingCheckpoint(savedCheckpoint ?? {});
  const rolling = restored.rolling;
  const firstOpen = Math.floor(start / MINUTE) * MINUTE;
  let current = null;
  let previous = restored.lastTrade;
  let cvd = restored.CVD;
  let lastCompletedMinute = restored.lastCompletedMinute;
  let bucketCount = savedCheckpoint?.bucketCount ?? 0;
  let validBucketCount = savedCheckpoint?.validBucketCount ?? 0;
  let missingBucketCount = savedCheckpoint?.missingBucketCount ?? 0;
  let archiveRows = savedCheckpoint?.archiveRows ?? 0;
  let archiveRowsInWindow = savedCheckpoint?.archiveRowsInWindow ?? 0;
  async function writeMissing(openTime) {
    await writer.write(emptyBucket(openTime));
    bucketCount += 1;
    missingBucketCount += 1;
  }
  async function startBucket(openTime) {
    rolling.removeBefore(openTime - DAY);
    const threshold = openTime >= start + DAY ? rolling.value() : null;
    return createBucket(openTime, threshold, threshold != null && rolling.count > 0, cvd);
  }
  async function flushCurrent() {
    if (!current) return;
    lastCompletedMinute = current.openTime;
    cvd += current.signedNotional;
    current.CVD = cvd;
    await finalizeBucket(current, rolling, writer);
    bucketCount += 1;
    validBucketCount += 1;
    current = null;
  }
  async function consumeTrade(trade) {
    const openTime = Math.floor(trade.timestamp / MINUTE) * MINUTE;
    if (!current) {
      for (let cursor = firstOpen; cursor < openTime; cursor += MINUTE) await writeMissing(cursor);
      current = await startBucket(openTime);
    } else if (openTime !== current.openTime) {
      const previousOpen = current.openTime;
      await flushCurrent();
      for (let cursor = previousOpen + MINUTE; cursor < openTime; cursor += MINUTE) {
        await writeMissing(cursor);
      }
      current = await startBucket(openTime);
    }
    if (trade.aggressorSide === 'BUY') {
      current.buyNotional += trade.quoteNotional;
      current.buyQty += trade.quantity;
      current.buyTradeCount += 1;
    } else {
      current.sellNotional += trade.quoteNotional;
      current.sellQty += trade.quantity;
      current.sellTradeCount += 1;
    }
    current.totalNotional += trade.quoteNotional;
    current.totalTrades += 1;
    current.signedNotional += trade.isBuyerMaker ? -trade.quoteNotional : trade.quoteNotional;
    current._trades.push(trade);
    if (current.largeThresholdReady && trade.quoteNotional >= current.largeThresholdP95) {
      if (trade.aggressorSide === 'BUY') current.largeBuyNotional += trade.quoteNotional;
      else current.largeSellNotional += trade.quoteNotional;
    }
  }
  try {
    for (const archive of sortedArchives) {
      const archiveKey = archive.cadence + ':' + archive.period;
      if (committed.some(row => row.cadence + ':' + row.period === archiveKey)) continue;
      const downloaded = await downloadAndVerifyArchive(archive, downloadOptions);
      const parsed = await parseAggTradeArchive(downloaded.path, {
        symbol,
        start,
        end,
        previous,
        onTrade: consumeTrade
      });
      archiveRows += parsed.rows;
      archiveRowsInWindow += parsed.inWindow;
      previous = parsed.last;
      await flushCurrent();
      const checkpoint = await writer.checkpoint();
      const rollingCheckpoint = serializeAggTradeRollingCheckpoint({
        symbol,
        lastTrade: previous,
        CVD: cvd,
        rolling,
        lastCompletedMinute,
        derivedFileOffset: checkpoint.bytes,
        derivedFileSha256: checkpoint.sha256,
        bucketCount,
        validBucketCount,
        missingBucketCount,
        archiveRows,
        archiveRowsInWindow,
        archiveKey
      });
      await markPartitionParsed(archive, {
        root: downloadRoot,
        derivedFileOffset: checkpoint.bytes,
        derivedFileSha256: checkpoint.sha256,
        now: Date.now()
      });
      await commitDerivedPartition(archive, {
        root: downloadRoot,
        derivedFileOffset: checkpoint.bytes,
        derivedFileSha256: checkpoint.sha256,
        spoolController: downloadOptions.spoolController,
        now: Date.now(),
        checkpoint: rollingCheckpoint
      });
      fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
      fs.writeFileSync(checkpointPath, JSON.stringify(rollingCheckpoint, null, 2) + '\n');
      await onPartitionState(archive, loadPartitionState(archive, downloadRoot));
    }
    await flushCurrent();
    const lastOpen = Math.ceil(end / MINUTE) * MINUTE - MINUTE;
    const lastWritten = bucketCount ? firstOpen + (bucketCount - 1) * MINUTE : firstOpen - MINUTE;
    for (let cursor = lastWritten + MINUTE; cursor <= lastOpen; cursor += MINUTE) await writeMissing(cursor);
    await writer.close();
  } catch (error) {
    try { await writer.close(); } catch {}
    throw error;
  }
  return {
    symbol,
    start: iso(firstOpen),
    endExclusive: iso(end),
    expectedMinuteBuckets: Math.round((end - firstOpen) / MINUTE),
    bucketCount,
    validBucketCount,
    missingBucketCount,
    coverageRatio: bucketCount ? validBucketCount / bucketCount : 0,
    archiveRows,
    archiveRowsInWindow,
    path: outputPath,
    sha256: sha256File(outputPath)
  };
}

async function readGzipLines(file, onLine) {
  const input = fs.createReadStream(file).pipe(createGunzip());
  let text = '';
  for await (const chunk of input) {
    text += chunk.toString('utf8');
    const lines = text.split(/\\r?\\n/);
    text = lines.pop() ?? '';
    for (const line of lines) if (line) await onLine(line);
  }
  if (text) await onLine(text);
}

async function readGzipLinesCorrect(file, onLine) {
  const input = fs.createReadStream(file).pipe(createGunzip());
  let text = '';
  for await (const chunk of input) {
    text += chunk.toString('utf8');
    const lines = text.split(String.fromCharCode(10));
    text = lines.pop() ?? '';
    for (const line of lines) if (line) await onLine(line.replace(/\r$/, ''));
  }
  if (text) await onLine(text.replace(/\r$/, ''));
}

export async function readDerivedBuckets(file) {
  const rows = [];
  await readGzipLinesCorrect(file, line => {
    const row = JSON.parse(line);
    if (!finite(row.openTime) || !finite(row.closeTime) || row.closeTime !== row.openTime + MINUTE) {
      throw new Error('DERIVED_BUCKET_BOUNDARY_INVALID');
    }
    if (rows.length && row.openTime !== rows[rows.length - 1].openTime + MINUTE) {
      throw new Error('DERIVED_BUCKET_TIMELINE_GAP');
    }
    rows.push(row);
  });
  return rows;
}

function lowerBound(rows, time, field = 'openTime') {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle][field] < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function lastCompleted(rows, decisionTime) {
  let index = lowerBound(rows, decisionTime, 'closeTime') - 1;
  if (index < 0 || rows[index].closeTime >= decisionTime) return -1;
  return index;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sampleStd(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function logReturn(rows, index, lookback) {
  if (index < lookback || !(rows[index - lookback].close > 0) || !(rows[index].close > 0)) return null;
  return Math.log(rows[index].close / rows[index - lookback].close);
}

function atr(rows, index, period) {
  if (index < period) return null;
  const values = [];
  for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
    const previous = rows[cursor - 1].close;
    values.push(Math.max(rows[cursor].high - rows[cursor].low,
      Math.abs(rows[cursor].high - previous), Math.abs(rows[cursor].low - previous)));
  }
  return mean(values);
}

function sumWindow(buckets, endIndex, length, field) {
  const start = endIndex - length + 1;
  if (start < 0) return null;
  const rows = buckets.slice(start, endIndex + 1);
  if (rows.length !== length || rows.some(row => row.missing || !finite(row[field]))) return null;
  return rows.reduce((sum, row) => sum + row[field], 0);
}

function cvdChange(buckets, endIndex, length) {
  const start = endIndex - length + 1;
  if (start < 0 || buckets.slice(start, endIndex + 1).some(row => row.missing || !finite(row.CVD))) return null;
  const before = start > 0 ? buckets[start - 1] : null;
  if (!before || before.missing || !finite(before.CVD)) return null;
  return buckets[endIndex].CVD - before.CVD;
}

function imbalance(buy, sell) {
  if (buy == null || sell == null || !finite(buy) || !finite(sell)) return null;
  return (buy - sell) / (buy + sell || 1);
}

function ratioChange(current, prior) {
  if (!finite(current) || !finite(prior)) return null;
  return current / (prior || 1) - 1;
}

function contextFor(series, symbol, decisionTime) {
  const current = series[symbol];
  const oneIndex = lastCompleted(current.contract1, decisionTime);
  const fourIndex = lastCompleted(current.contract4, decisionTime);
  if (oneIndex < 20 || fourIndex < 180) return null;
  const one = current.contract1[oneIndex];
  const four = current.contract4[fourIndex];
  const atr20 = atr(current.contract1, oneIndex, 20);
  const oneReturns = [];
  for (let index = Math.max(1, oneIndex - 19); index <= oneIndex; index += 1) {
    const value = logReturn(current.contract1, index, 1);
    if (value == null) return null;
    oneReturns.push(value);
  }
  const funding = current.funding.filter(row => row.eventTime <= decisionTime).at(-1);
  const mark = current.mark1ByTime.get(one.openTime);
  const btc = series.BTCUSDT;
  const btcIndex = lastCompleted(btc.contract4, decisionTime);
  const btcReturn = btcIndex >= 6 ? logReturn(btc.contract4, btcIndex, 6) : null;
  const slow = mean(current.contract4.slice(fourIndex - 179, fourIndex + 1).map(row => row.close));
  const breadth = FIXED_SYMBOLS.map(candidateSymbol => {
    const candidate = series[candidateSymbol];
    const index = candidate.contract4ByTime.get(four.openTime);
    if (index == null || index < 180) return null;
    const average = mean(candidate.contract4.slice(index - 179, index + 1).map(row => row.close));
    return candidate.contract4[index].close > average ? 1 : -1;
  });
  if (breadth.some(value => value == null) || !finite(atr20) || !mark || !funding || btcReturn == null) return null;
  return {
    atrPercent: atr20 / one.close,
    realizedVolatility1h: sampleStd(oneReturns) * Math.sqrt(24),
    fundingRate: funding.fundingRate,
    markContractBasisBps: 10_000 * (one.close - mark.close) / mark.close,
    btcReturn4h: btcReturn,
    btcRegime: breadth.reduce((sum, value) => sum + value, 0) / breadth.length,
    regimeName: btc.contract4[btcIndex].close > mean(btc.contract4.slice(btcIndex - 179, btcIndex + 1).map(row => row.close))
      ? 'BULL' : 'BEAR',
    oneIndex,
    fourIndex,
    atr20,
    slow
  };
}

export function buildFlowFeatures({ buckets, bucketIndex, series, symbol, decisionTime, side }) {
  const context = contextFor(series, symbol, decisionTime);
  const one = sumWindow(buckets, bucketIndex, 1, 'totalNotional');
  const five = sumWindow(buckets, bucketIndex, 5, 'totalNotional');
  const fifteen = sumWindow(buckets, bucketIndex, 15, 'totalNotional');
  const hour = sumWindow(buckets, bucketIndex, 60, 'totalNotional');
  const totalTrades1 = sumWindow(buckets, bucketIndex, 1, 'totalTrades');
  const totalTrades5 = sumWindow(buckets, bucketIndex, 5, 'totalTrades');
  const totalTrades15 = sumWindow(buckets, bucketIndex, 15, 'totalTrades');
  const totalTrades60 = sumWindow(buckets, bucketIndex, 60, 'totalTrades');
  const totalTrades24 = sumWindow(buckets, bucketIndex, 1440, 'totalTrades');
  const totalNotional24 = sumWindow(buckets, bucketIndex, 1440, 'totalNotional');
  const signed5 = sumWindow(buckets, bucketIndex, 5, 'signedNotional');
  const signed15 = sumWindow(buckets, bucketIndex, 15, 'signedNotional');
  const signed60 = sumWindow(buckets, bucketIndex, 60, 'signedNotional');
  const cvd5 = cvdChange(buckets, bucketIndex, 5);
  const cvd15 = cvdChange(buckets, bucketIndex, 15);
  const cvd60 = cvdChange(buckets, bucketIndex, 60);
  const fields = [
    ['buySellNotionalImbalance1m', imbalance(sumWindow(buckets, bucketIndex, 1, 'buyNotional'), sumWindow(buckets, bucketIndex, 1, 'sellNotional'))],
    ['buySellNotionalImbalance5m', imbalance(sumWindow(buckets, bucketIndex, 5, 'buyNotional'), sumWindow(buckets, bucketIndex, 5, 'sellNotional'))],
    ['buySellNotionalImbalance15m', imbalance(sumWindow(buckets, bucketIndex, 15, 'buyNotional'), sumWindow(buckets, bucketIndex, 15, 'sellNotional'))],
    ['buySellNotionalImbalance1h', imbalance(sumWindow(buckets, bucketIndex, 60, 'buyNotional'), sumWindow(buckets, bucketIndex, 60, 'sellNotional'))],
    ['tradeCountImbalance1m', imbalance(sumWindow(buckets, bucketIndex, 1, 'buyTradeCount'), sumWindow(buckets, bucketIndex, 1, 'sellTradeCount'))],
    ['tradeCountImbalance5m', imbalance(sumWindow(buckets, bucketIndex, 5, 'buyTradeCount'), sumWindow(buckets, bucketIndex, 5, 'sellTradeCount'))],
    ['tradeCountImbalance15m', imbalance(sumWindow(buckets, bucketIndex, 15, 'buyTradeCount'), sumWindow(buckets, bucketIndex, 15, 'sellTradeCount'))],
    ['tradeCountImbalance1h', imbalance(sumWindow(buckets, bucketIndex, 60, 'buyTradeCount'), sumWindow(buckets, bucketIndex, 60, 'sellTradeCount'))],
    ['signedNotional5m', signed5 == null || five == null ? null : signed5 / (five || 1)],
    ['signedNotional15m', signed15 == null || fifteen == null ? null : signed15 / (fifteen || 1)],
    ['signedNotional1h', signed60 == null || hour == null ? null : signed60 / (hour || 1)],
    ['CVDChange5m', cvd5 == null || five == null ? null : cvd5 / (five || 1)],
    ['CVDChange15m', cvd15 == null || fifteen == null ? null : cvd15 / (fifteen || 1)],
    ['CVDChange1h', cvd60 == null || hour == null ? null : cvd60 / (hour || 1)],
    ['tradeIntensity1m', totalTrades1 == null ? null : Math.log1p(totalTrades1)],
    ['tradeIntensity5m', totalTrades5 == null ? null : Math.log1p(totalTrades5 / 5)],
    ['tradeIntensity15m', totalTrades15 == null ? null : Math.log1p(totalTrades15 / 15)],
    ['notionalIntensity1m', one == null ? null : Math.log1p(one)],
    ['notionalIntensity5m', five == null ? null : Math.log1p(five / 5)],
    ['notionalIntensity15m', fifteen == null ? null : Math.log1p(fifteen / 15)],
    ['relativeTradeIntensity24h', totalTrades1 == null || totalTrades24 == null ? null : ratioChange(totalTrades1, totalTrades24 / 1440)],
    ['relativeNotionalIntensity24h', one == null || totalNotional24 == null ? null : ratioChange(one, totalNotional24 / 1440)],
    ['largeTradeImbalance5m', imbalance(sumWindow(buckets, bucketIndex, 5, 'largeBuyNotional'), sumWindow(buckets, bucketIndex, 5, 'largeSellNotional'))],
    ['largeTradeImbalance15m', imbalance(sumWindow(buckets, bucketIndex, 15, 'largeBuyNotional'), sumWindow(buckets, bucketIndex, 15, 'largeSellNotional'))],
    ['largeTradeImbalance1h', imbalance(sumWindow(buckets, bucketIndex, 60, 'largeBuyNotional'), sumWindow(buckets, bucketIndex, 60, 'largeSellNotional'))],
    ['flowAcceleration1mVsPrior5m', totalTrades1 == null || totalTrades5 == null ? null : ratioChange(totalTrades1, totalTrades5 / 5)],
    ['flowAcceleration5mVsPrior1h', totalTrades5 == null || totalTrades60 == null ? null : ratioChange(totalTrades5 / 5, totalTrades60 / 60)],
    ['priceImpactProxy', signed5 == null || signed5 === 0 || five == null ? 0 : (logReturn(series[symbol].contract5, lastCompleted(series[symbol].contract5, decisionTime), 1) ?? 0) / signed5],
    ['CVDPriceDivergence', cvd15 == null || fifteen == null ? null : (cvd15 / (fifteen || 1)) * ((logReturn(series[symbol].contract15, lastCompleted(series[symbol].contract15, decisionTime), 1) ?? 0) - cvd15 / (fifteen || 1))],
    ['aggressiveBuyExhaustionProxy', signed15 == null || fifteen == null ? null : Math.max(0, -signed15 / (fifteen || 1))],
    ['aggressiveSellExhaustionProxy', signed15 == null || fifteen == null ? null : Math.max(0, signed15 / (fifteen || 1))],
    ['absorptionBuyProxy', signed15 == null || fifteen == null ? null : Math.max(0, -signed15 / (fifteen || 1)) * Math.log1p(fifteen || 0)],
    ['absorptionSellProxy', signed15 == null || fifteen == null ? null : Math.max(0, signed15 / (fifteen || 1)) * Math.log1p(fifteen || 0)],
    ['atrPercent', context?.atrPercent ?? null],
    ['realizedVolatility1h', context?.realizedVolatility1h ?? null],
    ['fundingRate', context?.fundingRate ?? null],
    ['markContractBasisBps', context?.markContractBasisBps ?? null],
    ['btcReturn4h', context?.btcReturn4h ?? null],
    ['btcRegime', context?.btcRegime ?? null],
    ['sideSign', side === 'BUY' ? 1 : -1]
  ];
  if (!context || fields.some(([, value]) => !finite(value))) return null;
  const values = fields.map(([, value]) => value);
  return { values, named: Object.fromEntries(fields), context };
}

export function generateAggTradeCandidates({ symbol, buckets, series, start = WINDOW_START, end = WINDOW_END } = {}) {
  const reference = series[symbol];
  const expectedDecisionTimes = [];
  const candidates = [];
  let featureInvalid = 0;
  for (const bar of reference.contract15) {
    const decisionTime = bar.closeTime + 1;
    if (decisionTime < start || decisionTime >= end) continue;
    expectedDecisionTimes.push(decisionTime);
    const bucketIndex = Math.floor((decisionTime - start) / MINUTE) - 1;
    if (bucketIndex < 0 || bucketIndex >= buckets.length || buckets[bucketIndex].openTime !== start + (bucketIndex * MINUTE)) {
      featureInvalid += 2;
      continue;
    }
    for (const side of ['BUY', 'SELL']) {
      const snapshot = buildFlowFeatures({ buckets, bucketIndex, series, symbol, decisionTime, side });
      if (!snapshot) { featureInvalid += 1; continue; }
      const candidate = {
        candidateId: HY_EXP_0040 + ':' + symbol + ':' + side + ':' + decisionTime,
        experimentId: HY_EXP_0040,
        symbol,
        side,
        regime: snapshot.named.btcRegime > 0.25 ? 'BULL' : snapshot.named.btcRegime < -0.25 ? 'BEAR' : 'SIDEWAYS',
        regimeBreadth: snapshot.named.btcRegime,
        signalTime: decisionTime,
        decisionTime,
        entryTime: null,
        features: snapshot.values,
        atr20: snapshot.context.atr20
      };
      const entryIndex = lowerBound(reference.contract5, decisionTime, 'openTime');
      candidate.entryTime = reference.contract5[entryIndex]?.openTime ?? null;
      if (candidate.entryTime == null) { featureInvalid += 1; continue; }
      candidates.push(candidate);
    }
  }
  const bySymbolSide = { BUY: [], SELL: [] };
  for (const candidate of candidates) bySymbolSide[candidate.side].push(candidate.decisionTime);
  const median = values => {
    const sorted = values.slice().sort((left, right) => left - right);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const gaps = Object.fromEntries(['BUY', 'SELL'].map(side => {
    const times = bySymbolSide[side];
    return [side, { medianMs: median(times.slice(1).map((time, index) => time - times[index])), unexpectedGap: times.slice(1).some((time, index) => time - times[index] !== FIFTEEN_MINUTES) }];
  }));
  return {
    candidates,
    coverage: {
      symbol,
      expectedDecisionRows: expectedDecisionTimes.length,
      actualDecisionRows: Math.min(bySymbolSide.BUY.length, bySymbolSide.SELL.length),
      expectedRawCandidates: expectedDecisionTimes.length * 2,
      actualRawCandidates: candidates.length,
      coverageRatio: expectedDecisionTimes.length ? candidates.length / (expectedDecisionTimes.length * 2) : 0,
      BUY: bySymbolSide.BUY.length,
      SELL: bySymbolSide.SELL.length,
      medianDecisionGapMs: gaps,
      unexpectedGap: Object.values(gaps).some(value => value.unexpectedGap),
      featureInvalid
    }
  };
}

export function loadReferenceSeries({ root } = {}) {
  return buildSeries({ root });
}

export function buildSourceManifest({ files, preregistrationSha256, generatedAt = new Date().toISOString() }) {
  const bySymbol = Object.fromEntries(FIXED_SYMBOLS.map(symbol => [symbol, files.filter(file => file.symbol === symbol)]));
  return {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0040_SOURCE_MANIFEST',
    immutable: true,
    experimentId: HY_EXP_0040,
    source: 'Binance official public USD-M Futures aggTrades archive',
    archiveBaseUrl: 'https://data.binance.vision/data/futures/um',
    preregistrationSha256,
    generatedAt,
    window: { start: iso(WINDOW_START), endExclusive: iso(WINDOW_END), calendarDays: 730 },
    symbols: FIXED_SYMBOLS,
    partitionPolicy: 'monthly preferred; daily only for a missing monthly partition',
    files: files.map(file => ({
      ...file,
      canonicalUrl: file.url,
      transportUrl: file.transportUrl ?? file.url,
      objectKey: file.objectKey ?? objectKeyFromCanonicalUrl(file.url),
      officialSha256: file.sha256,
      checksumAvailable: Boolean(file.sha256),
      checksumVerified: false,
      rawRetained: false
    })),
    filesBySymbol: Object.fromEntries(Object.entries(bySymbol).map(([symbol, rows]) => [symbol, rows.length])),
    sourceContinuity: 'native aggregateTradeId strictly increasing and timestamp nondecreasing within each symbol',
    noSyntheticData: true,
    noInterpolation: true,
    noForwardFill: true,
    noFutureData: true,
    noPrivateApi: true,
    outcomeRead: false,
    pnlComputed: false,
    finalOosRead: false,
    safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, realEmail: false, automaticTrading: false, accountApi: false, orderApi: false, finalOosRead: false }
  };
}
