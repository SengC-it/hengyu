-- Hengyu Research core tables.
-- This migration only creates new hengyu_* objects in the existing crypto-alerts project.
-- Existing tables are intentionally not renamed, altered, or queried by this schema.

create table if not exists public.hengyu_experiments (
  experiment_id text primary key,
  hypothesis text not null,
  model_version text not null,
  registry_hash text not null,
  status text not null default 'REGISTERED'
    check (status in ('REGISTERED', 'FROZEN', 'RUNNING', 'RETIRED')),
  frozen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.hengyu_universe_snapshots (
  snapshot_id uuid primary key default gen_random_uuid(),
  snapshot_at timestamptz not null,
  symbol text not null,
  contract_status text not null,
  listing_time timestamptz,
  quote_asset text not null,
  tier text not null check (tier in ('A', 'B', 'NO_TRADE')),
  eligible boolean not null default false,
  exclusion_reason text,
  volume_24h numeric,
  depth_score numeric,
  data_completeness numeric check (data_completeness between 0 and 1),
  source_hash text not null,
  created_at timestamptz not null default now(),
  unique (snapshot_at, symbol)
);

create table if not exists public.hengyu_capture_segments (
  segment_id uuid primary key default gen_random_uuid(),
  capture_key text not null unique,
  started_at timestamptz not null,
  ended_at timestamptz,
  status text not null default 'RUNNING'
    check (status in ('RUNNING', 'COMPLETE', 'FAILED', 'INVALID')),
  pnl_eligible boolean not null default false,
  sequence_gap_count integer not null default 0 check (sequence_gap_count >= 0),
  stale_book_count integer not null default 0 check (stale_book_count >= 0),
  funding_ok boolean not null default false,
  open_interest_ok boolean not null default false,
  failure_reason text,
  manifest_hash text,
  created_at timestamptz not null default now()
);

create table if not exists public.hengyu_raw_chunk_manifest (
  chunk_id uuid primary key default gen_random_uuid(),
  segment_id uuid not null references public.hengyu_capture_segments(segment_id),
  stream_kind text not null,
  symbol text,
  object_key text not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-fA-F]{64}$'),
  byte_length bigint not null check (byte_length >= 0),
  first_event_at timestamptz,
  last_event_at timestamptz,
  event_count bigint not null default 0 check (event_count >= 0),
  sequence_valid boolean not null default false,
  pnl_eligible boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.hengyu_data_quality (
  quality_id uuid primary key default gen_random_uuid(),
  segment_id uuid not null references public.hengyu_capture_segments(segment_id),
  symbol text not null,
  observed_at timestamptz not null,
  freshness_ms numeric check (freshness_ms >= 0),
  book_fresh boolean not null default false,
  sequence_ok boolean not null default false,
  funding_ok boolean not null default false,
  open_interest_ok boolean not null default false,
  liquidity_ok boolean not null default false,
  pnl_eligible boolean not null default false,
  reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.hengyu_advisories (
  advisory_id uuid primary key default gen_random_uuid(),
  experiment_id text not null,
  capture_segment_id uuid references public.hengyu_capture_segments(segment_id),
  symbol text not null,
  advisory_type text not null
    check (advisory_type in ('REVIEW_BUY', 'REVIEW_SELL', 'NO_TRADE')),
  alert_level text not null
    check (alert_level in ('STRONG', 'MEDIUM', 'OBSERVE', 'NO_TRADE')),
  signal_at timestamptz not null,
  expires_at timestamptz not null,
  reference_bid numeric,
  reference_ask numeric,
  entry_reference numeric check (entry_reference is null or entry_reference > 0),
  stop_reference numeric check (stop_reference is null or stop_reference > 0),
  exit_reference numeric check (exit_reference is null or exit_reference > 0),
  gross_edge_bps numeric,
  funding_edge_bps numeric,
  fee_bps numeric not null default 0,
  slippage_bps numeric not null default 0,
  impact_bps numeric not null default 0,
  latency_buffer_bps numeric not null default 0,
  uncertainty_bps numeric not null default 0,
  conservative_net_edge_bps numeric,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'EXPIRED', 'CLOSED', 'INVALID')),
  no_trade_reason text,
  pnl_eligible boolean not null default false,
  authorization_mode text not null default 'PAPER_ONLY'
    check (authorization_mode = 'PAPER_ONLY'),
  live_orders_enabled boolean not null default false
    check (live_orders_enabled = false),
  dedupe_key text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (advisory_type <> 'NO_TRADE' or pnl_eligible = false)
);

create table if not exists public.hengyu_model_simulations (
  simulation_id uuid primary key default gen_random_uuid(),
  advisory_id uuid not null unique references public.hengyu_advisories(advisory_id),
  status text not null default 'OPEN'
    check (status in ('OPEN', 'CLOSED', 'INVALID')),
  entry_reference numeric,
  exit_reference numeric,
  entry_at timestamptz,
  exit_at timestamptz,
  exit_reason text,
  gross_return_bps numeric,
  fee_bps numeric not null default 0,
  slippage_bps numeric not null default 0,
  funding_bps numeric not null default 0,
  impact_bps numeric not null default 0,
  latency_bps numeric not null default 0,
  net_return_bps numeric,
  pnl_eligible boolean not null default false,
  invalid_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.hengyu_email_outbox (
  outbox_id uuid primary key default gen_random_uuid(),
  advisory_id uuid references public.hengyu_advisories(advisory_id),
  alert_level text not null
    check (alert_level in ('STRONG', 'MEDIUM', 'OBSERVE', 'NO_TRADE')),
  from_address text not null,
  to_address text not null,
  subject text not null,
  body_plain text not null,
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-fA-F]{64}$'),
  dedupe_key text not null unique,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create table if not exists public.hengyu_email_deliveries (
  delivery_id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.hengyu_email_outbox(outbox_id),
  attempt_number integer not null check (attempt_number > 0),
  status text not null check (status in ('SENT', 'FAILED')),
  provider_message_id text,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (outbox_id, attempt_number)
);

create table if not exists public.hengyu_registry_events (
  event_id uuid primary key default gen_random_uuid(),
  experiment_id text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  previous_hash text,
  event_hash text not null unique check (event_hash ~ '^[0-9a-fA-F]{64}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.hengyu_system_heartbeats (
  heartbeat_id uuid primary key default gen_random_uuid(),
  service_name text not null,
  observed_at timestamptz not null,
  status text not null check (status in ('HEALTHY', 'DEGRADED', 'FAILED', 'STOPPED')),
  last_capture_at timestamptz,
  pnl_eligible boolean not null default false,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists hengyu_universe_snapshots_symbol_time_idx
  on public.hengyu_universe_snapshots (symbol, snapshot_at desc);
create index if not exists hengyu_capture_segments_started_idx
  on public.hengyu_capture_segments (started_at desc);
create index if not exists hengyu_raw_chunk_manifest_segment_idx
  on public.hengyu_raw_chunk_manifest (segment_id, created_at desc);
create index if not exists hengyu_data_quality_segment_time_idx
  on public.hengyu_data_quality (segment_id, observed_at desc);
create index if not exists hengyu_advisories_signal_time_idx
  on public.hengyu_advisories (signal_at desc, symbol);
create index if not exists hengyu_advisories_segment_idx
  on public.hengyu_advisories (capture_segment_id);
create index if not exists hengyu_advisories_status_idx
  on public.hengyu_advisories (status, expires_at);
create index if not exists hengyu_model_simulations_status_idx
  on public.hengyu_model_simulations (status, exit_at);
create index if not exists hengyu_email_outbox_status_idx
  on public.hengyu_email_outbox (status, next_attempt_at, created_at);
create index if not exists hengyu_email_outbox_advisory_idx
  on public.hengyu_email_outbox (advisory_id);
create index if not exists hengyu_email_deliveries_outbox_idx
  on public.hengyu_email_deliveries (outbox_id, created_at desc);
create index if not exists hengyu_registry_events_experiment_idx
  on public.hengyu_registry_events (experiment_id, created_at);
create index if not exists hengyu_system_heartbeats_service_idx
  on public.hengyu_system_heartbeats (service_name, observed_at desc);

create or replace function public.hengyu_reject_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'append-only Hengyu table % cannot be %', TG_TABLE_NAME, TG_OP;
end;
$$;

revoke all on function public.hengyu_reject_mutation() from public;

drop trigger if exists hengyu_registry_events_append_only on public.hengyu_registry_events;
create trigger hengyu_registry_events_append_only
before update or delete on public.hengyu_registry_events
for each row execute function public.hengyu_reject_mutation();
drop trigger if exists hengyu_registry_events_no_truncate on public.hengyu_registry_events;
create trigger hengyu_registry_events_no_truncate
before truncate on public.hengyu_registry_events
for each statement execute function public.hengyu_reject_mutation();

drop trigger if exists hengyu_raw_chunk_manifest_append_only on public.hengyu_raw_chunk_manifest;
create trigger hengyu_raw_chunk_manifest_append_only
before update or delete on public.hengyu_raw_chunk_manifest
for each row execute function public.hengyu_reject_mutation();
drop trigger if exists hengyu_raw_chunk_manifest_no_truncate on public.hengyu_raw_chunk_manifest;
create trigger hengyu_raw_chunk_manifest_no_truncate
before truncate on public.hengyu_raw_chunk_manifest
for each statement execute function public.hengyu_reject_mutation();

drop trigger if exists hengyu_email_deliveries_append_only on public.hengyu_email_deliveries;
create trigger hengyu_email_deliveries_append_only
before update or delete on public.hengyu_email_deliveries
for each row execute function public.hengyu_reject_mutation();
drop trigger if exists hengyu_email_deliveries_no_truncate on public.hengyu_email_deliveries;
create trigger hengyu_email_deliveries_no_truncate
before truncate on public.hengyu_email_deliveries
for each statement execute function public.hengyu_reject_mutation();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'hengyu_experiments',
    'hengyu_universe_snapshots',
    'hengyu_capture_segments',
    'hengyu_raw_chunk_manifest',
    'hengyu_data_quality',
    'hengyu_advisories',
    'hengyu_model_simulations',
    'hengyu_email_outbox',
    'hengyu_email_deliveries',
    'hengyu_registry_events',
    'hengyu_system_heartbeats'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant all on table public.%I to service_role', table_name);
    execute format('drop policy if exists %I on public.%I', 'hengyu_deny_public', table_name);
    execute format(
      'create policy %I on public.%I for all to anon, authenticated using (false) with check (false)',
      'hengyu_deny_public', table_name
    );
  end loop;
end;
$$;

revoke update, delete, truncate on table
  public.hengyu_registry_events,
  public.hengyu_raw_chunk_manifest,
  public.hengyu_email_deliveries
from service_role;
