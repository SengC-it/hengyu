import { sendJson, methodAllowed } from './_lib/http.mjs';
import { hasSupabaseConfig, supabaseConfigStatus } from './_lib/supabase.mjs';
import { safetyEnvelope } from './_lib/safety.mjs';

export default function handler(request, response) {
  if (request.method !== 'GET') return methodAllowed(response, ['GET']);
  const gmailConfigured = Boolean(
    process.env.HENGYU_GMAIL_CLIENT_ID &&
    process.env.HENGYU_GMAIL_CLIENT_SECRET &&
    process.env.HENGYU_GMAIL_REFRESH_TOKEN &&
    process.env.HENGYU_GMAIL_SEND_ENABLED === 'true'
  );
  sendJson(response, 200, {
    status: hasSupabaseConfig() ? 'ok' : 'degraded',
    ...safetyEnvelope(),
    supabase: supabaseConfigStatus(),
    gmailConfigured,
    ingestConfigured: Boolean(process.env.HENGYU_INGEST_SECRET)
  });
}
