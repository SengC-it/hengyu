# Forward collection recovery

## Diagnosis on 2026-08-01

The machine could resolve Binance DNS, but direct TCP/TLS access to
`fapi.binance.com:443` timed out. The configured local proxy at
`127.0.0.1:10808` was reachable and returned HTTP 200 for the public Futures
time and depth endpoints. A Node WebSocket opened successfully when started
with proxy support. This evidence points to a local route/proxy configuration
problem, not a confirmed Binance regional block. A regional block cannot be
ruled out for a different proxy exit IP.

Node's `--use-env-proxy` option reads `HTTP_PROXY`, `HTTPS_PROXY`, and
`NO_PROXY`. The project provides a proxy-aware capture command:

```powershell
Test-NetConnection 127.0.0.1 -Port 10808
npm.cmd run forward:capture:proxy -- --seconds 300 --symbols BTCUSDT
```

Validate the resulting directory before using it for research:

```powershell
npm.cmd run forward:validate -- data/raw/forward/<run-id>
npm.cmd run h9:replay -- --capture data/raw/forward/<run-id>
npm.cmd run forward:ledger -- --root data/raw/forward --output registry/experiments/HY-EXP-0013/forward-ledger-<n>.json --register 1
```

Capture attempts 003, 004, and 005 passed record and depth validation. Attempt
005 covered BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT, and DOGEUSDT for
fifteen minutes and produced 291,512 valid records. These are continuity and
warmup segments, not profitability samples. For the formal experiment, keep
the process running in daily segments and retain every manifest. A failed
segment is recorded as a data availability failure; it is not silently merged
or repaired.

The forward ledger records every complete, invalid, failed, or unmanifested
segment. It reports time gaps, symbol-universe mismatches, and whether the
observed coverage is continuous enough for H9 PnL. Separate daily directories
must not be treated as one continuous sample until this ledger marks the
coverage continuous; a gap prevents the segment from entering the PnL sample.

If the local proxy is unavailable or its exit IP receives HTTP 451/403, move
only the public-data collector to a compliant hosted environment. Do not add
API keys or order endpoints, and do not bypass a jurisdictional restriction.

The collector's snapshot procedure now buffers depth updates and retries the
REST snapshot until `U <= lastUpdateId <= u`; after the first aligned event it
requires only `pu == previous u`. This matches Binance's local-order-book
procedure and prevents false sequence-gap rejections.

Capture attempt 006 (2026-08-01 05:12 UTC) is excluded: both WebSocket routes
failed and all six funding-rate requests returned HTTP 451 through the proxy
exit route. The collector now stops promptly when a WebSocket fails instead of
waiting the full requested duration; the failed manifest remains evidence of
the route problem. A stable public-data route is required before formal
continuous collection can resume.
