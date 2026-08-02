# H9 loss-control additions

The forward model adds controls for the main failure paths identified in the system audit:

- A local order-book sequence gap, duplicate update, crossed book, or missing snapshot prevents any event from entering PnL.
- A recovery decision requires a causal book observation, a pre-event median depth, and a fixed adverse-extreme test.
- Entry latency is measured from received timestamps and capped at two seconds.
- Exit is the first causal stop or 15-minute book observation; missing exit depth rejects the event.
- Funding crossing a settlement requires an official funding-rate row and a mark price known at or before the settlement.
- Base and stressed PnL are kept separate; the promotion screen uses stressed results.
- Cluster IDs are five-minute UTC buckets, so best-five removal cannot treat simultaneous symbols as independent evidence.
- The collector remains public-data only and has no private endpoint or order-placement path.
- The replay rejects records at or before the project forward boundary (`2026-07-30T16:00:00.000Z`) instead of filtering them invisibly.
