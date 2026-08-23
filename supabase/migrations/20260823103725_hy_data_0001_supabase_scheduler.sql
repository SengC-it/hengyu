create or replace function public.hy_data_0001_invoke_collector()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, net, vault
as $$
declare
  v_secret text;
  v_url text;
  v_now timestamptz;
  v_timestamp text;
  v_body jsonb;
  v_body_text text;
  v_signature text;
  v_request_id bigint;
begin
  v_now := clock_timestamp();

  select decrypted_secret
    into v_secret
  from vault.decrypted_secrets
  where name = 'hy_data_0001_ingest_secret'
  limit 1;

  select decrypted_secret
    into v_url
  from vault.decrypted_secrets
  where name = 'hy_data_0001_collector_url'
  limit 1;

  if v_secret is null or length(v_secret) < 32 then
    raise exception 'HY_DATA_0001_SECRET_UNAVAILABLE';
  end if;

  if v_url is null or v_url = '' then
    raise exception 'HY_DATA_0001_URL_UNAVAILABLE';
  end if;

  v_timestamp := floor(extract(epoch from v_now))::bigint::text;

  v_body := jsonb_build_object(
    'schedulerSource', 'supabase-cron-hy-data-0001',
    'scheduledAt', to_char(
      v_now at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  );

  -- pg_net sends body::text as UTF-8; sign the exact serialized payload.
  v_body_text := v_body::text;

  v_signature := encode(
    extensions.hmac(
      v_timestamp || '.' || v_body_text,
      v_secret,
      'sha256'
    ),
    'hex'
  );

  v_request_id := net.http_post(
    url := v_url,
    body := v_body,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-hengyu-timestamp', v_timestamp,
      'x-hengyu-signature', v_signature
    ),
    timeout_milliseconds := 55000
  );

  return v_request_id;
end;
$$;

revoke all on function public.hy_data_0001_invoke_collector() from public, anon, authenticated;
grant execute on function public.hy_data_0001_invoke_collector() to postgres, service_role;
