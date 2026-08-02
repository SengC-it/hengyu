const SUPABASE_URL = process.env.HENGYU_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.HENGYU_SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

export function hasSupabaseConfig() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

export function supabaseConfigStatus() {
  return {
    configured: hasSupabaseConfig(),
    projectRef: SUPABASE_URL ? new URL(SUPABASE_URL).hostname.split('.')[0] : null
  };
}

async function request(table, { method = 'GET', params = {}, body, headers = {} } = {}) {
  if (!hasSupabaseConfig()) throw new Error('supabase_not_configured');
  const url = new URL(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      authorization: `Bearer ${SUPABASE_KEY}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!response.ok) {
    const error = new Error(`supabase_${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function selectRows(table, { select = '*', filters = {}, order, limit = 100 } = {}) {
  const params = { select, limit };
  for (const [key, value] of Object.entries(filters)) params[key] = value;
  if (order) params.order = order;
  return request(table, { params });
}

export function insertRow(table, row, { onConflict } = {}) {
  const params = onConflict ? { on_conflict: onConflict } : {};
  return request(table, {
    method: 'POST',
    params,
    body: row,
    headers: { Prefer: 'return=representation,resolution=ignore-duplicates' }
  });
}

export function updateRow(table, filters, patch) {
  return request(table, {
    method: 'PATCH',
    params: filters,
    body: patch,
    headers: { Prefer: 'return=representation' }
  });
}
