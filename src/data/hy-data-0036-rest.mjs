const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 8_000;

function headerValue(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function numericHeader(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - now);
}

function errorWithCode(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function defaultSleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function boundedBackoff(attempt, base, maximum, random) {
  const exponential = Math.min(maximum, base * (2 ** Math.max(0, attempt - 1)));
  return Math.min(maximum, Math.max(0, Math.ceil(exponential * (0.75 + random() * 0.5))));
}

/**
 * One shared governor for every Binance public REST request in the runtime.
 * It deliberately exposes only rate-limit metadata, never response bodies or
 * credentials, and treats a missing Retry-After as a hard failure.
 */
export function createBinancePublicRestGovernor({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = defaultSleep,
  random = Math.random,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  logger = () => {}
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('public REST fetch implementation is required');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('invalid maxAttempts');
  let cooldownUntil = 0;
  let bannedUntil = 0;
  const responseLog = [];
  const diagnostics = {
    requestCount: 0,
    http429Count: 0,
    http418Count: 0,
    rateGovernorCooldownCount: 0,
    blockedRequestCount: 0,
    networkErrorCount: 0,
    retryCount: 0,
    retryAfterObserved: [],
    maxUsedWeight: null,
    depthSnapshotRequestCount: 0
  };

  function state() {
    const at = now();
    return Object.freeze({
      cooldownUntil,
      bannedUntil,
      blocked: at < cooldownUntil || at < bannedUntil,
      status: at < bannedUntil ? 'IP_RATE_LIMIT_BANNED' : at < cooldownUntil ? 'RATE_LIMIT_COOLDOWN' : 'READY'
    });
  }

  async function waitForCooldown() {
    const until = Math.max(cooldownUntil, bannedUntil);
    const remaining = until - now();
    if (remaining <= 0) return;
    diagnostics.blockedRequestCount += 1;
    if (bannedUntil > now()) {
      throw errorWithCode('IP_RATE_LIMIT_BANNED', 'Binance public REST is IP rate-limit banned', { retryAfterMs: remaining });
    }
    await sleep(remaining);
  }

  function recordResponse({ url, response, requestStartedAt, receivedAt, retryAfterMs = null, errorCode = null }) {
    const status = response?.status == null ? null : Number(response.status);
    const usedWeight = headerValue(response, 'X-MBX-USED-WEIGHT-1M') ?? headerValue(response, 'X-MBX-USED-WEIGHT');
    const parsedWeight = numericHeader(usedWeight);
    if (parsedWeight !== null) diagnostics.maxUsedWeight = diagnostics.maxUsedWeight === null
      ? parsedWeight
      : Math.max(diagnostics.maxUsedWeight, parsedWeight);
    const entry = Object.freeze({
      url: String(url),
      status,
      retryAfter: headerValue(response, 'Retry-After'),
      retryAfterMs,
      usedWeight1m: headerValue(response, 'X-MBX-USED-WEIGHT-1M'),
      usedWeight: headerValue(response, 'X-MBX-USED-WEIGHT'),
      date: headerValue(response, 'Date'),
      requestStartedAt,
      receivedAt,
      errorCode
    });
    responseLog.push(entry);
    return entry;
  }

  async function request(url, options = {}) {
    if (String(url).includes('/v1/depth')) diagnostics.depthSnapshotRequestCount += 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await waitForCooldown();
      const requestStartedAt = now();
      diagnostics.requestCount += 1;
      let response;
      let body;
      try {
        response = await fetchImpl(url, options);
        body = await response.text();
      } catch (cause) {
        const receivedAt = now();
        diagnostics.networkErrorCount += 1;
        recordResponse({ url, response: null, requestStartedAt, receivedAt, errorCode: 'NETWORK_ERROR' });
        if (attempt >= maxAttempts) throw errorWithCode('NETWORK_ERROR', 'Binance public REST request failed', { cause });
        diagnostics.retryCount += 1;
        await sleep(boundedBackoff(attempt, baseBackoffMs, maxBackoffMs, random));
        continue;
      }
      const receivedAt = now();
      const status = Number(response.status);
      const retryAfter = headerValue(response, 'Retry-After');
      const retryAfterMs = parseRetryAfter(retryAfter, receivedAt);
      const responseMeta = recordResponse({ url, response, requestStartedAt, receivedAt, retryAfterMs });
      if (response.ok) return Object.freeze({ response, body, requestStartedAt, receivedAt, responseMeta });

      if (status === 429) {
        diagnostics.http429Count += 1;
        if (retryAfterMs === null) {
          responseLog[responseLog.length - 1] = Object.freeze({ ...responseMeta, errorCode: 'RATE_LIMIT_RETRY_AFTER_MISSING' });
          throw errorWithCode('RATE_LIMIT_RETRY_AFTER_MISSING', 'Binance 429 response omitted Retry-After');
        }
        diagnostics.rateGovernorCooldownCount += 1;
        diagnostics.retryAfterObserved.push(retryAfterMs);
        cooldownUntil = Math.max(cooldownUntil, receivedAt + retryAfterMs);
        if (attempt >= maxAttempts) throw errorWithCode('RATE_LIMIT_COOLDOWN_EXHAUSTED', 'Binance public REST retry budget exhausted after 429', { retryAfterMs });
        diagnostics.retryCount += 1;
        await waitForCooldown();
        continue;
      }

      if (status === 418) {
        diagnostics.http418Count += 1;
        if (retryAfterMs === null) {
          responseLog[responseLog.length - 1] = Object.freeze({ ...responseMeta, errorCode: 'RATE_LIMIT_RETRY_AFTER_MISSING' });
          throw errorWithCode('RATE_LIMIT_RETRY_AFTER_MISSING', 'Binance 418 response omitted Retry-After');
        }
        diagnostics.rateGovernorCooldownCount += 1;
        diagnostics.retryAfterObserved.push(retryAfterMs);
        bannedUntil = Math.max(bannedUntil, receivedAt + retryAfterMs);
        responseLog[responseLog.length - 1] = Object.freeze({ ...responseMeta, errorCode: 'IP_RATE_LIMIT_BANNED' });
        try { logger({ event: 'BINANCE_PUBLIC_REST_RATE_LIMIT_BANNED', status: 418, retryAfterMs }); } catch { /* logging cannot affect capture */ }
        throw errorWithCode('IP_RATE_LIMIT_BANNED', 'Binance public REST returned 418; no retry or IP rotation', { retryAfterMs });
      }

      if (status >= 500 && status <= 599 && attempt < maxAttempts) {
        diagnostics.retryCount += 1;
        await sleep(boundedBackoff(attempt, baseBackoffMs, maxBackoffMs, random));
        continue;
      }
      return Object.freeze({ response, body, requestStartedAt, receivedAt, responseMeta });
    }
    throw errorWithCode('REST_RETRY_EXHAUSTED', 'Binance public REST retry budget exhausted');
  }

  return Object.freeze({
    request,
    state,
    get diagnostics() {
      return Object.freeze({ ...diagnostics, retryAfterObserved: Object.freeze(diagnostics.retryAfterObserved.slice()) });
    },
    responseLog: () => Object.freeze(responseLog.slice()),
    get cooldownUntil() { return cooldownUntil; },
    get bannedUntil() { return bannedUntil; }
  });
}
