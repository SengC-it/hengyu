-- Candidate Engine observability and executable paper-entry accounting.
-- This migration remains paper-only and does not create any order capability.

alter table if exists public.hengyu_advisories
  add column if not exists decision_at timestamptz,
  add column if not exists scheduler_delay_ms bigint,
  add column if not exists theoretical_open numeric,
  add column if not exists executable_price numeric,
  add column if not exists spread_bps numeric,
  add column if not exists holding_period_ms bigint,
  add column if not exists funding_cost_bps numeric,
  add column if not exists funding_event_count integer,
  add column if not exists mae_bps numeric,
  add column if not exists mfe_bps numeric,
  add column if not exists mark_to_market_drawdown_bps numeric;

alter table if exists public.hengyu_model_simulations
  add column if not exists holding_period_ms bigint,
  add column if not exists funding_event_count integer,
  add column if not exists funding_cost_bps numeric,
  add column if not exists mae_bps numeric,
  add column if not exists mfe_bps numeric,
  add column if not exists mark_to_market_drawdown_bps numeric;

create table if not exists public.hengyu_scan_diagnostics (
  scan_id uuid primary key default gen_random_uuid(),
  scan_key text not null unique,
  service_name text not null,
  strategy_id text not null,
  experiment_id text not null,
  observed_at timestamptz not null,
  decision_at timestamptz,
  signal_time timestamptz,
  theoretical_open_at timestamptz,
  scheduler_delay_ms bigint,
  status text not null check (status in ('SIGNAL', 'NO_SIGNAL', 'MISSED_SIGNAL', 'FAILED')),
  regime_pass boolean,
  breadth integer,
  btc_fast_sma numeric,
  btc_slow_sma numeric,
  candidate_count integer not null default 0,
  signal_count integer not null default 0,
  missed_count integer not null default 0,
  reasons jsonb not null default '[]'::jsonb,
  regime jsonb not null default '{}'::jsonb,
  symbols jsonb not null default '{}'::jsonb,
  details jsonb not null default '{}'::jsonb,
  authorization_mode text not null default 'PAPER_ONLY'
    check (authorization_mode = 'PAPER_ONLY'),
  live_orders_enabled boolean not null default false
    check (live_orders_enabled = false),
  created_at timestamptz not null default now()
);

create index if not exists hengyu_scan_diagnostics_strategy_time_idx
  on public.hengyu_scan_diagnostics (strategy_id, observed_at desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'hengyu_scan_diagnostics_append_only') then
    create trigger hengyu_scan_diagnostics_append_only
    before update or delete on public.hengyu_scan_diagnostics
    for each row execute function public.hengyu_reject_mutation();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'hengyu_scan_diagnostics_no_truncate') then
    create trigger hengyu_scan_diagnostics_no_truncate
    before truncate on public.hengyu_scan_diagnostics
    for each statement execute function public.hengyu_reject_mutation();
  end if;
end;
$$;

alter table public.hengyu_scan_diagnostics enable row level security;
revoke all on public.hengyu_scan_diagnostics from anon, authenticated;
grant select, insert on public.hengyu_scan_diagnostics to service_role;
