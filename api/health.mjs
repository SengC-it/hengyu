import { sendJson, methodAllowed } from './_lib/http.mjs';
import { hasSupabaseConfig, supabaseConfigStatus } from './_lib/supabase.mjs';
import { safetyEnvelope } from './_lib/safety.mjs';
import { gmailStatus } from './_lib/gmail.mjs';

export default function handler(request, response) {
  if (request.method !== 'GET') return methodAllowed(response, ['GET']);
  const gmail = gmailStatus();
  sendJson(response, 200, {
    status: hasSupabaseConfig() ? 'ok' : 'degraded',
    ...safetyEnvelope(),
    supabase: supabaseConfigStatus(),
    gmailConfigured: gmail.configured,
    gmail,
    ingestConfigured: Boolean(process.env.HENGYU_INGEST_SECRET)
  });
}
