import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildHyExp0024DevelopmentRows,
  HISTORICAL_BASE_COST_BPS,
  HISTORICAL_STRESS_COST_BPS,
  HY_EXP_0024_EXPERIMENT_ID,
  loadHyExp0024Dataset
} from '../src/research/hy-exp-0024.mjs';
import { HY_EXP_0024_FEATURES } from '../src/model/hy-exp-0024-edge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', HY_EXP_0024_EXPERIMENT_ID);
const DEVELOPMENT_MANIFEST = path.join(ARTIFACT_DIR, 'development-manifest.json');
const DEVELOPMENT_RESULT = path.join(ARTIFACT_DIR, 'development-result.json');
const DEVELOPMENT_DIAGNOSTICS = path.join(ARTIFACT_DIR, 'development-diagnostics.jsonl');
const DECOMPOSITION = path.join(ARTIFACT_DIR, 'failure-decomposition.json');
const CLOSURE = path.join(ARTIFACT_DIR, 'closure.json');

const EXPECTED = Object.freeze({
  rawCandidates: 2459,
  labeledCandidates: 2459,
  oofPredictions: 1412,
  edgeAvailable: 1412,
  advisories: 0,
  rejections: {
    INSUFFICIENT_CONSERVATIVE_NET_EDGE: 1412,
    INSUFFICIENT_COST_COVERAGE: 738,
    NON_POSITIVE_PRICE_EDGE: 334
  },
  calibration: {
    MAE: 182.5993,
    RMSE: 240.2098,
    zeroMAE: 173.1599,
    zeroRMSE: 232.7283,
    maeRatio: 1.0545,
    rmseRatio: 1.0321,
    slope: -0.7127,
    spearman: -0.1267
  }
});

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path.relative(ROOT, file)} line ${index + 1} is invalid JSON: ${error.message}`);
      }
    });
}

function round(value) {
  return value == null || !Number.isFinite(value) ? value : Number(value.toFixed(6));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function monthKey(time) {
  return new Date(time).toISOString().slice(0, 7);
}

function quarterKey(time) {
  const date = new Date(time);
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function rowMetrics(row) {
  const grossBps = Number(row.label.grossPriceReturnBps);
  const fundingBps = Number(row.label.realizedFunding?.fundingPnlBps ?? 0);
  if (!Number.isFinite(grossBps) || !Number.isFinite(fundingBps)) {
    throw new Error(`invalid realized return/funding in ${row.id}`);
  }
  return {
    grossBps,
    fundingBps,
    net18Bps: grossBps + fundingBps - HISTORICAL_BASE_COST_BPS,
    net27Bps: grossBps + fundingBps - HISTORICAL_STRESS_COST_BPS
  };
}

function profitFactor(rows) {
  const positive = rows.filter(row => row.net18Bps > 0).reduce((sum, row) => sum + row.net18Bps, 0);
  const negative = rows.filter(row => row.net18Bps < 0).reduce((sum, row) => sum + row.net18Bps, 0);
  if (negative < 0) return { value: positive / Math.abs(negative), display: String(positive / Math.abs(negative)) };
  if (positive > 0) return { value: Infinity, display: 'Infinity (no losses)' };
  return { value: null, display: 'not evaluable' };
}

function summarizeRows(rows) {
  const metrics = rows.map(row => ({ ...rowMetrics(row), row }));
  const pf = profitFactor(metrics);
  const observedMonths = [...new Set(metrics.map(item => monthKey(item.row.label.exitTime)))].sort();
  const monthlyNet = Object.fromEntries(observedMonths.map(month => [month, 0]));
  for (const item of metrics) monthlyNet[monthKey(item.row.label.exitTime)] += item.net18Bps;
  const positiveMonths = Object.values(monthlyNet).filter(value => value > 0).length;
  const symbolCounts = {};
  for (const item of metrics) symbolCounts[item.row.symbol] = (symbolCounts[item.row.symbol] ?? 0) + 1;
  const maxSymbolShare = metrics.length
    ? Math.max(...Object.values(symbolCounts)) / metrics.length
    : null;
  const calendarMonths = [...new Set(metrics.map(item => monthKey(item.row.signalTime)))].sort();
  return {
    sampleCount: rows.length,
    grossExpectancyBps: round(mean(metrics.map(item => item.grossBps))),
    netExpectancy18Bps: round(mean(metrics.map(item => item.net18Bps))),
    netExpectancy27Bps: round(mean(metrics.map(item => item.net27Bps))),
    profitFactor18: Number.isFinite(pf.value) ? round(pf.value) : null,
    profitFactor18Display: pf.display,
    positiveRate18: round(rows.length ? metrics.filter(item => item.net18Bps > 0).length / rows.length : null),
    positiveMonthCoverage: {
      positiveMonths,
      observedMonths: observedMonths.length,
      fraction: round(observedMonths.length ? positiveMonths / observedMonths.length : null),
      definition: 'exit-month aggregate net18Bps > 0 divided by observed exit months'
    },
    distinctCalendarMonths: calendarMonths.length,
    calendarMonths,
    symbolCounts,
    maxSymbolShare: round(maxSymbolShare)
  };
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries([...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => [key, summarizeRows(values)]));
}

function decileLabels(rows, valueFn) {
  const ordered = [...rows].sort((left, right) => valueFn(left) - valueFn(right) || left.id.localeCompare(right.id));
  const labels = new Map();
  ordered.forEach((row, index) => labels.set(row.id, Math.min(10, Math.floor(index * 10 / ordered.length) + 1)));
  return labels;
}

function quantile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  if (!ordered.length) return null;
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function featureQuartiles(rows, featureIndex) {
  const cutpoints = {
    q25: quantile(rows.map(row => Number(row.features[featureIndex])), 0.25),
    q50: quantile(rows.map(row => Number(row.features[featureIndex])), 0.50),
    q75: quantile(rows.map(row => Number(row.features[featureIndex])), 0.75)
  };
  const bucket = value => value <= cutpoints.q25
    ? 'Q1'
    : value <= cutpoints.q50
      ? 'Q2'
      : value <= cutpoints.q75
        ? 'Q3'
        : 'Q4';
  return { cutpoints, bucket };
}

function robustCandidate(rows, label, summary) {
  const finitePF = summary.profitFactor18 != null;
  const pfValue = finitePF
    ? summary.profitFactor18
    : summary.profitFactor18Display.startsWith('Infinity') ? Infinity : null;
  const checks = {
    sampleCountAtLeast100: summary.sampleCount >= 100,
    netExpectancy18Positive: summary.netExpectancy18Bps != null && summary.netExpectancy18Bps > 0,
    profitFactor18GreaterThan1_10: pfValue != null && pfValue > 1.10,
    distinctCalendarMonthsAtLeast6: summary.distinctCalendarMonths >= 6,
    maxSymbolShareAtMost40Percent: summary.maxSymbolShare != null && summary.maxSymbolShare <= 0.40
  };
  return {
    direction: label,
    ...summary,
    qualificationChecks: checks,
    qualifies: Object.values(checks).every(Boolean)
  };
}

function rankRobustDirections(rows, featureReport) {
  const candidates = [];
  const byCell = groupBy(rows, row => row.cell);
  for (const [cell, summary] of Object.entries(byCell)) {
    candidates.push(robustCandidate(rows.filter(row => row.cell === cell), `model-cell:${cell}`, summary));
  }
  for (const feature of featureReport) {
    const groups = groupBy(rows, row => feature.labels.get(row.id));
    for (const [bucket, summary] of Object.entries(groups)) {
      candidates.push(robustCandidate(rows.filter(row => feature.labels.get(row.id) === bucket), `${feature.name}:${bucket}`, summary));
    }
    for (const cell of [...new Set(rows.map(row => row.cell))].sort()) {
      for (const bucket of ['Q1', 'Q2', 'Q3', 'Q4']) {
        const subset = rows.filter(row => row.cell === cell && feature.labels.get(row.id) === bucket);
        if (!subset.length) continue;
        candidates.push(robustCandidate(subset, `model-cell:${cell}×${feature.name}:${bucket}`, summarizeRows(subset)));
      }
    }
  }
  return candidates
    .filter(candidate => candidate.qualifies)
    .sort((left, right) => right.netExpectancy18Bps - left.netExpectancy18Bps
      || (right.profitFactor18 ?? Infinity) - (left.profitFactor18 ?? Infinity)
      || right.sampleCount - left.sampleCount
      || left.direction.localeCompare(right.direction))
    .slice(0, 3);
}

function verifyFrozenEvidence({ frozenManifest, frozenResult, diagnostics, dataset, rows }) {
  if (frozenManifest.experimentId !== HY_EXP_0024_EXPERIMENT_ID) throw new Error('Development manifest experiment mismatch');
  if (frozenManifest.developmentPnlComputed !== true || frozenManifest.finalOosRead !== false) {
    throw new Error('Development manifest does not prove Development-only source evidence');
  }
  if (frozenResult.experimentId !== HY_EXP_0024_EXPERIMENT_ID
    || frozenResult.finalOosRead !== false
    || frozenResult.finalOosPnlComputed !== false) {
    throw new Error('frozen result is not sealed against Final OOS');
  }
  if (dataset.sourceManifestSha256 !== frozenManifest.sourceManifestSha256) {
    throw new Error('source manifest hash differs from locked Development manifest');
  }
  const predictionIds = new Set(rows.predictions.map(row => row.id));
  const diagnosticIds = new Set(diagnostics.map(row => row.id));
  if (diagnostics.length !== EXPECTED.oofPredictions || predictionIds.size !== diagnosticIds.size) {
    throw new Error('locked diagnostics count does not match the expected OOF population');
  }
  for (const id of predictionIds) if (!diagnosticIds.has(id)) throw new Error(`missing locked diagnostic for ${id}`);
  if (rows.rawCandidateCount !== EXPECTED.rawCandidates || rows.candidates.length !== EXPECTED.labeledCandidates) {
    throw new Error('deterministic Development candidate reconstruction count mismatch');
  }
  if (rows.predictions.length !== EXPECTED.oofPredictions
    || rows.predictions.filter(row => row.edge?.available).length !== EXPECTED.edgeAvailable) {
    throw new Error('deterministic Development OOF reconstruction count mismatch');
  }
}

function buildDecomposition({ rows, sourceHashes }) {
  const labeledRows = rows.candidates;
  const oofRows = rows.predictions.filter(row => row.edge?.available);
  const predictedDeciles = decileLabels(oofRows, row => row.edge.expectedPriceEdgeBps);
  const realizedDecilesOof = decileLabels(oofRows, row => row.label.grossPriceReturnBps);
  const realizedDecilesLabeled = decileLabels(labeledRows, row => row.label.grossPriceReturnBps);
  const oofWithLabels = oofRows.map(row => ({ ...row, predictedDecile: predictedDeciles.get(row.id), realizedDecile: realizedDecilesOof.get(row.id) }));
  const labeledWithLabels = labeledRows.map(row => ({ ...row, realizedDecile: realizedDecilesLabeled.get(row.id) }));
  const featureReport = HY_EXP_0024_FEATURES.map((name, featureIndex) => {
    const quartile = featureQuartiles(oofWithLabels, featureIndex);
    const labels = new Map(oofWithLabels.map(row => [row.id, quartile.bucket(row.features[featureIndex])]));
    return {
      name,
      population: 'OOF edge-available rows (1412), training-independent mechanical cutpoints',
      cutpoints: Object.fromEntries(Object.entries(quartile.cutpoints).map(([key, value]) => [key, round(value)])),
      bucketDefinition: 'Q1 <= q25; Q2 <= q50; Q3 <= q75; Q4 > q75',
      labels,
      buckets: Object.fromEntries(['Q1', 'Q2', 'Q3', 'Q4'].map(bucket => [
        bucket,
        summarizeRows(oofWithLabels.filter(row => labels.get(row.id) === bucket))
      ]))
    };
  });
  const robust = rankRobustDirections(oofWithLabels, featureReport);
  return {
    schemaVersion: 1,
    experimentId: HY_EXP_0024_EXPERIMENT_ID,
    status: 'FAILURE_DECOMPOSITION_COMPLETE',
    source: {
      evidenceClass: 'D0_DEVELOPMENT_ONLY',
      sourceRule: 'Only the locked HY-EXP-0024 Development source manifest and its deterministic frozen candidate/OOF path were used; no Final OOS path was opened.',
      sourceHashes,
      rawCandidateCount: labeledRows.length,
      labeledCandidateCount: labeledRows.length,
      oofPredictionCount: oofRows.length,
      edgeAvailableCount: oofRows.length,
      advisoryCount: 0
    },
    populations: {
      labeledCandidates: {
        count: labeledRows.length,
        description: 'All mechanically labeled candidates before OOF Net Edge filtering'
      },
      oofPredictions: {
        count: oofRows.length,
        description: 'Edge-available purged OOF candidates before Net Edge and Portfolio Risk filtering'
      },
      advisory: {
        count: 0,
        maxMTMDD: null,
        CVaR95: null,
        riskMetricStatus: 'EMPTY_SAMPLE_NOT_EVALUABLE'
      }
    },
    frozenFailureLedger: {
      rejections: EXPECTED.rejections,
      calibration: EXPECTED.calibration
    },
    costDefinitions: {
      grossReturn: 'directional realized price return before costs and funding',
      net18: 'gross price return + realized funding PnL - 18 bps',
      net27: 'gross price return + realized funding PnL - 27 bps',
      baseCostBps: HISTORICAL_BASE_COST_BPS,
      stressCostBps: HISTORICAL_STRESS_COST_BPS
    },
    bucketDefinitions: {
      calendarQuarter: 'signalTime UTC calendar quarter',
      distinctCalendarMonths: 'distinct signalTime UTC months represented in the bucket',
      positiveMonthCoverage: 'observed exit months whose aggregate net18Bps is positive divided by observed exit months',
      predictedEdgeDecile: 'OOF rows ranked ascending by expectedPriceEdgeBps, stable id tie-break, decile 1..10',
      realizedGrossReturnDecile: 'rows ranked ascending by grossPriceReturnBps, stable id tie-break, decile 1..10',
      featureQuartiles: 'OOF-only empirical q25/q50/q75 cutpoints, calculated mechanically without model fitting or threshold search'
    },
    overallOof: summarizeRows(oofRows),
    bullBuy: summarizeRows(oofRows.filter(row => row.cell === 'BULL/BUY/TREND_BREAKOUT')),
    bearSell: summarizeRows(oofRows.filter(row => row.cell === 'BEAR/SELL/TREND_BREAKOUT')),
    groups: {
      regimeSideLabeled: groupBy(labeledWithLabels, row => `${row.regime}/${row.side}`),
      symbolLabeled: groupBy(labeledWithLabels, row => row.symbol),
      calendarQuarterLabeled: groupBy(labeledWithLabels, row => quarterKey(row.signalTime)),
      exitReasonLabeled: groupBy(labeledWithLabels, row => row.label.exitReason),
      predictedEdgeDecileOof: groupBy(oofWithLabels, row => `D${row.predictedDecile}`),
      realizedGrossReturnDecileOof: groupBy(oofWithLabels, row => `D${row.realizedDecile}`),
      realizedGrossReturnDecileLabeled: groupBy(labeledWithLabels, row => `D${row.realizedDecile}`)
    },
    featureQuartiles: featureReport.map(({ labels, ...report }) => ({
      ...report,
      buckets: report.buckets
    })),
    robustOpportunity: robust.length
      ? { decision: 'QUALIFYING_DIRECTIONS_FOUND', directions: robust }
      : {
        decision: 'NO_ROBUST_TREND_BREAKOUT_SUBSET_FOUND',
        directions: [],
        recommendation: 'Abandon TREND_BREAKOUT as the primary HY-EXP-0025 family; do not create HY-EXP-0025 from this decomposition.'
      },
    safety: {
      signalOnly: true,
      paperOnly: true,
      finalOosRead: false,
      productionDeploy: false,
      noParameterRescue: true,
      noNewExperimentCreated: true,
      frozenDevelopmentResultRewritten: false
    }
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run() {
  if (fs.existsSync(DECOMPOSITION) || fs.existsSync(CLOSURE)) {
    throw new Error('refusing to overwrite HY-EXP-0024 closure/decomposition artifacts');
  }
  const frozenManifest = readJson(DEVELOPMENT_MANIFEST);
  const frozenResult = readJson(DEVELOPMENT_RESULT);
  const diagnostics = readJsonl(DEVELOPMENT_DIAGNOSTICS);
  const dataset = loadHyExp0024Dataset({ root: ROOT });
  const rows = buildHyExp0024DevelopmentRows({ dataset });
  verifyFrozenEvidence({ frozenManifest, frozenResult, diagnostics, dataset, rows });
  const sourceHashes = {
    developmentManifestSha256: sha256File(DEVELOPMENT_MANIFEST),
    frozenDevelopmentResultSha256: sha256File(DEVELOPMENT_RESULT),
    lockedDiagnosticsSha256: sha256File(DEVELOPMENT_DIAGNOSTICS),
    sourceManifestSha256: dataset.sourceManifestSha256
  };
  const decomposition = buildDecomposition({ rows, sourceHashes });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeJson(DECOMPOSITION, decomposition);
  const closure = {
    experimentId: HY_EXP_0024_EXPERIMENT_ID,
    status: 'FAILED',
    terminal: true,
    failureReason: 'DEVELOPMENT_EDGE_MODEL_FAILED_AND_ZERO_ADVISORIES',
    closurePolicy: 'HY-EXP-0024 must never be resumed; any new strategy/model requires HY-EXP-0025.',
    frozenDevelopmentEvidence: {
      rawCandidates: EXPECTED.rawCandidates,
      labeledCandidates: EXPECTED.labeledCandidates,
      oofPredictions: EXPECTED.oofPredictions,
      edgeAvailable: EXPECTED.edgeAvailable,
      advisories: EXPECTED.advisories,
      rejections: EXPECTED.rejections,
      calibration: EXPECTED.calibration
    },
    failureDecompositionArtifact: {
      path: 'artifacts/HY-EXP-0024/failure-decomposition.json',
      sha256: sha256File(DECOMPOSITION)
    },
    sourceEvidence: sourceHashes,
    developmentPnlComputed: true,
    finalOosRead: false,
    finalOosPnlComputed: false,
    experimentalReleaseReady: false,
    productionDeploy: false,
    signalOnly: true,
    paperOnly: true,
    riskMetricStatus: 'EMPTY_SAMPLE_NOT_EVALUABLE',
    noParameterRescue: true,
    noNewExperimentCreated: true
  };
  writeJson(CLOSURE, closure);
  console.log(JSON.stringify({
    experimentId: HY_EXP_0024_EXPERIMENT_ID,
    rawCandidates: rows.rawCandidateCount,
    labeledCandidates: rows.candidates.length,
    oofPredictions: rows.predictions.length,
    edgeAvailable: rows.predictions.filter(row => row.edge?.available).length,
    decomposition: path.relative(ROOT, DECOMPOSITION).replaceAll('\\', '/'),
    decompositionSha256: sha256File(DECOMPOSITION),
    closure: path.relative(ROOT, CLOSURE).replaceAll('\\', '/'),
    closureSha256: sha256File(CLOSURE),
    robustOpportunity: decomposition.robustOpportunity.decision
  }, null, 2));
}

try {
  if (process.argv[2] !== 'run') throw new Error('usage: node scripts/hy-exp-0024-failure-decomposition.mjs run');
  run();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
