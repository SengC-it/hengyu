import {
  activationTimestampFromEnvironment,
  collectHyData0001Cycle,
  HY_DATA_0001_BASE_COMMIT,
  HY_DATA_0001_DATASET_ID,
  HY_DATA_0001_SAFETY,
  HY_DATA_0001_TABLES,
  toHyData0001HealthRow,
  toHyData0001ObservationRow,
  verifyHyData0001RequestSignature
} from '../src/model/hy-data-0001.mjs';
import { readBody, parseJson, methodAllowed, sendJson } from './_lib/http.mjs';
import { hasSupabaseConfig, insertRow, selectRows } from './_lib/supabase.mjs';

function header(request, name) {
  const headers = request.headers;
  if (headers && typeof headers.get === 'function') return headers.get(name);
  return headers?.[name] ?? headers?.[name.toLowerCase()] ?? null;
}

function activationRow({ activatedAt, now }) {
  return {
    dataset_id: HY_DATA_0001_DATASET_ID,
    collector_activated_at: new Date(activatedAt).toISOString(),
    status: 'ACTIVE',
    source_commit: process.env.HY_DATA_0001_SOURCE_COMMIT || HY_DATA_0001_BASE_COMMIT,
    signal_only: true,
    authorization_mode: 'PAPER_ONLY',
    live_orders_enabled: false,
    account_api: false,
    order_api: false,
    automatic_trading: false,
    created_at: new Date(now).toISOString()
  };
}

async function loadOrCreateActivation(now) {
  const existing = await selectRows(HY_DATA_0001_TABLES.activation, {
    filters: { dataset_id: `eq.${HY_DATA_0001_DATASET_ID}` },
    limit: 1
  });
  if (Array.isArray(existing) && existing[0]) return existing[0];
  const configured = activationTimestampFromEnvironment({ now });
  const row = activationRow({ activatedAt: configured ?? now, now });
  await insertRow(HY_DATA_0001_TABLES.activation, row, { onConflict: 'dataset_id' });
  const persisted = await selectRows(HY_DATA_0001_TABLES.activation, {
    filters: { dataset_id: `eq.${HY_DATA_0001_DATASET_ID}` },
    limit: 1
  });
  if (!Array.isArray(persisted) || !persisted[0]) throw new Error('activation_not_persisted');
  return persisted[0];
}

async function loadPreviousObservations() {
  const rows = await selectRows(HY_DATA_0001_TABLES.observations, {
    filters: { dataset_id: `eq.${HY_DATA_0001_DATASET_ID}` },
    order: 'symbol.asc,observation_at.desc',
    limit: 500
  });
  const previous = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!previous.has(row.symbol)) previous.set(row.symbol, row);
  }
  return previous;
}

function requestSecret() {
  return process.env.HENGYU_HY_DATA_0001_INGEST_SECRET || process.env.HENGYU_INGEST_SECRET || '';
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return methodAllowed(response, ['POST']);
  if (!hasSupabaseConfig()) return sendJson(response, 503, { error: 'supabase_not_configured' });
  let body;
  let bodyText;
  try {
    bodyText = await readBody(request, 100_000);
    body = parseJson(bodyText);
  } catch (error) {
    return sendJson(response, 400, { error: error.message });
  }
  const verification = verifyHyData0001RequestSignature({
    body: bodyText,
    timestamp: header(request, 'x-hengyu-timestamp'),
    signature: header(request, 'x-hengyu-signature'),
    secret: requestSecret()
  });
  if (!verification.ok) return sendJson(response, verification.status, { error: verification.reason });

  try {
    const requestStartedAt = Date.now();
    const activation = await loadOrCreateActivation(requestStartedAt);
    const previousBySymbol = await loadPreviousObservations();
    const result = await collectHyData0001Cycle({
      collectorActivatedAt: activation.collector_activated_at,
      previousBySymbol
    });
    const insertedRows = await Promise.all(result.observations.map(observation => (
      insertRow(
        HY_DATA_0001_TABLES.observations,
        toHyData0001ObservationRow(observation),
        { onConflict: 'idempotency_key' }
      )
    )));
    const healthRow = toHyData0001HealthRow(result.health);
    await insertRow(HY_DATA_0001_TABLES.health, healthRow);
    return sendJson(response, 200, {
      datasetId: HY_DATA_0001_DATASET_ID,
      status: result.health.status,
      schedulerSource: typeof body.schedulerSource === 'string' ? body.schedulerSource : 'unknown',
      rowsAttempted: result.observations.length,
      rowsPersisted: insertedRows.reduce((count, rows) => count + (Array.isArray(rows) ? rows.length : 0), 0),
      failures: result.failures,
      health: result.health,
      safety: HY_DATA_0001_SAFETY
    });
  } catch (error) {
    return sendJson(response, 503, {
      error: 'collector_cycle_failed',
      reason: error.code ?? error.message,
      safety: HY_DATA_0001_SAFETY
    });
  }
}
