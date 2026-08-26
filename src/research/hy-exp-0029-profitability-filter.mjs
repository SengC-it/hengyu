import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const HY_EXP_0029_ID = 'HY-EXP-0029';
export const SOURCE_EXPERIMENT_ID = 'HY-EXP-0028';
export const SOURCE_ARTIFACT_PATH = 'artifacts/HY-EXP-0028/holdout-result.json';
export const SOURCE_ARTIFACT_SHA256 = '92304ec0252be9ee2bba2e13a9ccc64c923f3b067d91e12513be089d56f3d2e5';
export const COST_BPS = Object.freeze({ base: 18, stress: 27, severe: 36 });
export const FEATURE_NAMES = Object.freeze([
  'channelDistanceOverFrozenQ75',
  'regimeBull',
  'sideBuy',
  'decisionHourSin',
  'decisionHourCos'
]);
export const MODEL_SPEC = Object.freeze({
  learningRate: 0.05,
  iterations: 800,
  l2Lambda: 1,
  minimumTrainingRows: 12,
  validationBlockRows: 5,
  purgeHours: 96,
  embargoHours: 24,
  confidenceZ: 1.96
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function finite(value) {
  return Number.isFinite(value);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sampleStd(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1));
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-Math.min(value, 40));
    return 1 / (1 + z);
  }
  const z = Math.exp(Math.max(value, -40));
  return z / (1 + z);
}

function compareRows(a, b) {
  return a.decisionTime - b.decisionTime || a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id);
}

function assertCausalTrade(trade) {
  if (!trade || typeof trade !== 'object') throw new Error('candidate row must be an object');
  if (!trade.id || !trade.symbol) throw new Error('candidate row is missing immutable identity');
  if (!finite(trade.decisionTime) || !finite(trade.exitTime)) throw new Error(`candidate ${trade.id} has invalid time`);
  if (!finite(trade.channelDistance) || !finite(trade.frozenQ75) || trade.frozenQ75 <= 0) {
    throw new Error(`candidate ${trade.id} has invalid channelDistance/frozenQ75`);
  }
  if (!['BUY', 'SELL'].includes(trade.side)) throw new Error(`candidate ${trade.id} has invalid side`);
  if (!['BULL', 'BEAR'].includes(trade.regime)) throw new Error(`candidate ${trade.id} has invalid regime`);
  if (!finite(trade.net18Bps) || !finite(trade.net27Bps)) throw new Error(`candidate ${trade.id} has invalid labels`);
}

export function loadFrozenHoldout({ root = MODULE_ROOT } = {}) {
  const file = path.resolve(root, SOURCE_ARTIFACT_PATH);
  if (!fs.existsSync(file)) throw new Error(`missing frozen source artifact: ${SOURCE_ARTIFACT_PATH}`);
  const bytes = fs.readFileSync(file);
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== SOURCE_ARTIFACT_SHA256) {
    throw new Error(`frozen source hash mismatch: ${actualSha256}`);
  }
  const artifact = JSON.parse(bytes.toString('utf8'));
  if (artifact.experimentId !== SOURCE_EXPERIMENT_ID) throw new Error('source experiment mismatch');
  if (artifact.status !== 'HOLDOUT_FAILED') throw new Error('source artifact is not the immutable failed holdout');
  if (artifact.finalOosRead !== false || artifact.finalOosPnlComputed !== false) {
    throw new Error('source artifact has an invalid Final OOS safety state');
  }
  if (!Array.isArray(artifact.trades) || !artifact.trades.length) throw new Error('source holdout has no trades');
  artifact.trades.forEach(assertCausalTrade);
  return { artifact, file, sha256: actualSha256 };
}

export function extractPreEntryFeatures(trade) {
  assertCausalTrade(trade);
  const utcHour = new Date(trade.decisionTime).getUTCHours()
    + new Date(trade.decisionTime).getUTCMinutes() / 60;
  const phase = (2 * Math.PI * utcHour) / 24;
  return {
    channelDistanceOverFrozenQ75: trade.channelDistance / trade.frozenQ75,
    regimeBull: trade.regime === 'BULL' ? 1 : 0,
    sideBuy: trade.side === 'BUY' ? 1 : 0,
    decisionHourSin: Math.sin(phase),
    decisionHourCos: Math.cos(phase)
  };
}

function vectorFromFeatures(features) {
  return FEATURE_NAMES.map(name => features[name]);
}

function standardizer(rows) {
  const raw = rows.map(row => vectorFromFeatures(extractPreEntryFeatures(row)));
  const means = FEATURE_NAMES.map((_, index) => mean(raw.map(vector => vector[index])));
  const stds = FEATURE_NAMES.map((_, index) => sampleStd(raw.map(vector => vector[index])) || 1);
  return {
    means,
    stds,
    transform(row) {
      const vector = vectorFromFeatures(extractPreEntryFeatures(row));
      return vector.map((value, index) => Math.max(-3, Math.min(3, (value - means[index]) / stds[index])));
    }
  };
}

function fitLogistic(rows) {
  if (rows.length < MODEL_SPEC.minimumTrainingRows) return { valid: false, reason: 'INSUFFICIENT_TRAINING_ROWS' };
  const positive = rows.filter(row => row.net18Bps > 0);
  const negative = rows.filter(row => row.net18Bps <= 0);
  if (!positive.length || !negative.length) return { valid: false, reason: 'ONE_CLASS_TRAINING' };
  const scaler = standardizer(rows);
  const x = rows.map(row => scaler.transform(row));
  const y = rows.map(row => row.net18Bps > 0 ? 1 : 0);
  const weights = Array(FEATURE_NAMES.length).fill(0);
  let intercept = 0;
  for (let iteration = 0; iteration < MODEL_SPEC.iterations; iteration++) {
    const gradientWeights = Array(FEATURE_NAMES.length).fill(0);
    let gradientIntercept = 0;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const prediction = sigmoid(intercept + x[rowIndex].reduce((sum, value, index) => sum + value * weights[index], 0));
      const error = prediction - y[rowIndex];
      gradientIntercept += error;
      for (let index = 0; index < weights.length; index++) gradientWeights[index] += error * x[rowIndex][index];
    }
    gradientIntercept /= rows.length;
    for (let index = 0; index < weights.length; index++) {
      gradientWeights[index] = gradientWeights[index] / rows.length + MODEL_SPEC.l2Lambda * weights[index] / rows.length;
      weights[index] -= MODEL_SPEC.learningRate * gradientWeights[index];
    }
    intercept -= MODEL_SPEC.learningRate * gradientIntercept;
  }
  const positiveMean = mean(positive.map(row => row.net18Bps));
  const negativeMean = mean(negative.map(row => row.net18Bps));
  const residuals = rows.map((row, index) => {
    const p = sigmoid(intercept + x[index].reduce((sum, value, featureIndex) => sum + value * weights[featureIndex], 0));
    const edge = p * positiveMean + (1 - p) * negativeMean;
    return row.net18Bps - edge;
  });
  return {
    valid: true,
    trainingRows: rows.length,
    scaler,
    intercept,
    weights,
    positiveMean,
    negativeMean,
    residualStd: sampleStd(residuals),
    predict(row) {
      const vector = scaler.transform(row);
      const pPositive = sigmoid(intercept + vector.reduce((sum, value, index) => sum + value * weights[index], 0));
      const expectedNet18Bps = pPositive * positiveMean + (1 - pPositive) * negativeMean;
      const standardErrorBps = sampleStd(residuals) / Math.sqrt(rows.length);
      const conservativeNet18Bps = expectedNet18Bps - MODEL_SPEC.confidenceZ * standardErrorBps;
      return {
        pPositive,
        expectedNet18Bps,
        standardErrorBps,
        conservativeNet18Bps,
        expectedNet27Bps: expectedNet18Bps - (COST_BPS.stress - COST_BPS.base),
        expectedNet36Bps: expectedNet18Bps - (COST_BPS.severe - COST_BPS.base),
        conservativeNet27Bps: conservativeNet18Bps - (COST_BPS.stress - COST_BPS.base),
        conservativeNet36Bps: conservativeNet18Bps - (COST_BPS.severe - COST_BPS.base)
      };
    }
  };
}

function gradePrediction(prediction, trainingRows) {
  if (trainingRows < 20) return 'REJECT';
  if (prediction.pPositive >= 0.65 && prediction.conservativeNet36Bps > 0) return 'A+';
  if (prediction.pPositive >= 0.55 && prediction.conservativeNet27Bps > 0) return 'A';
  if (prediction.conservativeNet18Bps > 0) return 'B';
  return 'REJECT';
}

function buildFolds(rows) {
  const folds = [];
  for (let start = MODEL_SPEC.minimumTrainingRows; start < rows.length; start += MODEL_SPEC.validationBlockRows) {
    const validation = rows.slice(start, start + MODEL_SPEC.validationBlockRows);
    if (!validation.length) break;
    const validationStart = validation[0].decisionTime;
    const purgeCutoff = validationStart - MODEL_SPEC.purgeHours * 60 * 60 * 1000;
    const embargoCutoff = validationStart - MODEL_SPEC.embargoHours * 60 * 60 * 1000;
    const training = rows
      .slice(0, start)
      .filter(row => row.exitTime < purgeCutoff && row.decisionTime < embargoCutoff);
    folds.push({ index: folds.length + 1, training, validation, validationStart, purgeCutoff, embargoCutoff });
  }
  return folds;
}

function spearman(valuesA, valuesB) {
  if (valuesA.length < 2 || valuesA.length !== valuesB.length) return null;
  const rank = values => {
    const pairs = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
    const result = Array(values.length);
    pairs.forEach((pair, index) => { result[pair.index] = index + 1; });
    return result;
  };
  const a = rank(valuesA);
  const b = rank(valuesB);
  const average = (a.reduce((sum, value) => sum + value, 0) / a.length);
  const numerator = a.reduce((sum, value, index) => sum + (value - average) * (b[index] - average), 0);
  const denominator = Math.sqrt(
    a.reduce((sum, value) => sum + ((value - average) ** 2), 0)
    * b.reduce((sum, value) => sum + ((value - average) ** 2), 0)
  );
  return denominator ? numerator / denominator : null;
}

function profitFactor(rows, key = 'net18Pnl') {
  const gains = rows.filter(row => row[key] > 0).reduce((sum, row) => sum + row[key], 0);
  const losses = Math.abs(rows.filter(row => row[key] < 0).reduce((sum, row) => sum + row[key], 0));
  return losses ? gains / losses : null;
}

function maxLossStreak(rows, key = 'net18Pnl') {
  let current = 0;
  let maximum = 0;
  for (const row of [...rows].sort(compareRows)) {
    if (row[key] < 0) {
      current += 1;
      maximum = Math.max(maximum, current);
    } else {
      current = 0;
    }
  }
  return maximum;
}

function markToMarketDrawdown(rows, capital = 100000) {
  const losses = rows
    .filter(row => finite(row.markToMarketDrawdownBps) && finite(row.notional))
    .map(row => Math.max(0, Math.abs(row.markToMarketDrawdownBps) * row.notional / 10000));
  return losses.length ? Math.max(...losses) / capital : null;
}

export function validatePortfolioRiskEvidence(metrics, { requirePortfolioCvar = true } = {}) {
  const reasons = [];
  if (metrics?.portfolioMtmStatus !== 'RECONSTRUCTED' || !finite(metrics?.portfolioMtmDrawdownFraction)) {
    reasons.push('PORTFOLIO_MTM_NOT_RECONSTRUCTED');
  }
  if (requirePortfolioCvar && (metrics?.portfolioCvarStatus !== 'RECONSTRUCTED' || !finite(metrics?.portfolioCvar95))) {
    reasons.push('PORTFOLIO_CVAR_NOT_RECONSTRUCTED');
  }
  return {
    eligible: reasons.length === 0,
    status: reasons.length === 0 ? 'RECONSTRUCTED' : 'NOT_RECONSTRUCTED',
    reasons
  };
}

function rowMetrics(rows) {
  if (!rows.length) {
    return {
      count: 0,
      riskMetricStatus: 'EMPTY_SAMPLE_NOT_EVALUABLE',
      net18ExpectancyBps: null,
      net27ExpectancyBps: null,
      net36ExpectancyBps: null,
      net18ProfitFactor: null,
      net27ProfitFactor: null,
      net36ProfitFactor: null,
      maxSingleTradeAdverseExcursionFraction: null,
      singleTradeAdverseExcursionMethod: 'NOT_EVALUABLE_EMPTY_SAMPLE',
      portfolioMtmDrawdownFraction: null,
      portfolioMtmStatus: 'NOT_RECONSTRUCTED',
      tradeLossCvar95Bps: null,
      tradeLossCvar95Fraction: null,
      portfolioCvar95: null,
      portfolioCvarStatus: 'NOT_RECONSTRUCTED',
      maxLossStreak: null,
      netPnlWithoutBestTrade: null,
      netPnlWithoutBestMonth: null,
      positiveMonths: null,
      distinctSymbols: 0,
      largestSymbolShare: null
    };
  }
  const enriched = rows.map(row => ({
    ...row,
    net18Pnl: finite(row.netPnl) ? row.netPnl : row.net18Bps * row.notional / 10000,
    net27Pnl: finite(row.stressNetPnl) ? row.stressNetPnl : row.net27Bps * row.notional / 10000,
    net36Pnl: (row.net18Bps - (COST_BPS.severe - COST_BPS.base)) * row.notional / 10000
  }));
  const monthPnl = new Map();
  for (const row of enriched) {
    const month = new Date(row.exitTime).toISOString().slice(0, 7);
    monthPnl.set(month, (monthPnl.get(month) ?? 0) + row.net18Pnl);
  }
  const bestTrade = Math.max(...enriched.map(row => row.net18Pnl));
  const bestMonth = Math.max(...monthPnl.values());
  const losses = enriched.filter(row => row.net18Pnl < 0).map(row => Math.abs(row.net18Bps)).sort((a, b) => b - a);
  const cvarTail = losses.slice(0, Math.max(1, Math.ceil(losses.length * 0.05)));
  const symbolCounts = new Map();
  for (const row of enriched) symbolCounts.set(row.symbol, (symbolCounts.get(row.symbol) ?? 0) + 1);
  return {
    count: enriched.length,
    riskMetricStatus: 'EVALUABLE',
    grossExpectancyBps: mean(enriched.map(row => row.grossPriceReturnBps)),
    net18ExpectancyBps: mean(enriched.map(row => row.net18Bps)),
    net27ExpectancyBps: mean(enriched.map(row => row.net27Bps)),
    net36ExpectancyBps: mean(enriched.map(row => row.net18Bps - (COST_BPS.severe - COST_BPS.base))),
    net18ProfitFactor: profitFactor(enriched),
    net27ProfitFactor: profitFactor(enriched, 'net27Pnl'),
    net36ProfitFactor: profitFactor(enriched, 'net36Pnl'),
    netPnl18: enriched.reduce((sum, row) => sum + row.net18Pnl, 0),
    netPnl27: enriched.reduce((sum, row) => sum + row.net27Pnl, 0),
    netPnl36: enriched.reduce((sum, row) => sum + row.net36Pnl, 0),
    maxSingleTradeAdverseExcursionFraction: markToMarketDrawdown(enriched),
    singleTradeAdverseExcursionMethod: 'maximum_single_trade_markToMarketDrawdownBps_scaled_by_notional; not portfolio-equity MTM',
    portfolioMtmDrawdownFraction: null,
    portfolioMtmStatus: 'NOT_RECONSTRUCTED',
    tradeLossCvar95Bps: mean(cvarTail),
    tradeLossCvar95Fraction: mean(cvarTail) == null ? null : mean(cvarTail) / 10000,
    portfolioCvar95: null,
    portfolioCvarStatus: 'NOT_RECONSTRUCTED',
    maxLossStreak: maxLossStreak(enriched),
    netPnlWithoutBestTrade: enriched.reduce((sum, row) => sum + row.net18Pnl, 0) - bestTrade,
    netPnlWithoutBestMonth: enriched.reduce((sum, row) => sum + row.net18Pnl, 0) - bestMonth,
    activeMonths: [...monthPnl.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, netPnl]) => ({ month, netPnl })),
    positiveMonths: [...monthPnl.values()].filter(value => value > 0).length,
    distinctSymbols: symbolCounts.size,
    largestSymbolShare: Math.max(...symbolCounts.values()) / enriched.length,
    symbolCounts: Object.fromEntries([...symbolCounts.entries()].sort())
  };
}

function groupSummary(rows) {
  if (!rows.length) return { count: 0 };
  const net18Pnl = rows.map(row => finite(row.netPnl) ? row.netPnl : row.net18Bps * row.notional / 10000);
  const net27Pnl = rows.map(row => finite(row.stressNetPnl) ? row.stressNetPnl : row.net27Bps * row.notional / 10000);
  const net36Pnl = rows.map((row, index) => net18Pnl[index] - (COST_BPS.severe - COST_BPS.base) * row.notional / 10000);
  return {
    count: rows.length,
    grossExpectancyBps: mean(rows.map(row => row.grossPriceReturnBps)),
    net18ExpectancyBps: mean(rows.map(row => row.net18Bps)),
    net27ExpectancyBps: mean(rows.map(row => row.net27Bps)),
    net36ExpectancyBps: mean(rows.map(row => row.net18Bps - (COST_BPS.severe - COST_BPS.base))),
    net18Pnl: net18Pnl.reduce((sum, value) => sum + value, 0),
    net27Pnl: net27Pnl.reduce((sum, value) => sum + value, 0),
    net36Pnl: net36Pnl.reduce((sum, value) => sum + value, 0),
    net18ProfitFactor: profitFactor(rows.map((row, index) => ({ net18Pnl: net18Pnl[index] }))),
    positiveRate: rows.filter(row => row.net18Bps > 0).length / rows.length
  };
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([key, group]) => [key, groupSummary(group)]));
}

function mechanicalQuartiles(rows) {
  const values = rows.map(row => row.channelDistance / row.frozenQ75).sort((a, b) => a - b);
  const bounds = [percentile(values, 0.25), percentile(values, 0.5), percentile(values, 0.75)];
  const bucket = value => value <= bounds[0] ? 'Q1' : value <= bounds[1] ? 'Q2' : value <= bounds[2] ? 'Q3' : 'Q4';
  return {
    feature: 'channelDistanceOverFrozenQ75',
    method: 'descriptive full-sample quartiles; not used to select a production threshold',
    bounds,
    groups: Object.fromEntries(['Q1', 'Q2', 'Q3', 'Q4'].map(name => [name, groupSummary(rows.filter(row => bucket(row.channelDistance / row.frozenQ75) === name))]))
  };
}

function rootCauseAnalysis(rows) {
  const winners = rows.filter(row => row.net18Bps > 0);
  const losers = rows.filter(row => row.net18Bps <= 0);
  const holdingHours = row => (row.exitTime - row.entryTime) / 3600000;
  const maeMfe = group => ({
    count: group.length,
    meanMaeBps: mean(group.map(row => row.maeBps)),
    meanMfeBps: mean(group.map(row => row.mfeBps)),
    meanHoldingHours: mean(group.map(holdingHours))
  });
  const funding = rows.map(row => row.realizedFundingBps ?? 0);
  return {
    winnerLoser: { winners: maeMfe(winners), losers: maeMfe(losers) },
    exitReason: groupBy(rows, row => row.exitReason),
    side: groupBy(rows, row => row.side),
    regime: groupBy(rows, row => row.regime),
    symbol: groupBy(rows, row => row.symbol),
    calendarMonth: groupBy(rows, row => new Date(row.exitTime).toISOString().slice(0, 7)),
    decisionHourUtc: groupBy(rows, row => String(new Date(row.decisionTime).getUTCHours()).padStart(2, '0')),
    channelDistanceQuartiles: mechanicalQuartiles(rows),
    fundingImpact: {
      totalFundingBps: funding.reduce((sum, value) => sum + value, 0),
      meanFundingBps: mean(funding),
      negativeFundingRows: funding.filter(value => value < 0).length,
      note: 'realized funding is evaluation data, never a model feature'
    },
    interpretation: {
      baseToStress: 'The 9 bps cost increase from 18 to 27 exceeds the 5.2378 bps base net expectancy, mechanically moving the point estimate to -3.7622 bps before any model filtering.',
      lossStreak: 'The chronological holdout contains a 12-loss terminal streak; the streak is descriptive evidence only and is not used to filter rows.',
      stopLosses: 'Every ATR_STOP row in this holdout is net-negative; this is an exit decomposition, not a causal pre-entry feature.',
      featureSignal: 'Current immutable rows expose channel distance, but all rows share BUY/BULL. Regime and side cannot discriminate in this sample; the broader feature catalog is unavailable and is not backfilled.'
    }
  };
}

function createPrng(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function bootstrap(rows) {
  if (!rows.length) return { iterations: 0, status: 'EMPTY_SAMPLE_NOT_EVALUABLE' };
  const random = createPrng(290029);
  const blocks = [];
  const sorted = [...rows].sort(compareRows);
  for (let index = 0; index < sorted.length; index += 3) blocks.push(sorted.slice(index, index + 3));
  const samples = { net18ExpectancyBps: [], net27ExpectancyBps: [], net36ExpectancyBps: [], profitFactor18: [], maxSingleTradeAdverseExcursionFraction: [], maxLossStreak: [] };
  for (let iteration = 0; iteration < 5000; iteration++) {
    const sample = [];
    while (sample.length < sorted.length) sample.push(...blocks[Math.floor(random() * blocks.length)]);
    const clipped = sample.slice(0, sorted.length);
    const metrics = rowMetrics(clipped);
    samples.net18ExpectancyBps.push(metrics.net18ExpectancyBps);
    samples.net27ExpectancyBps.push(metrics.net27ExpectancyBps);
    samples.net36ExpectancyBps.push(metrics.net36ExpectancyBps);
    samples.profitFactor18.push(metrics.net18ProfitFactor ?? 0);
    samples.maxSingleTradeAdverseExcursionFraction.push(metrics.maxSingleTradeAdverseExcursionFraction);
    samples.maxLossStreak.push(metrics.maxLossStreak);
  }
  return {
    method: 'chronological block bootstrap',
    blockSizeRows: 3,
    iterations: 5000,
    seed: 290029,
    confidence: 0.95,
    metrics: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, {
      lower: percentile(values, 0.025),
      median: percentile(values, 0.5),
      upper: percentile(values, 0.975)
    }]))
  };
}

function calibration(oof) {
  if (!oof.length) return { status: 'EMPTY_SAMPLE_NOT_EVALUABLE' };
  const probabilities = oof.map(row => row.pPositive);
  const outcomes = oof.map(row => row.net18Bps > 0 ? 1 : 0);
  const brierScore = mean(probabilities.map((probability, index) => (probability - outcomes[index]) ** 2));
  const decileRows = [...oof].sort((a, b) => a.pPositive - b.pPositive);
  const deciles = [];
  for (let index = 0; index < 10; index++) {
    const start = Math.floor(index * decileRows.length / 10);
    const end = Math.floor((index + 1) * decileRows.length / 10);
    const rows = decileRows.slice(start, end);
    if (rows.length) deciles.push({ decile: index + 1, count: rows.length, predictedPositiveRate: mean(rows.map(row => row.pPositive)), realizedPositiveRate: mean(rows.map(row => row.net18Bps > 0 ? 1 : 0)) });
  }
  return {
    status: 'OOF_ONLY',
    brierScore,
    rankCorrelation: spearman(probabilities, oof.map(row => row.net18Bps)),
    deciles
  };
}

export function analyzeFrozenHoldout({ root = MODULE_ROOT } = {}) {
  const source = loadFrozenHoldout({ root });
  const rows = [...source.artifact.trades].sort(compareRows);
  const folds = buildFolds(rows);
  const oof = [];
  const foldReports = [];
  for (const fold of folds) {
    const model = fitLogistic(fold.training);
    const report = {
      fold: fold.index,
      trainingRows: fold.training.length,
      validationRows: fold.validation.length,
      validationStart: new Date(fold.validationStart).toISOString(),
      purgeCutoff: new Date(fold.purgeCutoff).toISOString(),
      embargoCutoff: new Date(fold.embargoCutoff).toISOString(),
      fit: model.valid ? 'OK' : model.reason
    };
    if (model.valid) {
      report.predictions = fold.validation.map(row => {
        const prediction = model.predict(row);
        const confidenceGrade = gradePrediction(prediction, model.trainingRows);
        const output = {
          id: row.id,
          symbol: row.symbol,
          side: row.side,
          regime: row.regime,
          decisionTime: row.decisionTime,
          trainingRows: model.trainingRows,
          ...prediction,
          confidenceGrade,
          decision: confidenceGrade === 'A+' || confidenceGrade === 'A' ? 'SEND_CANDIDATE' : 'REJECT_CANDIDATE',
          net18Bps: row.net18Bps,
          net27Bps: row.net27Bps,
          notional: row.notional,
          netPnl: row.netPnl,
          stressNetPnl: row.stressNetPnl,
          exitTime: row.exitTime
        };
        oof.push(output);
        return output;
      });
    }
    foldReports.push(report);
  }
  const byId = new Map(oof.map(row => [row.id, row]));
  const acceptedRows = rows.filter(row => byId.get(row.id)?.decision === 'SEND_CANDIDATE');
  const rejectedRows = rows.filter(row => byId.get(row.id)?.decision !== 'SEND_CANDIDATE');
  const noOofRows = rows.filter(row => !byId.has(row.id));
  const acceptedBySymbol = Object.fromEntries([...new Set(acceptedRows.map(row => row.symbol))].sort().map(symbol => [symbol, acceptedRows.filter(row => row.symbol === symbol).length]));
  const acceptedByRegime = Object.fromEntries([...new Set(acceptedRows.map(row => row.regime))].sort().map(regime => [regime, acceptedRows.filter(row => row.regime === regime).length]));
  const baseline = rowMetrics(rows);
  const sourceMetrics = source.artifact.metrics;
  const filtered = rowMetrics(acceptedRows);
  const portfolioRisk = validatePortfolioRiskEvidence(filtered);
  const result = {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0029_META_FILTER_DEVELOPMENT_DIAGNOSTIC',
    experimentId: HY_EXP_0029_ID,
    candidateGenerator: SOURCE_EXPERIMENT_ID,
    sourceArtifact: SOURCE_ARTIFACT_PATH,
    sourceArtifactSha256: source.sha256,
    sourceStatus: source.artifact.status,
    evidenceStatus: 'DEVELOPMENT_DIAGNOSTIC_ONLY',
    promotionEligible: false,
    freshHoldoutCreated: false,
    finalOosRead: false,
    pnlComputed: true,
    featurePolicy: {
      causalAtDecisionTimeOnly: true,
      modelFeatures: FEATURE_NAMES,
      unavailableCurrentHoldoutFeatures: ['atrPercent', 'trendStrength1h', 'trendStrength4h', 'btcMarketAlignment', 'relativeStrengthVsBtc', 'volumeExpansion', 'fundingRateAtDecision', 'recentFundingChange', 'distanceFromRecentHigh', 'breakoutPersistence', 'shortTermMomentum', 'marketBreadth', 'crossSymbolMomentumBreadth', 'liquidityProxy', 'recentVolatilityShock'],
      forbiddenFutureFields: ['exitTime', 'exitPrice', 'exitReason', 'grossPriceReturnBps', 'net18Bps', 'net27Bps', 'netPnl', 'stressNetPnl', 'fundingPnl', 'maeBps', 'mfeBps', 'markToMarketDrawdownBps', 'marks']
    },
    baselineMetrics: {
      candidateCount: sourceMetrics.candidateCount,
      advisoryCount: sourceMetrics.advisoryCount,
      signalsPer30Days: sourceMetrics.signalsPer30Days,
      grossExpectancyBps: sourceMetrics.grossExpectancyBps,
      net18ExpectancyBps: sourceMetrics.net18ExpectancyBps,
      net18ProfitFactor: sourceMetrics.net18ProfitFactor,
      net27ExpectancyBps: sourceMetrics.net27ExpectancyBps,
      net27ProfitFactor: sourceMetrics.net27ProfitFactor,
      net36ExpectancyBps: sourceMetrics.net18ExpectancyBps - (COST_BPS.severe - COST_BPS.base),
      net36ProfitFactor: baseline.net36ProfitFactor,
      netPnl18: sourceMetrics.netPnl,
      netPnl27: sourceMetrics.stressNetPnl,
      netPnlWithoutBestTrade: baseline.netPnlWithoutBestTrade,
      netPnlWithoutBestMonth: baseline.netPnlWithoutBestMonth,
      activeMonths: baseline.activeMonths,
      bestTrade: sourceMetrics.bestTrade,
      maxMtmDrawdownFraction: sourceMetrics.maxMtmDrawdown,
      maxMtmDrawdownSource: 'HY-EXP-0028 frozen portfolio risk evidence',
      maxMtmDrawdownStatus: 'SOURCE_REPORTED',
      maxLossStreak: sourceMetrics.maxLossStreak,
      distinctSymbols: sourceMetrics.distinctSymbols,
      largestSymbolShare: sourceMetrics.largestSingleSymbolShare,
      fundingPnl: sourceMetrics.fundingPnl,
      sourceReported: true
    },
    baselineDerivedMetrics: baseline,
    rootCauseAnalysis: rootCauseAnalysis(rows),
    oof: {
      folds: foldReports,
      predictionCount: oof.length,
      acceptedCount: acceptedRows.length,
      rejectedCount: rejectedRows.length,
      noOofCount: noOofRows.length,
      calibration: calibration(oof),
      predictions: oof.map(({ netPnl, stressNetPnl, notional, exitTime, ...safe }) => safe)
    },
    filteredMetrics: filtered,
    acceptedBreakdown: { bySymbol: acceptedBySymbol, byRegime: acceptedByRegime },
    candidateFrequency: {
      sourceCandidates: rows.length,
      sourcePer30Days: rows.length / 53 * 30,
      acceptedPer30Days: acceptedRows.length / 53 * 30,
      targetRangePer30Days: [5, 15]
    },
    bootstrap: {
      baseline: bootstrap(rows),
      filtered: bootstrap(acceptedRows)
    },
    researchGate: {
      status: 'NOT_READY',
      reasons: [
        'validated signal and calendar-day minimums are not met',
        'current source is a reused HY-EXP-0028 holdout and is not independent evidence',
        'fresh holdout has not been created',
        'paper forward gate has not been run',
        'current source feature coverage is incomplete for the broader candidate feature catalog',
        ...portfolioRisk.reasons
      ],
      edgeUncertainty: 'EDGE_UNCERTAIN',
      portfolioRiskRequired: true,
      portfolioRiskStatus: portfolioRisk.status
    },
    safety: {
      signalOnly: true,
      paperOnly: true,
      liveOrdersEnabled: false,
      accountApi: false,
      orderApi: false,
      automaticTrading: false,
      gmailSendEnabled: false,
      schedulerActivated: false,
      realEmailSent: false,
      finalOosRead: false
    }
  };
  return result;
}

export function writeDiagnosticResult({ root = MODULE_ROOT, outputPath = 'artifacts/HY-EXP-0029/meta-filter-result.json' } = {}) {
  const result = analyzeFrozenHoldout({ root });
  const file = path.resolve(root, outputPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return { result, file, sha256: sha256(fs.readFileSync(file)) };
}
