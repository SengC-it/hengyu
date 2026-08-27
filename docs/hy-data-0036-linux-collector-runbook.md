# HY-DATA-0036 Linux engineering canary runbook

This runbook is for the single engineering canary only. It does not activate
formal collection, create `collectionStartAt`, promote engineering data to
research, or enable any strategy/PnL path. Do not enable this unit as a
long-running formal collector without a separate activation approval.

## Target host

Use a dedicated Linux host or container with Node.js 24, a persistent volume,
and `chrony`. Vercel, GitHub Actions, and cron are not collector hosts. The
host clock must be trusted before the canary starts:

```sh
node --version                 # Node 24.x
chronyc tracking
timedatectl show --property=NTPSynchronized --property=NTPOffsetUSec
```

The runtime requires `CLOCK_TRUSTED` and an absolute host offset of at most
500 ms. Installing or configuring chrony is an infrastructure operation; do
not change the system clock to manufacture a passing result. Binance server
time is only a secondary public reachability check.

## Storage configuration

Store environment values in a root-owned, mode-`0600` file outside the
repository, for example `/etc/hengyu/hy-data-0036-canary.env`. Never commit
this file or include its contents in a report:

```dotenv
HY_DATA_0036_LOCAL_SPOOL_ROOT=/var/lib/hengyu/engineering/hy-data-0036
HY_DATA_0036_CANARY_MIN_SPOOL_BYTES=50000000000
HY_DATA_0036_REMOTE_CAPACITY_BYTES=<planned-private-bucket-capacity>
HY_DATA_0036_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
HY_DATA_0036_S3_REGION=auto
HY_DATA_0036_S3_ACCESS_KEY_ID=<write-only-scoped-access-key>
HY_DATA_0036_S3_SECRET_ACCESS_KEY=<secret>
HY_DATA_0036_S3_BUCKET=hengyu-microstructure
HY_DATA_0036_S3_PREFIX=hy-data-0036/
```

The six `HY_DATA_0036_S3_*` values are required for the provider-neutral
adapter. The preflight writes a tiny engineering probe, verifies its HEAD
metadata SHA-256, reads and hashes it when supported, and deletes it only
after verification. Environment presence alone is never a storage pass.
The bucket must be private and the credential must be limited to object
read/write for the designated bucket/prefix. The canary minimum spool value
only permits the one-hour sizing run; the post-canary 72-hour gate is
recomputed from measured compressed bytes/hour.

## Process supervisor

The following systemd unit is an engineering-canary template. It uses a
persistent spool and restarts an interrupted process, but it must remain
disabled until the preflight is reviewed. It is not a formal collection
scheduler.

```ini
[Unit]
Description=HY-DATA-0036 engineering canary
After=network-online.target chronyd.service
Wants=network-online.target
ConditionPathIsDirectory=/var/lib/hengyu/engineering/hy-data-0036

[Service]
Type=exec
User=hengyu
Group=hengyu
EnvironmentFile=/etc/hengyu/hy-data-0036-canary.env
WorkingDirectory=/opt/hengyu
ExecStart=/usr/bin/node /opt/hengyu/scripts/hy-data-0036-collector.mjs --dry-run --duration-ms 3600000 --max-symbols 8
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
ReadWritePaths=/var/lib/hengyu/engineering/hy-data-0036

[Install]
WantedBy=multi-user.target
```

Do not add a cron trigger, Vercel cron, GitHub schedule, or a service
`WantedBy` activation for formal collection. Before use, verify the unit
source tree is the reviewed commit and that the spool volume is persistent.

## Preflight and canary sequence

Run the preflight on the final Linux host with a unique run id and an
engineering-only root. The command fails before opening the canary when any
hard gate is absent:

```sh
set -eu
npm ci
npm audit --omit=dev --audit-level=high
npm run data:hy-0036:dry-run -- \
  --duration-ms 3600000 \
  --max-symbols 8 \
  --run-id canary-YYYYMMDD-0036 \
  --preflight-report artifacts/HY-DATA-0036/engineering-preflight-YYYYMMDD.json
```

The command must use `HY_DATA_0036_LOCAL_SPOOL_ROOT` for its raw root unless
an explicit engineering `--raw-root` is supplied. The preflight and runtime
share the same storage adapter and the same spool root. A successful
preflight is necessary but not sufficient: the canary must also run at least
3,600,000 ms, include all eight frozen symbols, rotate/reconnect around 25
minutes, obtain a fresh REST snapshot, wait for and pass the bridge, and
produce verified 1s/5s/1m feature partitions.

## Evidence and stop rules

Review only the new run's immutable manifest and report. The old
`canary-20260827-0036` report is historical and must never be overwritten.
Every failure remains visible. Stop with `ENGINEERING_CANARY_FAIL` if any
REST 418/429, host clock failure, missing/invalid depth sequence, crossed
book, buffer limit, durability, feature, or capacity gate occurs. In
particular, a successful REST storage probe does not prove the 72-hour local
or twice-90-day remote capacity gate; those are measured after the full
one-hour run.

Only if every canary gate passes may the separate activation artifact become
`READY_FOR_EXPLICIT_COLLECTION_ACTIVATION`. Even then it remains
`activated=false` and `collectionStartAt=null` until a distinct human-
approved collection activation writes the boundary.
