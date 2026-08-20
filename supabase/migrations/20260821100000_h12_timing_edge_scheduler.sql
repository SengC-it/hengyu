-- H12 timing, scheduler provenance and independently verified edge metadata.
-- This migration remains paper-only and does not create any order capability.

alter table if exists public.hengyu_advisories
  add column if not exists edge_source text,
  add column if not exists edge_model_id text,
  add column if not exists funding_projection_ms bigint;

alter table if exists public.hengyu_scan_diagnostics
  add column if not exists scan_started_at timestamptz,
  add column if not exists scheduler_source text not null default 'unknown',
  add column if not exists scheduler_attempt integer not null default 1;

do $$
begin
  if to_regclass('public.hengyu_scan_diagnostics') is not null
    and not exists (
      select 1
      from pg_constraint
      where conname = 'hengyu_scan_diagnostics_scheduler_attempt_positive'
    ) then
    alter table public.hengyu_scan_diagnostics
      add constraint hengyu_scan_diagnostics_scheduler_attempt_positive
      check (scheduler_attempt > 0);
  end if;
end;
$$;
