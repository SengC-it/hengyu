import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const HY_EXP_0020_HISTORICAL_L2_WINDOW = Object.freeze({
  start: '2024-01-01T00:00:00.000Z',
  endExclusive: '2026-07-01T00:00:00.000Z'
});

export const HISTORICAL_L2_REQUIREMENTS = Object.freeze({
  experimentId: 'HY-EXP-0020',
  requiredDepthLevels: 1000,
  requiredTimestamps: Object.freeze(['E', 'T', 'receivedAt']),
  requiredSequenceFields: Object.freeze(['U', 'u', 'pu']),
  defaultMissingIntervalMs: 1_000
});

function finite(name, value, { minimum = -Infinity, exclusiveMinimum = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (exclusiveMinimum ? parsed <= minimum : parsed < minimum)) {
    throw new Error(`invalid ${name}`);
  }
  return parsed;
}

function integer(name, value, { minimum = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid ${name}`);
  return parsed;
}

function symbolOf(value) {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(symbol)) throw new Error('invalid symbol');
  return symbol;
}

function symbolsOf(values) {
  const symbols = [...new Set((values ?? []).map(symbolOf))].sort();
  if (!symbols.length) throw new Error('symbols must not be empty');
  return symbols;
}

function timestampMs(name, value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid ${name}`);
  // Tardis CSV timestamps are microseconds; native Binance messages are milliseconds.
  if (parsed >= 100_000_000_000_000) return Math.round(parsed / 1_000);
  if (parsed >= 100_000_000_000) return Math.round(parsed);
  throw new Error(`invalid ${name}`);
}

function optionalTimestampMs(value) {
  if (value == null || value === '') return null;
  return timestampMs('timestamp', value);
}

function iso(name, value) {
  if (!value || !Number.isFinite(Date.parse(value))) throw new Error(`invalid ${name}`);
  return new Date(value).toISOString();
}

function levels(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} is missing`);
  return value.map((row, index) => {
    if (!Array.isArray(row) || row.length < 2) throw new Error(`invalid ${label}[${index}]`);
    return [
      finite(`${label}[${index}] price`, row[0], { minimum: 0, exclusiveMinimum: true }),
      finite(`${label}[${index}] quantity`, row[1], { minimum: 0 })
    ];
  });
}

function validateBookCross(bids, asks, label) {
  const bestBid = bids.filter(([, quantity]) => quantity > 0).reduce(
    (best, [price]) => Math.max(best, price), -Infinity
  );
  const bestAsk = asks.filter(([, quantity]) => quantity > 0).reduce(
    (best, [price]) => Math.min(best, price), Infinity
  );
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) throw new Error(`${label}:empty_book`);
  if (bestBid >= bestAsk) throw new Error(`${label}:crossed_book`);
}

function safeRelativePath(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || path.posix.normalize(normalized).startsWith('../') || normalized.includes('/../')) {
    throw new Error('manifest file path is unsafe');
  }
  return normalized;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

function hashManifestBody(manifest) {
  const body = { ...manifest };
  delete body.manifestSha256;
  return sha256(canonicalJson(body));
}

function fileEntry({ path: filePath, content, bytes, sha256: hash }) {
  const normalizedPath = safeRelativePath(filePath);
  if (content != null) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    return { path: normalizedPath, bytes: buffer.length, sha256: sha256(buffer) };
  }
  const normalizedBytes = integer('file bytes', bytes);
  const normalizedHash = String(hash ?? '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedHash)) throw new Error(`invalid file sha256 for ${normalizedPath}`);
  return { path: normalizedPath, bytes: normalizedBytes, sha256: normalizedHash };
}

function requireProvenance(provenance) {
  const source = provenance ?? {};
  for (const field of ['vendor', 'datasetId', 'sourceUrl', 'license', 'credentialSource']) {
    if (!String(source[field] ?? '').trim()) throw new Error(`historical L2 provenance missing ${field}`);
  }
  if (String(source.credentialSource) !== 'env:TARDIS_API_KEY') {
    throw new Error('historical L2 credential source must be env:TARDIS_API_KEY');
  }
  return {
    vendor: String(source.vendor),
    datasetId: String(source.datasetId),
    sourceUrl: String(source.sourceUrl),
    license: String(source.license),
    credentialSource: String(source.credentialSource),
    acquiredAt: source.acquiredAt ? iso('provenance acquiredAt', source.acquiredAt) : null
  };
}

/**
 * Create a hash-locked raw-data manifest. It contains no credentials and does not
 * imply that the underlying data is authorized or sufficient for HY-EXP-0020.
 */
export function buildHistoricalL2Manifest({
  windowStart = HY_EXP_0020_HISTORICAL_L2_WINDOW.start,
  windowEndExclusive = HY_EXP_0020_HISTORICAL_L2_WINDOW.endExclusive,
  symbols,
  files,
  provenance,
  accessAuthorized = false,
  licenseAccepted = false,
  format = 'tardis-native-depth'
}) {
  const normalizedSymbols = symbolsOf(symbols);
  const normalizedFiles = (files ?? []).map(fileEntry);
  if (!normalizedFiles.length) throw new Error('historical L2 manifest must list files');
  const manifest = {
    schemaVersion: 1,
    experimentId: HISTORICAL_L2_REQUIREMENTS.experimentId,
    dataClass: 'HISTORICAL_L2_RAW',
    immutable: true,
    windowStart: iso('windowStart', windowStart),
    windowEndExclusive: iso('windowEndExclusive', windowEndExclusive),
    symbols: normalizedSymbols,
    format: String(format),
    accessAuthorized: Boolean(accessAuthorized),
    licenseAccepted: Boolean(licenseAccepted),
    provenance: requireProvenance(provenance),
    files: normalizedFiles
  };
  return { ...manifest, manifestSha256: hashManifestBody(manifest) };
}

export function verifyHistoricalL2Manifest({ manifest, root, fileContents } = {}) {
  const errors = [];
  if (!manifest || manifest.immutable !== true) errors.push('manifest_not_immutable');
  if (manifest?.accessAuthorized !== true) errors.push('historical_data_not_authorized');
  if (manifest?.licenseAccepted !== true) errors.push('historical_license_not_accepted');
  if (manifest?.windowStart !== HY_EXP_0020_HISTORICAL_L2_WINDOW.start) errors.push('manifest_window_start_mismatch');
  if (manifest?.windowEndExclusive !== HY_EXP_0020_HISTORICAL_L2_WINDOW.endExclusive) errors.push('manifest_window_end_mismatch');
  if (!/^[a-f0-9]{64}$/.test(String(manifest?.manifestSha256 ?? ''))) {
    errors.push('manifest_sha256_missing');
  } else if (hashManifestBody(manifest) !== manifest.manifestSha256) {
    errors.push('manifest_sha256_mismatch');
  }
  try {
    requireProvenance(manifest?.provenance);
  } catch (error) {
    errors.push(error.message.replaceAll(' ', '_'));
  }
  if (!Array.isArray(manifest?.files) || !manifest.files.length) errors.push('manifest_files_missing');
  for (const entry of manifest?.files ?? []) {
    let normalizedPath;
    try {
      normalizedPath = safeRelativePath(entry.path);
    } catch (error) {
      errors.push(error.message.replaceAll(' ', '_'));
      continue;
    }
    let bytes;
    if (root) {
      const absolute = path.resolve(root, normalizedPath);
      const relative = path.relative(path.resolve(root), absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(absolute)) {
        errors.push(`missing_file:${normalizedPath}`);
        continue;
      }
      bytes = fs.readFileSync(absolute);
    } else if (fileContents instanceof Map) {
      bytes = fileContents.get(normalizedPath);
    } else if (fileContents && Object.prototype.hasOwnProperty.call(fileContents, normalizedPath)) {
      bytes = fileContents[normalizedPath];
    }
    if (bytes == null) {
      errors.push(`file_bytes_unavailable:${normalizedPath}`);
      continue;
    }
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
    if (buffer.length !== Number(entry.bytes)) errors.push(`bytes_mismatch:${normalizedPath}`);
    if (sha256(buffer) !== String(entry.sha256).toLowerCase()) errors.push(`hash_mismatch:${normalizedPath}`);
  }
  return {
    status: errors.length ? 'DATA_FAIL' : 'VALID',
    decision: errors.length ? 'STOP' : 'CONTINUE',
    developmentAllowed: false,
    finalOosAllowed: false,
    pnlComputed: false,
    errors
  };
}

function csvRows(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  const source = String(text ?? '');
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        value += '"';
        index++;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      row.push(value.replace(/\r$/, ''));
      if (row.some(cell => cell !== '')) rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }
  if (value || row.length) {
    row.push(value.replace(/\r$/, ''));
    if (row.some(cell => cell !== '')) rows.push(row);
  }
  return rows;
}

function bool(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function csvNumber(value, label) {
  return finite(label, value, { minimum: 0 });
}

/**
 * Import the normalized Tardis incremental_book_L2 CSV shape. That CSV is useful
 * for a feasibility audit, but it intentionally carries no Binance U/u/pu chain;
 * the validator therefore keeps sequence fields null and fails the frozen gate.
 */
export function importTardisCsv(text, { sourceFile = 'sample.csv' } = {}) {
  const rows = csvRows(text);
  if (rows.length < 2) throw new Error('Tardis CSV sample is empty');
  const headers = rows[0].map(value => value.trim());
  const index = new Map(headers.map((header, position) => [header, position]));
  for (const field of ['symbol', 'timestamp', 'local_timestamp', 'is_snapshot', 'side', 'price', 'amount']) {
    if (!index.has(field)) throw new Error(`Tardis CSV missing ${field}`);
  }
  const groups = new Map();
  for (const row of rows.slice(1)) {
    const symbol = symbolOf(row[index.get('symbol')]);
    const eventTime = timestampMs('Tardis timestamp', row[index.get('timestamp')]);
    const receivedAt = timestampMs('Tardis local_timestamp', row[index.get('local_timestamp')]);
    const isSnapshot = bool(row[index.get('is_snapshot')]);
    const side = String(row[index.get('side')] ?? '').toLowerCase();
    if (side !== 'bid' && side !== 'ask') throw new Error(`invalid Tardis side in ${sourceFile}`);
    const price = csvNumber(row[index.get('price')], 'Tardis price');
    const amount = csvNumber(row[index.get('amount')], 'Tardis amount');
    const key = `${symbol}:${eventTime}:${receivedAt}:${isSnapshot}`;
    const group = groups.get(key) ?? {
      kind: isSnapshot ? 'snapshot' : 'diff',
      vendor: 'tardis',
      format: 'tardis-csv-incremental-book-l2',
      sourceFile,
      symbol,
      eventTime,
      transactionTime: null,
      receivedAt,
      lastUpdateId: null,
      U: null,
      u: null,
      pu: null,
      bids: [],
      asks: [],
      sequenceSource: 'not_present_in_normalized_csv'
    };
    (side === 'bid' ? group.bids : group.asks).push([price, amount]);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function nativePayload(raw) {
  if (raw?.data && typeof raw.data === 'object' && (
    raw.data.e || raw.data.lastUpdateId != null || raw.data.U != null || raw.data.u != null
  )) return raw.data;
  if (raw?.message && typeof raw.message === 'object') {
    if (raw.message.data && typeof raw.message.data === 'object') return raw.message.data;
    return raw.message;
  }
  return raw;
}

function nativeReceivedAt(raw, payload) {
  return raw?.receivedAt ?? raw?.localTimestamp ?? raw?.local_timestamp
    ?? payload?.receivedAt ?? payload?.localTimestamp ?? payload?.local_timestamp;
}

/** Import Tardis native Binance depth/depthSnapshot JSONL without inventing fields. */
export function importTardisNdjson(text, { sourceFile = 'sample.ndjson' } = {}) {
  const records = [];
  for (const [lineIndex, line] of String(text ?? '').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      throw new Error(`${sourceFile}:${lineIndex + 1}: invalid JSON: ${error.message}`);
    }
    const payload = nativePayload(raw);
    const symbol = symbolOf(payload.s ?? raw.symbol);
    const eventTime = optionalTimestampMs(payload.E ?? raw.eventTime ?? raw.timestamp);
    const transactionTime = optionalTimestampMs(payload.T ?? raw.transactionTime);
    const receivedAt = optionalTimestampMs(nativeReceivedAt(raw, payload));
    const snapshot = Boolean(raw.generated || raw.isSnapshot || raw.is_snapshot)
      || String(raw.stream ?? '').toLowerCase().endsWith('@depthsnapshot')
      || payload.e === 'depthSnapshot';
    const bidLevels = payload.bids ?? payload.b;
    const askLevels = payload.asks ?? payload.a;
    const record = {
      kind: snapshot ? 'snapshot' : 'diff',
      vendor: 'tardis',
      format: 'tardis-native-depth',
      sourceFile,
      symbol,
      eventTime,
      transactionTime,
      receivedAt,
      lastUpdateId: snapshot ? (payload.lastUpdateId ?? null) : null,
      U: snapshot ? null : (payload.U ?? null),
      u: snapshot ? null : (payload.u ?? null),
      pu: snapshot ? null : (payload.pu ?? null),
      bids: bidLevels,
      asks: askLevels,
      sequenceSource: 'binance_depth_update'
    };
    // Validate shape now, while leaving completeness/sequence decisions to the gate.
    if (!Number.isFinite(record.eventTime) || !Number.isFinite(record.receivedAt)) {
      throw new Error(`${sourceFile}:${lineIndex + 1}: E/T/receivedAt timestamps are incomplete`);
    }
    levels(record.bids, `${symbol} bids`);
    levels(record.asks, `${symbol} asks`);
    records.push(record);
  }
  return records;
}

export function importTardisSample(text, { format = 'ndjson', sourceFile } = {}) {
  if (format === 'ndjson' || format === 'jsonl') return importTardisNdjson(text, { sourceFile });
  if (format === 'csv') return importTardisCsv(text, { sourceFile });
  throw new Error(`unsupported Tardis sample format: ${format}`);
}

function normalizeCanonicalRecord(record) {
  const kind = String(record?.kind ?? '').toLowerCase();
  if (kind !== 'snapshot' && kind !== 'diff') throw new Error('historical L2 record kind is invalid');
  const symbol = symbolOf(record.symbol);
  const eventTime = record.eventTime == null ? null : timestampMs('eventTime', record.eventTime);
  const transactionTime = record.transactionTime == null ? null : timestampMs('transactionTime', record.transactionTime);
  const receivedAt = record.receivedAt == null ? null : timestampMs('receivedAt', record.receivedAt);
  const bids = levels(record.bids, `${symbol} bids`);
  const asks = levels(record.asks, `${symbol} asks`);
  return {
    ...record,
    kind,
    symbol,
    eventTime,
    transactionTime,
    receivedAt,
    bids,
    asks,
    lastUpdateId: kind === 'snapshot' && record.lastUpdateId != null ? integer('lastUpdateId', record.lastUpdateId) : record.lastUpdateId ?? null,
    U: kind === 'diff' && record.U != null ? integer('U', record.U) : record.U ?? null,
    u: kind === 'diff' && record.u != null ? integer('u', record.u) : record.u ?? null,
    pu: kind === 'diff' && record.pu != null ? integer('pu', record.pu) : record.pu ?? null
  };
}

function addError(summary, symbol, reason) {
  summary.errors.push(symbol ? `${symbol}:${reason}` : reason);
  summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
  if (symbol) {
    const row = summary.bySymbol[symbol] ??= { snapshots: 0, diffs: 0, firstEventTime: null, lastEventTime: null };
    row.errors = (row.errors ?? 0) + 1;
  }
}

function applyLevels(book, updates) {
  for (const [price, quantity] of updates) {
    if (quantity === 0) book.delete(price);
    else book.set(price, quantity);
  }
}

function bookArrays(book, side) {
  return [...book.entries()].sort((left, right) => side === 'bid' ? right[0] - left[0] : left[0] - right[0]);
}

function manifestValidationErrors(manifestInput) {
  if (!manifestInput) return [];
  const manifest = manifestInput.manifest ?? manifestInput;
  const result = verifyHistoricalL2Manifest(
    manifestInput.manifest ? manifestInput : { manifest: manifestInput }
  );
  return result.status === 'VALID' ? [] : result.errors;
}

/**
 * Fail-closed historical L2 gate. No feature, edge or PnL calculation belongs in
 * this module; a DATA_FEASIBLE result only means the raw market-data contract is met.
 */
export function validateHistoricalL2({
  records,
  symbols,
  windowStart = HY_EXP_0020_HISTORICAL_L2_WINDOW.start,
  windowEndExclusive = HY_EXP_0020_HISTORICAL_L2_WINDOW.endExclusive,
  requiredDepthLevels = HISTORICAL_L2_REQUIREMENTS.requiredDepthLevels,
  maxMissingIntervalMs = HISTORICAL_L2_REQUIREMENTS.defaultMissingIntervalMs,
  manifest = null,
  sample = false
} = {}) {
  const frozenSymbols = symbolsOf(symbols);
  const frozenWindowStart = windowStart == null ? null : iso('windowStart', windowStart);
  const frozenWindowEndExclusive = windowEndExclusive == null ? null : iso('windowEndExclusive', windowEndExclusive);
  const summary = {
    status: 'DATA_FEASIBLE',
    decision: 'CONTINUE',
    pnlComputed: false,
    developmentAllowed: false,
    finalOosAllowed: false,
    sample: Boolean(sample),
    windowStart: frozenWindowStart,
    windowEndExclusive: frozenWindowEndExclusive,
    errors: [],
    reasons: {},
    totalRecords: 0,
    snapshots: 0,
    diffs: 0,
    bySymbol: Object.fromEntries(frozenSymbols.map(symbol => [symbol, {
      snapshots: 0, diffs: 0, firstEventTime: null, lastEventTime: null
    }]))
  };
  const states = new Map();
  const seenUpdates = new Set();
  let normalized;
  try {
    normalized = (records ?? []).map(normalizeCanonicalRecord);
  } catch (error) {
    addError(summary, null, error.message.replaceAll(' ', '_'));
    normalized = [];
  }
  for (const record of normalized) {
    summary.totalRecords++;
    if (!frozenSymbols.includes(record.symbol)) {
      addError(summary, record.symbol, 'symbol_outside_frozen_universe');
      continue;
    }
    const row = summary.bySymbol[record.symbol];
    if (record.eventTime == null) addError(summary, record.symbol, 'missing_E');
    if (record.transactionTime == null) addError(summary, record.symbol, 'missing_T');
    if (record.receivedAt == null) addError(summary, record.symbol, 'missing_receivedAt');
    if (record.receivedAt != null && record.eventTime != null && record.eventTime > record.receivedAt) {
      addError(summary, record.symbol, 'event_after_receipt');
    }
    if (record.receivedAt != null && record.transactionTime != null && record.transactionTime > record.receivedAt) {
      addError(summary, record.symbol, 'transaction_after_receipt');
    }
    if (record.kind === 'snapshot') {
      try {
        validateBookCross(record.bids, record.asks, record.symbol);
      } catch (error) {
        addError(summary, record.symbol, error.message.split(':').at(-1));
      }
    }
    if (record.kind === 'snapshot') {
      summary.snapshots++;
      row.snapshots++;
      if (record.bids.length < requiredDepthLevels || record.asks.length < requiredDepthLevels) {
        addError(summary, record.symbol, 'insufficient_depth_levels');
      }
      if (record.lastUpdateId == null) addError(summary, record.symbol, 'missing_snapshot_update_id');
      states.set(record.symbol, {
        lastUpdateId: record.lastUpdateId,
        aligned: false,
        lastEventTime: record.eventTime,
        // A REST/generated snapshot may be received after buffered diffs;
        // the first causal diff establishes the receipt ordering baseline.
        lastReceivedAt: null,
        bids: new Map(record.bids.filter(([, quantity]) => quantity > 0)),
        asks: new Map(record.asks.filter(([, quantity]) => quantity > 0))
      });
      if (row.firstEventTime == null || record.eventTime < row.firstEventTime) row.firstEventTime = record.eventTime;
      row.lastEventTime = Math.max(row.lastEventTime ?? -Infinity, record.eventTime ?? -Infinity);
      continue;
    }
    summary.diffs++;
    row.diffs++;
    if (record.U == null || record.u == null) {
      addError(summary, record.symbol, 'missing_sequence_fields');
      continue;
    }
    if (record.U > record.u) addError(summary, record.symbol, 'invalid_sequence_range');
    const state = states.get(record.symbol);
    if (!state) {
      addError(summary, record.symbol, 'missing_snapshot');
      continue;
    }
    const updateKey = `${record.symbol}:${record.u}`;
    if (seenUpdates.has(updateKey)) {
      addError(summary, record.symbol, 'duplicate_update');
      continue;
    }
    seenUpdates.add(updateKey);
    if (record.u <= state.lastUpdateId) {
      addError(summary, record.symbol, 'out_of_order_update');
      continue;
    }
    if (!state.aligned) {
      if (!(record.U <= state.lastUpdateId && record.u >= state.lastUpdateId)) {
        addError(summary, record.symbol, 'snapshot_alignment');
        continue;
      }
      state.aligned = true;
    } else if (record.pu == null || record.pu !== state.lastUpdateId) {
      addError(summary, record.symbol, 'sequence_gap');
      continue;
    }
    if (state.lastReceivedAt != null && record.receivedAt != null) {
      if (record.receivedAt < state.lastReceivedAt) addError(summary, record.symbol, 'out_of_order_receipt');
      if (record.receivedAt - state.lastReceivedAt > maxMissingIntervalMs) {
        addError(summary, record.symbol, 'missing_interval');
      }
    }
    applyLevels(state.bids, record.bids);
    applyLevels(state.asks, record.asks);
    try {
      validateBookCross(bookArrays(state.bids, 'bid'), bookArrays(state.asks, 'ask'), record.symbol);
    } catch (error) {
      addError(summary, record.symbol, error.message.split(':').at(-1));
    }
    state.lastUpdateId = record.u;
    state.lastEventTime = record.eventTime;
    state.lastReceivedAt = record.receivedAt;
    if (row.firstEventTime == null || record.eventTime < row.firstEventTime) row.firstEventTime = record.eventTime;
    row.lastEventTime = Math.max(row.lastEventTime ?? -Infinity, record.eventTime ?? -Infinity);
  }
  for (const symbol of frozenSymbols) {
    const row = summary.bySymbol[symbol];
    if (!row.snapshots) addError(summary, symbol, 'missing_snapshot');
    if (!row.diffs) addError(summary, symbol, 'missing_diff');
    if (row.firstEventTime == null) addError(summary, symbol, 'missing_symbol_coverage');
    if (!frozenWindowStart) addError(summary, symbol, 'window_start_missing');
    if (!frozenWindowEndExclusive) addError(summary, symbol, 'window_end_missing');
    if (!sample && frozenWindowStart && row.firstEventTime != null && row.firstEventTime > Date.parse(frozenWindowStart)) {
      addError(summary, symbol, 'coverage_starts_after_window');
    }
    if (!sample && frozenWindowEndExclusive && row.lastEventTime != null && row.lastEventTime < Date.parse(frozenWindowEndExclusive)) {
      addError(summary, symbol, 'coverage_ends_before_window');
    }
  }
  for (const error of manifestValidationErrors(manifest)) addError(summary, null, error);
  if (summary.errors.length) {
    summary.status = 'DATA_FAIL';
    summary.decision = 'STOP';
  } else if (sample) {
    summary.status = 'SAMPLE_VALID';
    summary.decision = 'STOP';
  }
  return summary;
}

/**
 * Metadata-only audit used before authorized data is present. It deliberately
 * cannot return DATA_FEASIBLE without a source, license and data-coverage claim.
 */
export function auditHistoricalL2Metadata({ metadata, requiredSymbols = [], window = HY_EXP_0020_HISTORICAL_L2_WINDOW } = {}) {
  const errors = [];
  const symbols = symbolsOf(requiredSymbols);
  const value = metadata ?? {};
  if (value.vendor !== 'tardis') errors.push('unsupported_or_missing_vendor');
  if (value.authorized !== true) errors.push('historical_data_not_authorized');
  if (value.dataAvailable !== true) errors.push('historical_data_not_available');
  if (value.licenseAccepted !== true) errors.push('license_not_accepted');
  if (value.format !== 'tardis-native-depth') errors.push('required_native_sequence_format_missing');
  if (value.sequenceFields !== true) errors.push('U_u_pu_continuity_not_available');
  if (Number(value.maxDepthLevels) < HISTORICAL_L2_REQUIREMENTS.requiredDepthLevels) {
    errors.push('1000_level_depth_not_confirmed');
  }
  if (value.coverageStart !== window.start) errors.push('historical_coverage_start_mismatch');
  if (value.coverageEndExclusive !== window.endExclusive) errors.push('historical_coverage_end_mismatch');
  const coveredSymbols = new Set((value.symbols ?? []).map(symbol => String(symbol).toUpperCase()));
  for (const symbol of symbols) if (!coveredSymbols.has(symbol)) errors.push(`${symbol}:missing_symbol_coverage`);
  if (!value.sourceUrl || !value.datasetId) errors.push('provenance_incomplete');
  return {
    status: errors.length ? 'DATA_FAIL' : 'DATA_FEASIBLE',
    decision: errors.length ? 'STOP' : 'CONTINUE',
    errors,
    pnlComputed: false,
    developmentAllowed: false,
    finalOosAllowed: false
  };
}

export function buildTardisAuthHeaders(env = process.env) {
  const apiKey = String(env?.TARDIS_API_KEY ?? '');
  if (!apiKey) throw new Error('TARDIS_API_KEY must be supplied through the environment');
  return { Authorization: `Bearer ${apiKey}` };
}
