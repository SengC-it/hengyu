-- HY-DATA-0001 is a prospective, public-market-data-only dataset.
-- This migration is intentionally not applied by the collector or workflow.

create table if not exists public.hengyu_hy_data_0001_activation (
  dataset_id text primary key check (dataset_id = 'HY-DATA-0001'),
  collector_activated_at timestamptz not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'STOPPED')),
  source_commit text not null,
  signal_only boolean not null default true check (signal_only = true),
  authorization_mode text not null default 'PAPER_ONLY' check (authorization_mode = 'PAPER_ONLY'),
  live_orders_enabled boolean not null default false check (live_orders_enabled = false),
  account_api boolean not null default false check (account_api = false),
  order_api boolean not null default false check (order_api = false),
  automatic_trading boolean not null default false check (automatic_trading = false),
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.hengyu_hy_data_0001_observations (
  observation_id uuid primary key default gen_random_uuid(),
  dataset_id text not null check (dataset_id = 'HY-DATA-0001'),
  collector_activated_at timestamptz not null,
  observation_at timestamptz not null,
  symbol text not null check (symbol in (
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
    'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'
  )),
  idempotency_key text not null unique,
  source_endpoint text not null,
  source_type text not null check (source_type = 'BINANCE_USDM_PUBLIC_REST'),
  request_started_at timestamptz not null,
  exchange_event_at timestamptz,
  received_at timestamptz not null,
  scanner_delay_ms bigint,
  mark_price numeric,
  index_price numeric,
  current_funding_rate numeric,
  next_funding_time timestamptz,
  funding_time timestamptz,
  open_interest numeric,
  best_bid numeric,
  best_ask numeric,
  spread_bps numeric,
  depth_snapshot jsonb not null,
  bar_open_time timestamptz,
  bar_close_time timestamptz,
  bar_open numeric,
  bar_high numeric,
  bar_low numeric,
  bar_close numeric,
  bar_volume numeric,
  bar_quote_volume numeric,
  bar_trade_count bigint,
  bar_taker_buy_volume numeric,
  bar_taker_buy_quote_volume numeric,
  taker_buy_ratio numeric,
  premium_basis_bps numeric,
  source_timestamps jsonb not null,
  raw_values jsonb not null,
  normalized_values jsonb not null,
  quality_flags jsonb not null default '[]'::jsonb,
  is_valid boolean not null default false,
  signal_only boolean not null default true check (signal_only = true),
  authorization_mode text not null default 'PAPER_ONLY' check (authorization_mode = 'PAPER_ONLY'),
  live_orders_enabled boolean not null default false check (live_orders_enabled = false),
  account_api boolean not null default false check (account_api = false),
  order_api boolean not null default false check (order_api = false),
  automatic_trading boolean not null default false check (automatic_trading = false),
  created_at timestamptz not null default timezone('utc', now()),
  unique (symbol, observation_at),
  check (received_at >= request_started_at),
  check (observation_at >= collector_activated_at),
  check (received_at >= collector_activated_at),
  check (scanner_delay_ms is null or scanner_delay_ms >= 0),
  check (mark_price is null or mark_price > 0),
  check (index_price is null or index_price > 0),
  check (best_bid is null or best_bid > 0),
  check (best_ask is null or best_ask > 0),
  check (spread_bps is null or spread_bps >= 0),
  check (taker_buy_ratio is null or (taker_buy_ratio >= 0 and taker_buy_ratio <= 1))
);

create table if not exists public.hengyu_hy_data_0001_health (
  health_id uuid primary key default gen_random_uuid(),
  dataset_id text not null check (dataset_id = 'HY-DATA-0001'),
  collector_activated_at timestamptz not null,
  reported_at timestamptz not null,
  rows_collected integer not null check (rows_collected >= 0),
  symbols_covered jsonb not null,
  expected_observation_count integer not null check (expected_observation_count >= 0),
  actual_observation_count integer not null check (actual_observation_count >= 0),
  valid_observation_count integer not null check (valid_observation_count >= 0),
  missing_intervals jsonb not null,
  stale_observations integer not null check (stale_observations >= 0),
  maximum_collection_delay_ms bigint,
  last_successful_timestamp timestamptz,
  status text not null check (status in ('HEALTHY', 'DEGRADED')),
  details jsonb not null,
  signal_only boolean not null default true check (signal_only = true),
  authorization_mode text not null default 'PAPER_ONLY' check (authorization_mode = 'PAPER_ONLY'),
  live_orders_enabled boolean not null default false check (live_orders_enabled = false),
  account_api boolean not null default false check (account_api = false),
  order_api boolean not null default false check (order_api = false),
  automatic_trading boolean not null default false check (automatic_trading = false),
  created_at timestamptz not null default timezone('utc', now())
);

create or replace function public.hengyu_hy_data_0001_immutable()
returns trigger
language plpgsql
security invoker
as $$
begin
  raise exception 'HY-DATA-0001 append-only row';
end;
$$;

drop trigger if exists hengyu_hy_data_0001_activation_immutable on public.hengyu_hy_data_0001_activation;
create trigger hengyu_hy_data_0001_activation_immutable
before update or delete on public.hengyu_hy_data_0001_activation
for each row execute function public.hengyu_hy_data_0001_immutable();

drop trigger if exists hengyu_hy_data_0001_observations_immutable on public.hengyu_hy_data_0001_observations;
create trigger hengyu_hy_data_0001_observations_immutable
before update or delete on public.hengyu_hy_data_0001_observations
for each row execute function public.hengyu_hy_data_0001_immutable();

drop trigger if exists hengyu_hy_data_0001_health_immutable on public.hengyu_hy_data_0001_health;
create trigger hengyu_hy_data_0001_health_immutable
before update or delete on public.hengyu_hy_data_0001_health
for each row execute function public.hengyu_hy_data_0001_immutable();

alter table public.hengyu_hy_data_0001_activation enable row level security;
alter table public.hengyu_hy_data_0001_observations enable row level security;
alter table public.hengyu_hy_data_0001_health enable row level security;

revoke all on public.hengyu_hy_data_0001_activation from public, anon, authenticated;
revoke all on public.hengyu_hy_data_0001_observations from public, anon, authenticated;
revoke all on public.hengyu_hy_data_0001_health from public, anon, authenticated;
grant select, insert on public.hengyu_hy_data_0001_activation to service_role;
grant select, insert on public.hengyu_hy_data_0001_observations to service_role;
grant select, insert on public.hengyu_hy_data_0001_health to service_role;

drop policy if exists hengyu_hy_data_0001_activation_deny_public on public.hengyu_hy_data_0001_activation;
create policy hengyu_hy_data_0001_activation_deny_public
on public.hengyu_hy_data_0001_activation for all to anon, authenticated
using (false) with check (false);

drop policy if exists hengyu_hy_data_0001_observations_deny_public on public.hengyu_hy_data_0001_observations;
create policy hengyu_hy_data_0001_observations_deny_public
on public.hengyu_hy_data_0001_observations for all to anon, authenticated
using (false) with check (false);

drop policy if exists hengyu_hy_data_0001_health_deny_public on public.hengyu_hy_data_0001_health;
create policy hengyu_hy_data_0001_health_deny_public
on public.hengyu_hy_data_0001_health for all to anon, authenticated
using (false) with check (false);
