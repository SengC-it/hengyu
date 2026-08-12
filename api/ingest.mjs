import { createHash } from 'node:crypto';
import { sendJson, methodAllowed, readBody, parseJson } from './_lib/http.mjs';
import { insertRow, selectRows } from './_lib/supabase.mjs';
import { assertPaperOnly } from './_lib/safety.mjs';
import { verifySignedRequest } from './_lib/signature.mjs';
import { formatAdvisoryEmail } from '../src/model/alert-outbox.mjs';
import { gmailStatus } from './_lib/gmail.mjs';

const SPECS = {
  advisory: {
    table: 'hengyu_advisories',
    conflict: 'dedupe_key',
    required: ['dedupe_key', 'symbol', 'advisory_type', 'alert_level', 'signal_at', 'expires_at'],
    fields: [
      'advisory_id', 'experiment_id', 'capture_segment_id', 'symbol', 'advisory_type', 'alert_level',
      'signal_at', 'expires_at', 'reference_bid', 'reference_ask', 'entry_reference', 'stop_reference',
      'exit_reference', 'gross_edge_bps', 'funding_edge_bps', 'fee_bps', 'slippage_bps', 'impact_bps',
      'latency_buffer_bps', 'uncertainty_bps', 'conservative_net_edge_bps', 'status', 'no_trade_reason',
      'pnl_eligible', 'authorization_mode', 'live_orders_enabled', 'dedupe_key', 'metadata'
    ]
  },
  capture_segment: {
    table: 'hengyu_capture_segments',
    conflict: 'capture_key',
    required: ['capture_key', 'started_at', 'status'],
    fields: [
      'segment_id', 'capture_key', 'started_at', 'ended_at', 'status', 'pnl_eligible',
      'sequence_gap_count', 'stale_book_count', 'funding_ok', 'open_interest_ok', 'failure_reason',
      'manifest_hash'
    ]
  },
  heartbeat: {
    table: 'hengyu_system_heartbeats',
    conflict: null,
    required: ['service_name', 'observed_at', 'status'],
    fields: ['heartbeat_id', 'service_name', 'observed_at', 'status', 'last_capture_at', 'pnl_eligible', 'details']
  }
};

function pick(record, fields) {
  return Object.fromEntries(fields.filter(field => record[field] !== undefined).map(field => [field, record[field]]));
}

function validate(spec, record) {
  assertPaperOnly(record);
  for (const field of spec.required) {
    if (record[field] === undefined || record[field] === null || record[field] === '') {
      throw new Error(`missing_field:${field}`);
    }
  }
  const timestamp = Date.parse(record.signal_at || record.observed_at || record.started_at);
  if (Number.isFinite(timestamp) && timestamp > Date.now() + 5_000) throw new Error('future_timestamp');
  const safe = pick(record, spec.fields);
  if (spec.table === 'hengyu_advisories') {
    safe.authorization_mode = 'PAPER_ONLY';
    safe.live_orders_enabled = false;
    if (safe.advisory_type === 'NO_TRADE') safe.pnl_eligible = false;
  }
  if (spec.table === 'hengyu_capture_segments' && safe.status !== 'COMPLETE') safe.pnl_eligible = false;
  if (spec.table === 'hengyu_system_heartbeats') safe.pnl_eligible = false;
  return safe;
}

function advisoryEmailSignal(advisory) {
  const metadata = advisory.metadata && typeof advisory.metadata === 'object'
    ? advisory.metadata
    : {};
  return {
    alertLevel: advisory.alert_level,
    action: advisory.advisory_type,
    symbol: advisory.symbol,
    expiresAt: advisory.expires_at,
    reference: {
      entryPrice: advisory.entry_reference,
      stopPrice: advisory.stop_reference,
      takeProfitPrice: advisory.exit_reference
    },
    costs: { conservativeNetEdgeBps: advisory.conservative_net_edge_bps },
    reasons: Array.isArray(metadata.reasons) ? metadata.reasons : [],
    hypothesisId: metadata.hypothesisId ?? null,
    exitRule: metadata.exitRule ?? null,
    initialExitChannelPrice: metadata.initialExitChannelPrice ?? null,
    reviewModel: metadata.reviewModel ?? null
  };
}

export function buildEmailOutboxRow(advisory, advisoryId) {
  const fromAddress = process.env.HENGYU_GMAIL_FROM_ADDRESS;
  const toAddress = process.env.HENGYU_GMAIL_TO_ADDRESS;
  if (!fromAddress || !toAddress) return null;
  const message = formatAdvisoryEmail(advisoryEmailSignal(advisory));
  return {
    advisory_id: advisoryId,
    alert_level: advisory.alert_level,
    from_address: fromAddress,
    to_address: toAddress,
    subject: message.subject,
    body_plain: message.text,
    body_sha256: createHash('sha256').update(message.text).digest('hex'),
    dedupe_key: `${advisory.dedupe_key}:EMAIL`,
    status: 'PENDING',
    attempts: 0
  };
}

export async function ingestAdvisoryBundle(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('invalid_record');
  }
  const advisory = validate(SPECS.advisory, record.advisory);
  if (record.email !== undefined) assertPaperOnly(record.email);
  const inserted = await insertRow('hengyu_advisories', advisory, { onConflict: 'dedupe_key' });
  const duplicate = Array.isArray(inserted) && inserted.length === 0;
  let advisoryRow = Array.isArray(inserted) ? inserted[0] : null;
  if (!advisoryRow?.advisory_id) {
    const existing = await selectRows('hengyu_advisories', {
      select: 'advisory_id,alert_level,advisory_type,symbol,expires_at,entry_reference,stop_reference,exit_reference,conservative_net_edge_bps,metadata,dedupe_key',
      filters: { dedupe_key: `eq.${advisory.dedupe_key}` },
      limit: 1
    });
    advisoryRow = Array.isArray(existing) ? existing[0] : null;
  }
  if (!advisoryRow?.advisory_id) throw new Error('advisory_id_not_returned');
  const shouldQueueEmail = record.email?.requested !== false
    && ['STRONG', 'MEDIUM'].includes(String(advisory.alert_level).toUpperCase());
  let emailStatus = {
    requested: shouldQueueEmail,
    configured: gmailStatus().configured,
    queued: false,
    duplicate: false
  };
  if (shouldQueueEmail) {
    const emailRow = buildEmailOutboxRow({ ...advisory, ...advisoryRow }, advisoryRow.advisory_id);
    if (emailRow) {
      const emailInserted = await insertRow('hengyu_email_outbox', emailRow, { onConflict: 'dedupe_key' });
      emailStatus = {
        ...emailStatus,
        queued: true,
        duplicate: Array.isArray(emailInserted) && emailInserted.length === 0
      };
    }
  }
  return { duplicate, advisoryId: advisoryRow.advisory_id, email: emailStatus };
}

export default async function handler(request, response) {
  if (request.method !== 'POST') return methodAllowed(response, ['POST']);
  let bodyText;
  try {
    bodyText = await readBody(request);
    const signature = verifySignedRequest(request, bodyText);
    if (!signature.ok) return sendJson(response, signature.status, { error: signature.reason });
    const body = parseJson(bodyText);
    if (body.kind === 'advisory_bundle') {
      const result = await ingestAdvisoryBundle(body.record);
      return sendJson(response, 202, {
        accepted: true,
        kind: body.kind,
        ...result,
        paperOnly: true
      });
    }
    const spec = SPECS[body.kind];
    if (!spec) return sendJson(response, 400, { error: 'unsupported_ingest_kind' });
    const record = validate(spec, body.record);
    const rows = await insertRow(spec.table, record, spec.conflict ? { onConflict: spec.conflict } : {});
    sendJson(response, 202, {
      accepted: true,
      kind: body.kind,
      duplicate: Array.isArray(rows) && rows.length === 0,
      paperOnly: true
    });
  } catch (error) {
    const status = /missing_field|future_timestamp|invalid_record|paper_only|live_orders|forbidden_field|unsupported|invalid_json|request_body|invalid_email/.test(error.message)
      ? 400 : (error.status || 503);
    sendJson(response, status, { error: status === 400 ? error.message : 'ingest_failed' });
  }
}
