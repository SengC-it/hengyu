import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboardSnapshot, readAdvisories, readDeliveries } from '../src/service/advisory-store.mjs';
import { readSentReview } from '../api/_lib/review-read-model.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

const signalsFile = path.resolve(ROOT, flag('signals', 'data/signals.ndjson'));
const outboxFile = path.resolve(ROOT, flag('outbox', 'data/advisory-outbox.ndjson'));
const webFile = path.resolve(ROOT, flag('web', 'web/index.html'));
const host = flag('host', '127.0.0.1');
const port = Number(flag('port', '8787'));
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && flag('allow-public') !== '1') {
  throw new Error('non-loopback advisory server requires --allow-public and an authenticated reverse proxy');
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function limitFrom(url) {
  const value = Number(url.searchParams.get('limit') ?? 100);
  return Number.isSafeInteger(value) && value > 0 && value <= 500 ? value : 100;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
  if (request.method !== 'GET') {
    json(response, 405, { error: 'read_only_endpoint' });
    return;
  }
  if (url.pathname === '/api/health') {
    json(response, 200, {
      status: 'ok',
      mode: 'SIGNAL_ONLY',
      authorization: 'PAPER_ONLY',
      liveOrdersEnabled: false,
      orderPlacementEnabled: false,
      accountAccess: false
    });
    return;
  }
  try {
    if (url.pathname === '/api/signals') {
      json(response, 200, { signals: readAdvisories(signalsFile, { limit: limitFrom(url) }) });
      return;
    }
    if (url.pathname === '/api/alerts') {
      json(response, 200, { alerts: readDeliveries(outboxFile, { limit: limitFrom(url) }) });
      return;
    }
    if (url.pathname === '/api/dashboard') {
      json(response, 200, dashboardSnapshot({ signalsFile, outboxFile, limit: limitFrom(url) }));
      return;
    }
    if (url.pathname === '/api/review') {
      const review = await readSentReview(limitFrom(url));
      json(response, 200, { dataStatus: review.configured ? 'ok' : 'not_configured', ...review });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(webFile, 'utf8');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
      return;
    }
    json(response, 404, { error: 'not_found' });
  } catch (error) {
    json(response, 500, { error: 'read_failed', message: error.message });
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ status: 'listening', host, port, mode: 'SIGNAL_ONLY', authorization: 'PAPER_ONLY' }));
});
