# Point-in-time dynamic USD-M universe

`src/model/universe.mjs` builds a deterministic snapshot from exchange info,
24-hour ticker data and a two-sided depth observation. Eligibility uses only
values available at `observedAt`:

- perpetual contracts quoted in USDT or USDC;
- trading status and listing age of at least 30 days;
- no stablecoin or leveraged-token base asset;
- Tier A: at least 10,000,000 USDT quote volume and 500,000 USDT depth on each
  side within 10 bps;
- Tier B: at least 1,000,000 USDT quote volume and 100,000 USDT depth on each
  side within 10 bps.

Missing, stale or future-dated source data excludes a symbol and records the
reason. It never falls back to a current symbol list. The snapshot includes a
SHA-256 `universeVersion` so a forward segment can be audited against the exact
symbol set used by its streams.

Create a snapshot with:

```powershell
npm.cmd run universe:snapshot -- --policy config/universe-policy.json
```

Use the snapshot for a public-only dynamic segment:

```powershell
npm.cmd run forward:capture:dynamic:proxy -- --seconds 86400
```

The command writes public book/trade/force-order/mark-price, funding and open
interest records. A failed WebSocket, failed REST poll, sequence gap or stale
book makes that segment unavailable for PnL.

