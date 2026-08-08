import { sendJson, methodAllowed, parseLimit } from './_lib/http.mjs';
import { readSentReview } from './_lib/review-read-model.mjs';

export default async function handler(request, response) {
  if (request.method !== 'GET') return methodAllowed(response, ['GET']);
  try {
    const result = await readSentReview(parseLimit(request));
    sendJson(response, 200, {
      dataStatus: result.configured ? 'ok' : 'not_configured',
      ...result
    });
  } catch (error) {
    sendJson(response, error.status || 503, { error: 'review_unavailable' });
  }
}
