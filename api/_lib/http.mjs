export function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

export function methodAllowed(response, allowed) {
  sendJson(response, 405, { error: 'method_not_allowed', allowed });
}

export function parseLimit(request, fallback = 100) {
  const raw = new URL(request.url ?? '/', 'https://hengyu.invalid').searchParams.get('limit');
  const value = Number(raw ?? fallback);
  return Number.isSafeInteger(value) && value > 0 && value <= 500 ? value : fallback;
}

export async function readBody(request, maxBytes = 1_000_000) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) throw new Error('request_body_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error('invalid_json');
  }
}
