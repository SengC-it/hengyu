# HY-EXP-0029 Meta Filter — Frozen Holdout Diagnostic

Status: **DEVELOPMENT_DIAGNOSTIC_ONLY**  
Promotion eligible: **false**  
Final OOS read: **false**  
Source: `artifacts/HY-EXP-0028/holdout-result.json`  
Source SHA-256: `92304ec0252be9ee2bba2e13a9ccc64c923f3b067d91e12513be089d56f3d2e5`

This report uses only the immutable HY-EXP-0028 holdout bytes. It does not modify HY-EXP-0028, create a fresh holdout, read Final OOS, or authorize email delivery.

## Baseline

| Metric | Value |
| --- | ---: |
| Candidates/advisories | 43 / 43 |
| Gross expectancy (bps) | 23.60880158162159 |
| Net expectancy 18 bps | 5.237781100313037 |
| Net PF 18 bps | 1.1506895886413784 |
| Net expectancy 27 bps | -3.7622188996869474 |
| Net PF 27 bps | 1.0701186290763716 |
| Net expectancy 36 bps | -12.762218899686964 |
| MTM DD (source artifact) | 0.07723556081371896 |
| Max loss streak | 12 |
| Funding PnL | -15.491751432713313 |
| Net PnL without best trade | 4.410709182492042 |
| Net PnL without best month | -564.8740225660517 |

The 9 bps increase from base to stress is larger than the 5.2378 bps base net expectancy, so the point estimate necessarily crosses below zero. The severe 36 bps projection is also negative.

## Failure decomposition

### Winners versus losers

| Group | Count | Mean MAE (bps) | Mean MFE (bps) | Mean holding (hours) |
| --- | ---: | ---: | ---: | ---: |
| Winners | 22 | -131.01715626851407 | 477.75291135716776 | 5.916666666666669 |
| Losers | 21 | -503.61834162572825 | 243.2384714368747 | 2.5595240079365076 |

### Exit reasons

| Exit | count | net18ExpectancyBps | net18Pnl | positiveRate |
| --- | --- | --- | --- | --- |
| ATR_STOP | 15 | -390.0149154499548 | -3975.7348472628564 | 0 |
| TERMINAL_EXIT | 28 | 216.98029710938516 | 4647.513315109654 | 0.7857142857142857 |

### Symbol and regime breakdown

Symbols:

| Symbol | count | net18ExpectancyBps | net18Pnl | positiveRate |
| --- | --- | --- | --- | --- |
| BNBUSDT | 6 | -17.915830562025707 | 25.607604250079078 | 0.5 |
| BTCUSDT | 4 | 90.35615199948396 | 477.7037414838344 | 0.75 |
| DOGEUSDT | 6 | -52.54605492596241 | -44.630872839699464 | 0.5 |
| ETHUSDT | 3 | -100.19487398465554 | -415.25259323032867 | 0 |
| LINKUSDT | 5 | -67.90812341915988 | -426.6771107314272 | 0.4 |
| LTCUSDT | 3 | 183.37533258801213 | 596.5712839474763 | 1 |
| SOLUSDT | 9 | 3.996842644823049 | 210.58780391436073 | 0.5555555555555556 |
| XRPUSDT | 7 | 48.65699281796794 | 247.86861105250347 | 0.42857142857142855 |

Regime:

| Regime | count | net18ExpectancyBps | net18Pnl | positiveRate |
| --- | --- | --- | --- | --- |
| BULL | 43 | 5.23778110031304 | 671.7784678467983 | 0.5116279069767442 |

All 43 rows are BUY/BULL, so side and regime have no discriminating support in this artifact.

### Time and channel diagnostics

Calendar month:

| Month | count | net18ExpectancyBps | net18Pnl | positiveRate |
| --- | --- | --- | --- | --- |
| 2026-07 | 2 | -164.9494384327639 | -564.8740225660517 | 0 |
| 2026-08 | 41 | 13.53959668729241 | 1236.65249041285 | 0.5365853658536586 |

UTC decision hour:

| Hour | count | net18ExpectancyBps | net18Pnl | positiveRate |
| --- | --- | --- | --- | --- |
| 10 | 1 | -101.40401470172485 | -48.39643772770224 | 0 |
| 13 | 2 | -164.9494384327639 | -564.8740225660517 | 0 |
| 16 | 1 | 181.41916747337874 | 165.67008486562946 | 1 |
| 21 | 1 | 717.1584611861695 | 484.95370083617314 | 1 |
| 22 | 4 | 165.81547338900725 | 455.80079192535425 | 0.75 |
| 23 | 5 | 467.1389191445498 | 1569.759774103261 | 0.8 |
| 00 | 1 | 541.1650539120816 | 245.68771181122148 | 1 |
| 01 | 2 | 210.96122382214378 | 554.7364286085871 | 1 |
| 02 | 2 | 132.91073063508995 | 321.7156753807708 | 1 |
| 03 | 3 | -407.11597019494315 | -790.0157126732287 | 0 |
| 04 | 4 | -434.01770779779173 | -1048.6758149851353 | 0 |
| 05 | 5 | -429.4425187799082 | -1310.2143614161228 | 0 |
| 06 | 1 | -82.81054021344464 | -101.05598818474765 | 0 |
| 07 | 1 | 139.4442827616111 | 202.7214439287282 | 1 |
| 08 | 3 | 38.97057664199686 | 209.8315207072161 | 0.6666666666666666 |
| 09 | 7 | 65.88146590245978 | 324.1336732328454 | 0.7142857142857143 |

Channel distance quartiles are descriptive only and were not used to choose a production threshold:

| Quartile | count | net18ExpectancyBps | net18Pnl | positiveRate |
| --- | --- | --- | --- | --- |
| Q1 | 11 | -77.7952288087049 | -157.77024652206325 | 0.5454545454545454 |
| Q2 | 11 | 150.93439429350317 | 982.2727157748157 | 0.5454545454545454 |
| Q3 | 10 | -112.65010725901365 | -907.7993010973792 | 0.3 |
| Q4 | 11 | 49.744985415528795 | 755.0752996914254 | 0.6363636363636364 |

### Funding and streaks

- Realized funding total: **-15.953880696268154 bps**
- Mean realized funding: **-0.37102048130856174 bps per trade**
- Rows with negative funding: **16**
- The chronological holdout has a terminal 12-loss streak. This is not used as an outcome-derived filter.
- Best trade: **XRPUSDT:1787353200000**, net PnL **667.3677586643063**; no trade was removed.
- Best-month removal leaves base net PnL **-564.8740225660517**; no month was removed.

## Meta filter result

The preregistered purged walk-forward cannot produce an OOF prediction on this artifact: after the 96-hour purge and 24-hour embargo, every validation fold has fewer than the required 12 training rows. Therefore:

- OOF predictions: **0**
- SEND_CANDIDATE: **0**
- REJECT_CANDIDATE: **43**
- No-OOF rows: **43**
- Filtered risk metrics: **EMPTY_SAMPLE_NOT_EVALUABLE**
- Bootstrap edge: **EDGE_UNCERTAIN**

This is a fail-closed result, not a reason to relax purge, embargo, cost, model, or confidence thresholds. No email candidate is released.

## Next gates

HY-EXP-0029 remains blocked until it has at least 100 validated signals and 120 calendar days, an independently frozen fresh holdout of at least 45 signals, and a PAPER_FORWARD_ONLY gate of at least 30 signals or 30–60 days. Final OOS remains unread.
