import crypto from 'node:crypto';

function secret() {
  return process.env.HENGYU_INGEST_SECRET || process.env.HENGYU_CRON_SECRET || '';
}

export function verifySignedRequest(request, body, { maxAgeMs = 300_000 } = {}) {
  const key = secret();
  if (!key) return { ok: false, status: 503, reason: 'ingest_secret_not_configured' };
  const rawTimestamp = request.headers['x-hengyu-timestamp'];
  const signature = request.headers['x-hengyu-signature'];
  const timestamp = Number(rawTimestamp);
  const timestampMs = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > maxAgeMs) {
    return { ok: false, status: 401, reason: 'stale_signature' };
  }
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) {
    return { ok: false, status: 401, reason: 'invalid_signature' };
  }
  const expected = crypto.createHmac('sha256', key)
    .update(`${rawTimestamp}.${body}`)
    .digest('hex');
  const equal = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  return equal ? { ok: true } : { ok: false, status: 401, reason: 'invalid_signature' };
}
