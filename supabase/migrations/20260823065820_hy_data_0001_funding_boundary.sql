-- Corrective HY-DATA-0001 schema migration.
-- The previous migration named the latest settled funding event ambiguously;
-- this rename preserves the raw event timestamp without changing its meaning.
-- No historical rows are backfilled by this migration.

alter table public.hengyu_hy_data_0001_observations
  rename column funding_time to last_settled_funding_time;

alter table public.hengyu_hy_data_0001_observations
  add column last_settled_funding_rate numeric;

alter table public.hengyu_hy_data_0001_observations
  add column source_commit text;
