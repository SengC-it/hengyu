const REQUIRED_STREAM_MARKERS = Object.freeze([
  'bookTicker',
  'depth',
  'aggTrade',
  'forceOrder',
  'markPrice',
  'fundingRate',
  'openInterest'
]);

function integer(name, value, { minimum = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid ${name}`);
  return parsed;
}

function finite(name, value, { minimum = -Infinity } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) throw new Error(`invalid ${name}`);
  return parsed;
}

function streamPresent(streams, marker) {
  return streams.some(stream => String(stream).toLowerCase().includes(marker.toLowerCase()));
}

export function evaluateCaptureDataQuality({
  manifest,
  validation = null,
  requiredStreams = REQUIRED_STREAM_MARKERS,
  requiredSymbols = []
}) {
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest is required');
  const reasons = [];
  if (manifest.status !== 'complete') reasons.push('failed_manifest');
  if (Array.isArray(manifest.errors) && manifest.errors.length) reasons.push('manifest_errors');
  if (validation && validation.status !== 'valid') reasons.push('invalid_validation');
  if (!validation) reasons.push('missing_validation');
  const endpoints = Array.isArray(manifest.endpoints) ? manifest.endpoints : [];
  const streams = endpoints.flatMap(endpoint => endpoint.streams ?? []);
  for (const marker of requiredStreams) {
    if (!streamPresent(streams, marker)) reasons.push(`missing_stream:${marker}`);
  }
  const manifestSymbols = new Set((manifest.symbols ?? []).map(symbol => String(symbol).toUpperCase()));
  for (const symbol of requiredSymbols) {
    if (!manifestSymbols.has(String(symbol).toUpperCase())) reasons.push(`missing_symbol:${symbol}`);
  }
  return {
    status: reasons.length ? 'NOT_READY' : 'READY',
    pnlEligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    runId: manifest.run_id ?? null,
    symbolCount: manifestSymbols.size,
    requiredStreams: [...requiredStreams]
  };
}

export function evaluateSignalDataQuality({
  now = Date.now(),
  forecastTime,
  bookTime,
  receivedAt,
  maximumForecastAgeMs = 5_000,
  maximumBookAgeMs = 1_000
}) {
  const current = integer('now', now);
  const forecast = integer('forecastTime', forecastTime);
  const book = integer('bookTime', bookTime);
  const received = integer('receivedAt', receivedAt);
  const reasons = [];
  if (forecast > current || book > current || received > current) reasons.push('future_timestamp');
  if (current - forecast > finite('maximumForecastAgeMs', maximumForecastAgeMs, { minimum: 0 })) {
    reasons.push('stale_forecast');
  }
  if (current - book > finite('maximumBookAgeMs', maximumBookAgeMs, { minimum: 0 })) {
    reasons.push('stale_book');
  }
  return {
    status: reasons.length ? 'NOT_READY' : 'READY',
    fresh: reasons.length === 0,
    reasons: [...new Set(reasons)],
    now: current,
    forecastTime: forecast,
    bookTime: book,
    receivedAt: received
  };
}

export function assertPnlEligible(quality) {
  if (!quality?.pnlEligible) {
    throw new Error(`capture is not PnL eligible: ${(quality?.reasons ?? ['unknown']).join(',')}`);
  }
  return true;
}
