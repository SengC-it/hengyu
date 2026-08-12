import { sendJson, methodAllowed } from './_lib/http.mjs';
import { insertRow, hasSupabaseConfig } from './_lib/supabase.mjs';
import { safetyEnvelope } from './_lib/safety.mjs';

export default async function handler(request, response) {
  if (request.method !== 'GET') return methodAllowed(response, ['GET']);
  const expected = process.env.CRON_SECRET || process.env.HENGYU_CRON_SECRET;
  if (!expected) return sendJson(response, 503, { error: 'cron_secret_not_configured' });
  if (request.headers.authorization !== `Bearer ${expected}`) return sendJson(response, 401, { error: 'unauthorized' });
  if (hasSupabaseConfig()) {
    await insertRow('hengyu_system_heartbeats', {
      service_name: 'vercel-cron',
      observed_at: new Date().toISOString(),
      status: 'HEALTHY',
      pnl_eligible: false,
      details: { plan: 'hobby', purpose: 'low_frequency_health_check' }
    });
  }
  sendJson(response, 200, { ok: true, ...safetyEnvelope(), persisted: hasSupabaseConfig() });
}
