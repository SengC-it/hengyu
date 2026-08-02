import { inflateRawSync } from 'node:zlib';

export const FIVE_MINUTES = 5 * 60 * 1000;

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

export function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function normalizeTimestamp(value) {
  const number = Number(value);
  return number > 1e14 ? Math.floor(number / 1000) : number;
}

export function unzipSingle(buffer) {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record is unavailable');
  const entries = buffer.readUInt16LE(eocd + 10);
  if (entries !== 1) throw new Error(`expected one ZIP member, received ${entries}`);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) {
    throw new Error('invalid ZIP central directory');
  }
  const method = buffer.readUInt16LE(centralOffset + 10);
  const expectedCrc = buffer.readUInt32LE(centralOffset + 16);
  const compressedSize = buffer.readUInt32LE(centralOffset + 20);
  const uncompressedSize = buffer.readUInt32LE(centralOffset + 24);
  const localOffset = buffer.readUInt32LE(centralOffset + 42);
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('invalid ZIP local header');
  if (buffer.readUInt16LE(localOffset + 8) !== method) throw new Error('ZIP method mismatch');
  const fileNameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + fileNameLength + extraLength;
  if (start + compressedSize > buffer.length) throw new Error('truncated ZIP payload');
  const compressed = buffer.subarray(start, start + compressedSize);
  const payload = method === 0
    ? compressed
    : method === 8
      ? inflateRawSync(compressed)
      : null;
  if (payload == null) throw new Error(`unsupported ZIP compression method ${method}`);
  if (payload.length !== uncompressedSize) throw new Error('ZIP uncompressed size mismatch');
  if (crc32(payload) !== expectedCrc) throw new Error('ZIP CRC-32 mismatch');
  return payload;
}

function archiveLines(buffer) {
  const text = unzipSingle(buffer).toString('utf8').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.length && !/^\d/.test(lines[0]) ? lines.slice(1) : lines;
}

function assertFinite(row, fields, label) {
  for (const field of fields) {
    if (!Number.isFinite(row[field])) throw new Error(`${label}: invalid ${field}`);
  }
}

export function parseKlineArchive(buffer, symbol, kind) {
  const rows = [];
  const seen = new Set();
  const signed = kind === 'premium';
  for (const [index, line] of archiveLines(buffer).entries()) {
    const value = line.split(',');
    if (value.length < 12) throw new Error(`${symbol}/${kind} row ${index + 1}: too few fields`);
    const row = {
      symbol,
      openTime: normalizeTimestamp(value[0]),
      open: Number(value[1]),
      high: Number(value[2]),
      low: Number(value[3]),
      close: Number(value[4]),
      volume: Number(value[5]),
      closeTime: normalizeTimestamp(value[6]),
      quoteVolume: Number(value[7]),
      trades: Number(value[8]),
      takerBuyVolume: Number(value[9]),
      takerBuyQuoteVolume: Number(value[10])
    };
    const label = `${symbol}/${kind} row ${index + 1}`;
    assertFinite(row, [
      'openTime', 'open', 'high', 'low', 'close', 'volume', 'closeTime',
      'quoteVolume', 'trades', 'takerBuyVolume', 'takerBuyQuoteVolume'
    ], label);
    if (seen.has(row.openTime)) throw new Error(`${label}: duplicate open time ${row.openTime}`);
    seen.add(row.openTime);
    if (row.closeTime !== row.openTime + FIVE_MINUTES - 1) {
      throw new Error(`${label}: invalid close time`);
    }
    if (!signed && [row.open, row.high, row.low, row.close].some(price => price <= 0)) {
      throw new Error(`${label}: non-positive price`);
    }
    if (row.high < Math.max(row.open, row.close)
      || row.low > Math.min(row.open, row.close)
      || row.high < row.low) {
      throw new Error(`${label}: impossible OHLC`);
    }
    if ([row.volume, row.quoteVolume, row.trades, row.takerBuyVolume, row.takerBuyQuoteVolume]
      .some(amount => amount < 0)) {
      throw new Error(`${label}: negative volume or trade count`);
    }
    if (kind === 'contract') {
      const tolerance = Math.max(1e-9, row.quoteVolume * 1e-9);
      if (row.takerBuyQuoteVolume > row.quoteVolume + tolerance) {
        throw new Error(`${label}: taker buy quote volume exceeds quote volume`);
      }
    }
    rows.push(row);
  }
  return rows;
}

export function parseFundingArchive(buffer, symbol) {
  const rows = [];
  const seen = new Set();
  for (const [index, line] of archiveLines(buffer).entries()) {
    const value = line.split(',');
    if (value.length < 3) throw new Error(`${symbol}/funding row ${index + 1}: too few fields`);
    const archiveTime = normalizeTimestamp(value[0]);
    const row = {
      symbol,
      archiveTime,
      eventTime: Math.floor(archiveTime / FIVE_MINUTES) * FIVE_MINUTES,
      fundingIntervalHours: Number(value[1]),
      fundingRate: Number(value[2])
    };
    const label = `${symbol}/funding row ${index + 1}`;
    assertFinite(row, ['archiveTime', 'eventTime', 'fundingIntervalHours', 'fundingRate'], label);
    if (seen.has(row.eventTime)) throw new Error(`${label}: duplicate event time ${row.eventTime}`);
    seen.add(row.eventTime);
    if (row.archiveTime - row.eventTime >= 1000) {
      throw new Error(`${label}: event timestamp is not aligned to a funding minute`);
    }
    if (row.fundingIntervalHours <= 0) throw new Error(`${label}: invalid funding interval`);
    rows.push(row);
  }
  return rows;
}

export function mergeUniqueSeries(chunks, timeField, label) {
  const rows = chunks.flat().sort((a, b) => a[timeField] - b[timeField]);
  for (let index = 1; index < rows.length; index++) {
    if (rows[index][timeField] === rows[index - 1][timeField]) {
      throw new Error(`${label}: duplicate timestamp across archives ${rows[index][timeField]}`);
    }
  }
  return rows;
}

export function assertContiguous(rows, label) {
  for (let index = 1; index < rows.length; index++) {
    const difference = rows[index].openTime - rows[index - 1].openTime;
    if (difference !== FIVE_MINUTES) {
      throw new Error(`${label}: non-contiguous 5m series at ${rows[index - 1].openTime}`);
    }
  }
}
