import { sendJson, methodAllowed, readBody, parseJson } from './_lib/http.mjs';
import { verifySignedRequest } from './_lib/signature.mjs';
import { dispatchPendingEmails, gmailStatus } from './_lib/gmail.mjs';

export default async function handler(request, response) {
  if (request.method !== 'POST') return methodAllowed(response, ['POST']);
  try {
    const body = await readBody(request);
    const signature = verifySignedRequest(request, body);
    if (!signature.ok) return sendJson(response, signature.status, { error: signature.reason });
    const parsed = parseJson(body);
    const limit = Number.isSafeInteger(Number(parsed.limit)) && Number(parsed.limit) > 0
      ? Math.min(Number(parsed.limit), 20) : 10;
    const result = await dispatchPendingEmails(limit);
    sendJson(response, 200, { ok: true, gmail: gmailStatus(), dispatched: result });
  } catch (error) {
    sendJson(response, error.status || 503, {
      error: error.message === 'gmail_not_enabled' ? 'gmail_not_enabled' : 'email_dispatch_failed'
    });
  }
}
