# HY-DATA-0001 collector specification

## Scope and safety

HY-DATA-0001 is a fresh, prospective public Binance USD-M data collection. It
does not generate signals, evaluate a strategy, send trading email, read Final
OOS data, place orders, or call account/private APIs. The fixed authorization
invariant is `SIGNAL_ONLY=true`, `PAPER_ONLY=true`,
`liveOrdersEnabled=false`, `accountApi=false`, `orderApi=false`, and
`automaticTrading=false`.

The collector reuses the existing Hengyu Supabase project and Vercel Singapore
runtime. It does not modify historical experiment artifacts or use historical
data to fill this dataset.

## Prospective evidence boundary

`collectorActivatedAt` is the beginning of HY-DATA-0001 evidence. It is either
an explicitly configured, valid runtime timestamp or, when no timestamp is
configured, the `requestStartedAt` of the first accepted collector cycle. The
activation record is persisted before observations are accepted.

Every prospective observation must satisfy all three boundary checks:
`observationAt >= collectorActivatedAt`,
`requestStartedAt >= collectorActivatedAt`, and
`receivedAt >= collectorActivatedAt`. A completed 5m bar used as a feature must
also have `barOpenTime >= collectorActivatedAt`. A pre-activation observation,
request, receipt, future source timestamp, historical backfill, forward-filled
value, or synthetic order-book value is rejected for research and retained
only as an operational failure diagnostic when appropriate.

`lastSettledFundingTime` is a state/event timestamp, not the observation
boundary. It may predate `collectorActivatedAt` when the latest settled funding
row is retrieved through a live request after activation; the original event
time is preserved for audit. A missing interval is never filled by the previous
value.

The five-minute observation key is the UTC five-minute boundary. The database
idempotency key is `SYMBOL:observationAt`; an already accepted key is ignored,
never updated with a later value.

## Fixed universe and cadence

The first dataset uses exactly these Binance USD-M perpetual symbols:

`BTCUSDT`, `ETHUSDT`, `BNBUSDT`, `SOLUSDT`, `XRPUSDT`, `DOGEUSDT`, `LINKUSDT`,
`LTCUSDT`.

One cycle is attempted every five minutes. A complete cycle therefore expects
8 rows per interval, 288 intervals per UTC day, or **2,304 symbol rows per
day**. A row is not considered valid merely because the HTTP request returned
200.

## Causal public sources

All calls use `https://fapi.binance.com/fapi/v1` and are public market-data
calls only:

| Data | Endpoint | Causal selection |
| --- | --- | --- |
| Mark, index, current/next funding context | `/premiumIndex?symbol=...` | `lastFundingRate` is `currentFundingRate`; keep exchange time and receipt time; never use a future event. |
| Open interest | `/openInterest?symbol=...` | Keep the exchange timestamp and receipt time. |
| Best bid/ask and small depth | `/depth?symbol=...&limit=5` | Store the top five levels, update id, and crossed-book check. |
| Settled funding state | `/fundingRate?symbol=...&limit=1` | Store `fundingRate` as `lastSettledFundingRate` and `fundingTime` as `lastSettledFundingTime`; require event time `<= receivedAt`, but do not use it as current funding. |
| Completed 5m bar | `/klines?symbol=...&interval=5m&limit=2` | Select only a row with `closeTime < requestStartedAt`; no historical backfill. |

The kline array is normalized to open/close time, OHLCV, quote volume, trade
count, and taker-buy base/quote volume. `takerBuyRatio` is computed only when
total volume is a valid positive number. `premiumBasisBps` is computed only
when mark and index prices are valid and positive.

For each endpoint, `requestStartedAt` is captured immediately before `fetch`,
the response body is fully awaited, and only then is `receivedAt` captured.
`exchangeEventAt` is taken from the source payload when available. The row
stores endpoint/type, raw payload, normalized values, and per-source
timestamps, so a later analyst can distinguish exchange time from local
receipt time.

## Quality and fail-closed rules

The frozen source-age limit is 600,000 ms. The collector flags and excludes a
row for research if any required source is stale, missing its symbol, contains
an invalid numeric value, reverses timestamp order, repeats the completed bar,
has a crossed book, lacks a completed bar, or violates the activation boundary.
There is no silent retry repair or forward fill. A retry may produce a new
cycle attempt, but it cannot rewrite an accepted idempotency key.

The previous accepted observation for the symbol is used only to detect a
source timestamp reversal and enumerate skipped UTC five-minute boundaries.
It is never used as a replacement value. Health reports count the actual
accepted/invalid rows and list every missing boundary, stale observation and
scheduler delay separately.

Each activation row must record the actual collector implementation commit.
The runtime accepts only `HY_DATA_0001_SOURCE_COMMIT` or
`VERCEL_GIT_COMMIT_SHA`; if neither is available the collector fails closed.
The design/base commit is not a valid runtime fallback.

## Storage and health

The existing Supabase project gets a dedicated `hengyu_hy_data_0001_*` table
namespace. Service-role access is required; RLS and explicit deny policies
protect the tables from anon/authenticated clients. Evidence and health rows
are append-only. The migration is delivered in the repository and is not
applied automatically.

The collector endpoint is `POST /api/hy-data-0001-collect`, deployed in the
existing Vercel Singapore region only after the deployment checklist is
reviewed. The GitHub Action calls it every five minutes using the existing
signed-request pattern and a dedicated ingestion secret. It reports collector
failure only; it never dispatches Gmail trading alerts.

## HY-SCREEN-0002 boundary

The five proposed candidate families are documented separately as research
definitions only. No family runs in this collection stage, and no threshold
is chosen from future observations. Any later screen must use rows whose
observation and all source timestamps are after `collectorActivatedAt`, with a
separate preregistration and review.
