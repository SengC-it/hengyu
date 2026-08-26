import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDiagnosticResult } from '../src/research/hy-exp-0029-profitability-filter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { result, file, sha256 } = writeDiagnosticResult({ root: ROOT });
const cause = result.rootCauseAnalysis;
const baseline = result.baselineMetrics;
const filtered = result.filteredMetrics;

const table = (groups, columns) => {
  const header = `| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |`;
  const rows = Object.entries(groups).map(([key, value]) => `| ${key} | ${columns.slice(1).map(column => value[column] ?? 'null').join(' | ')} |`);
  return [header, ...rows].join('\n');
};

const markdown = `# HY-EXP-0029 Meta Filter — Frozen Holdout Diagnostic

Status: **DEVELOPMENT_DIAGNOSTIC_ONLY**  
Promotion eligible: **false**  
Final OOS read: **false**  
Source: \`${result.sourceArtifact}\`  
Source SHA-256: \`${result.sourceArtifactSha256}\`

This report uses only the immutable HY-EXP-0028 holdout bytes. It does not modify HY-EXP-0028, create a fresh holdout, read Final OOS, or authorize email delivery.

## Baseline

| Metric | Value |
| --- | ---: |
| Candidates/advisories | ${baseline.candidateCount} / ${baseline.advisoryCount} |
| Gross expectancy (bps) | ${baseline.grossExpectancyBps} |
| Net expectancy 18 bps | ${baseline.net18ExpectancyBps} |
| Net PF 18 bps | ${baseline.net18ProfitFactor} |
| Net expectancy 27 bps | ${baseline.net27ExpectancyBps} |
| Net PF 27 bps | ${baseline.net27ProfitFactor} |
| Net expectancy 36 bps | ${baseline.net36ExpectancyBps} |
| Source-reported portfolio MTM DD | ${baseline.maxMtmDrawdownFraction} |
| Source-reported MTM DD source | ${baseline.maxMtmDrawdownSource} |
| Derived single-trade adverse excursion fraction | ${result.baselineDerivedMetrics.maxSingleTradeAdverseExcursionFraction} |
| Derived portfolio MTM DD | ${result.baselineDerivedMetrics.portfolioMtmDrawdownFraction} (${result.baselineDerivedMetrics.portfolioMtmStatus}) |
| Max loss streak | ${baseline.maxLossStreak} |
| Funding PnL | ${baseline.fundingPnl} |
| Derived trade-loss CVaR 95 | ${result.baselineDerivedMetrics.tradeLossCvar95Bps} bps |
| Derived portfolio CVaR 95 | ${result.baselineDerivedMetrics.portfolioCvar95} (${result.baselineDerivedMetrics.portfolioCvarStatus}) |
| Net PnL without best trade | ${baseline.netPnlWithoutBestTrade} |
| Net PnL without best month | ${baseline.netPnlWithoutBestMonth} |

The 9 bps increase from base to stress is larger than the 5.2378 bps base net expectancy, so the point estimate necessarily crosses below zero. The severe 36 bps projection is also negative.

## Failure decomposition

### Winners versus losers

| Group | Count | Mean MAE (bps) | Mean MFE (bps) | Mean holding (hours) |
| --- | ---: | ---: | ---: | ---: |
| Winners | ${cause.winnerLoser.winners.count} | ${cause.winnerLoser.winners.meanMaeBps} | ${cause.winnerLoser.winners.meanMfeBps} | ${cause.winnerLoser.winners.meanHoldingHours} |
| Losers | ${cause.winnerLoser.losers.count} | ${cause.winnerLoser.losers.meanMaeBps} | ${cause.winnerLoser.losers.meanMfeBps} | ${cause.winnerLoser.losers.meanHoldingHours} |

### Exit reasons

${table(cause.exitReason, ['Exit', 'count', 'net18ExpectancyBps', 'net18Pnl', 'positiveRate'])}

### Symbol and regime breakdown

Symbols:

${table(cause.symbol, ['Symbol', 'count', 'net18ExpectancyBps', 'net18Pnl', 'positiveRate'])}

Regime:

${table(cause.regime, ['Regime', 'count', 'net18ExpectancyBps', 'net18Pnl', 'positiveRate'])}

All 43 rows are BUY/BULL, so side and regime have no discriminating support in this artifact.

### Time and channel diagnostics

Calendar month:

${table(cause.calendarMonth, ['Month', 'count', 'net18ExpectancyBps', 'net18Pnl', 'positiveRate'])}

UTC decision hour:

${table(cause.decisionHourUtc, ['Hour', 'count', 'net18ExpectancyBps', 'net18Pnl', 'positiveRate'])}

Channel distance quartiles are descriptive only and were not used to choose a production threshold:

${table(cause.channelDistanceQuartiles.groups, ['Quartile', 'count', 'net18ExpectancyBps', 'net18Pnl', 'positiveRate'])}

### Funding and streaks

- Realized funding total: **${cause.fundingImpact.totalFundingBps} bps**
- Mean realized funding: **${cause.fundingImpact.meanFundingBps} bps per trade**
- Rows with negative funding: **${cause.fundingImpact.negativeFundingRows}**
- The chronological holdout has a terminal 12-loss streak. This is not used as an outcome-derived filter.
- Best trade: **${baseline.bestTrade.id}**, net PnL **${baseline.bestTrade.netPnl}**; no trade was removed.
- Best-month removal leaves base net PnL **${baseline.netPnlWithoutBestMonth}**; no month was removed.

## Meta filter result

The preregistered purged walk-forward cannot produce an OOF prediction on this artifact: after the 96-hour purge and 24-hour embargo, every validation fold has fewer than the required 12 training rows. Therefore:

- OOF predictions: **${result.oof.predictionCount}**
- SEND_CANDIDATE: **${result.oof.acceptedCount}**
- REJECT_CANDIDATE: **${result.oof.rejectedCount}**
- No-OOF rows: **${result.oof.noOofCount}**
- Filtered risk metrics: **EMPTY_SAMPLE_NOT_EVALUABLE**
- Bootstrap edge: **EDGE_UNCERTAIN**

This is a fail-closed result, not a reason to relax purge, embargo, cost, model, or confidence thresholds. No email candidate is released.

## Next gates

HY-EXP-0029 remains blocked until it has at least 100 validated signals and 120 calendar days, an independently frozen fresh holdout of at least 45 signals, and a PAPER_FORWARD_ONLY gate of at least 30 signals or 30–60 days. Final OOS remains unread.
`;

const reportFile = path.join(ROOT, 'artifacts/HY-EXP-0029/root-cause-analysis.md');
fs.writeFileSync(reportFile, markdown);
console.log(JSON.stringify({
  resultFile: path.relative(ROOT, file).replaceAll('\\', '/'),
  resultSha256: sha256,
  reportFile: path.relative(ROOT, reportFile).replaceAll('\\', '/'),
  oofPredictions: result.oof.predictionCount,
  sendCandidates: result.oof.acceptedCount,
  rejectedCandidates: result.oof.rejectedCount,
  researchStatus: result.researchGate.status,
  finalOosRead: result.finalOosRead,
  paperOnly: result.safety.paperOnly
}, null, 2));
