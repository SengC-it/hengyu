import { sendJson, methodAllowed, parseLimit } from './_lib/http.mjs';
import { readSignals } from './_lib/read-model.mjs';

export default async function handler(request, response) {
  if (request.method !== 'GET') return methodAllowed(response, ['GET']);
  try {
    const result = await readSignals(parseLimit(request));
    sendJson(response, 200, {
      dataStatus: result.configured ? 'ok' : 'not_configured',
      signals: result.rows
    });
  } catch (error) {
    sendJson(response, error.status || 503, { error: 'signals_unavailable' });
  }
}
