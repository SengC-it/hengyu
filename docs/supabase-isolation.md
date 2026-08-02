# Supabase shared-project isolation

Hengyu Research currently uses the existing Supabase project `crypto-alerts`:

- Project ref: `jfvbikivtpfjgfsnggiz`
- Region: `ap-northeast-1`
- API URL: `https://jfvbikivtpfjgfsnggiz.supabase.co`

This is an approved shared-project exception. It does not authorize Hengyu code to
read, update, rename, or delete any existing `crypto-alerts` tables.

## Naming boundary

Every new Hengyu table must start with `hengyu_`. Existing tables such as
`hengshi_*`, `tele*`, `telesg_*`, `teleeg_*`, `gpt_*`, and `ds_*` remain unchanged.

The initial database objects are:

- `hengyu_experiments`
- `hengyu_universe_snapshots`
- `hengyu_capture_segments`
- `hengyu_raw_chunk_manifest`
- `hengyu_data_quality`
- `hengyu_advisories`
- `hengyu_model_simulations`
- `hengyu_email_outbox`
- `hengyu_email_deliveries`
- `hengyu_registry_events`
- `hengyu_system_heartbeats`

## Access boundary

- All Hengyu tables have RLS enabled.
- `anon` and `authenticated` have no table privileges and an explicit deny policy.
- Only the Vercel server-side service key may access these tables.
- The service key must never be sent to the browser or committed to GitHub.
- Registry, raw-chunk manifests, and email-delivery rows are append-only through
  database triggers.

The public project schema contains legacy tables with pre-existing advisor notices.
Those notices are not silently changed by Hengyu migrations. Advisor checks for new
Hengyu objects must remain free of security warnings; unused-index notices are
expected until the new tables receive data.

## Applied remote migrations

The remote migration was split because the first single request exceeded the MCP
transport window. The applied records are:

1. `hengyu_core_tables_base_20260801`
2. `hengyu_core_tables_security_20260801`
3. `hengyu_core_advisor_fix_20260801`
4. `hengyu_append_only_hardening_20260801`

The combined, idempotent SQL is kept in
`supabase/migrations/20260801135000_hengyu_core_tables.sql` as the source review
artifact. Future schema changes must add a new migration and must not edit this one.
