import { sendJson, methodAllowed, parseLimit } from './_lib/http.mjs';
import { dashboard } from './_lib/read-model.mjs';

export default async function handler(request, response) {
  if (request.method !== 'GET') return methodAllowed(response, ['GET']);
  try {
    sendJson(response, 200, await dashboard(parseLimit(request)));
  } catch (error) {
    sendJson(response, error.status || 503, { error: 'dashboard_unavailable' });
  }
}
