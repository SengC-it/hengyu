# Signal-only hosting

The collector and dashboard are separate processes:

```powershell
# public data collector (run on a compliant VPS/container)
node --use-env-proxy scripts/forward-capture-dynamic.mjs --seconds 86400

# read-only dashboard and JSON API (binds to localhost by default)
npm.cmd run advisory:server
```

The collector uses only public Binance USD-M endpoints. It never accepts an API
key and never exposes a private order route. A failed WebSocket, HTTP 451/403,
REST error, sequence gap or stale book invalidates the segment; it is recorded
as unavailable rather than retried into a false PnL sample.

To expose the dashboard outside the VPS, put it behind an authenticated TLS
reverse proxy and explicitly pass `--allow-public --host 0.0.0.0`. The Node
server itself is intentionally not an authentication layer.

Email delivery is a provider-neutral NDJSON outbox. `STRONG` entries are
marked `IMMEDIATE`, `MEDIUM` entries `DIGEST_15M`, and `OBSERVE` entries are
web-only. A Gmail/SMTP adapter can consume the outbox after credentials are
provided; Binance credentials are never required.

