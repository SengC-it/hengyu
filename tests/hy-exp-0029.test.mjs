import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import {
  HY_EXP_0029_BASE_COST_BPS,
  HY_EXP_0029_MAX_HOLD_BARS,
  HY_EXP_0029_PREREGISTRATION_SHA256,
  HY_EXP_0029_STOP_ATR_MULTIPLE,
  evaluatePullbackReclaim,
  labelPullbackReclaim
} from '../src/research/hy-exp-0029.mjs';

const PREREG_PATH = 'registry/experiments/HY-EXP-0029/preregistration.json';
const RESULT_PATH = 'artifacts/HY-EXP-0029/development-result.json';
const CLOSURE_PATH = 'artifacts/HY-EXP-0029/closure.json';
const REGISTRY_PATH = 'registry/ledger.jsonl';
const REGISTRY_HEAD = 'e68b2d6f93c571928319c93fc0b278768b826fd1ee9c4cf9f8c123538a981f62';

const HOUR = 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeSignalBars({ currentIndex = 60, currentFinal = true } = {}) {
  const bars = Array.from({ length: 82 }, (_, index) => {
    const close = 100 + index;
    return {
      openTime: index * HOUR,
      closeBoundary: (index + 1) * HOUR,
      open: close,
      high: close + 0.5,
      low: close - 0.5,
      close,
      final: true
    };
  });
  bars[currentIndex].final = currentFinal;
  return bars;
}

function makeExecutionFixture({ breachStop = false, smaFailure = false } = {}) {
  const bars1h = Array.from({ length: 82 }, (_, index) => {
    const close = smaFailure && index === 58 ? 90 : 100 + index * 0.2;
    return {
      openTime: index * HOUR,
      closeBoundary: (index + 1) * HOUR,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      final: true
    };
  });
  const decisionTime = bars1h[55].closeBoundary;
  const entryTime = decisionTime + FIVE_MINUTES;
  const finalOpenTime = bars1h[67].closeBoundary - FIVE_MINUTES;
  const bars5m = [];
  for (let openTime = entryTime; openTime <= finalOpenTime; openTime += FIVE_MINUTES) {
    const stopBar = breachStop && openTime === entryTime;
    bars5m.push({
      openTime,
      open: 100,
      high: 101,
      low: stopBar ? 98 : 99,
      close: 100,
      closeBoundary: openTime + FIVE_MINUTES,
      final: true
    });
  }
  const candidate = {
    id: 'BTCUSDT:test',
    symbol: 'BTCUSDT',
    side: 'BUY',
    decisionTime,
    atr20: 1,
    fundingRows: []
  };
  return { bars1h, bars5m, fiveByOpenTime: new Map(bars5m.map(row => [row.openTime, row])), candidate, entryTime };
}

test('HY-EXP-0029 preregistration is frozen, independent, and paper-only', () => {
  const prereg = readJson(PREREG_PATH);
  assert.equal(sha256(PREREG_PATH), HY_EXP_0029_PREREGISTRATION_SHA256);
  assert.equal(prereg.experimentId, 'HY-EXP-0029');
  assert.equal(prereg.baseCommit, 'a61cb20318af1e0b188c0276a1a3d65e52bc4467');
  assert.equal(prereg.candidateFamily.id, 'TREND_PULLBACK_RECLAIM');
  assert.equal(prereg.candidateFamily.parameterOptimizationAllowed, false);
  assert.equal(prereg.candidateFamily.featureSearchAllowed, false);
  assert.equal(prereg.candidateFamily.ridgeAllowed, false);
  assert.equal(prereg.advisory.edgeVeto, false);
  assert.equal(prereg.execution.exit.maximumHoldCompleted1hBars, 12);
  assert.equal(prereg.execution.exit.initialStop, 'entryPrice - 1.5 * ATR20 frozen from the completed trigger bar');
  assert.equal(prereg.execution.costs.baseExecutionCostBps, 18);
  assert.equal(prereg.execution.costs.stressExecutionCostBps, 27);
  assert.equal(prereg.signalOnly, true);
  assert.equal(prereg.authorization, 'PAPER_ONLY');
  assert.equal(prereg.liveOrdersEnabled, false);
  assert.equal(prereg.accountApi, false);
  assert.equal(prereg.orderApi, false);
  assert.equal(prereg.automaticTrading, false);
  assert.equal(prereg.oosRead, false);
});

test('pullback reclaim requires the prior three completed bars and excludes the trigger bar', () => {
  const bars = makeSignalBars();
  bars[58].low = 140;
  const accepted = evaluatePullbackReclaim({ bars, index: 60 });
  assert.equal(accepted.symbolTrend, true);
  assert.equal(accepted.pullbackTouch, true);
  assert.equal(accepted.pullbackIntact, true);
  assert.equal(accepted.reclaim, true);
  assert.equal(accepted.qualifies, true);
  assert.equal(accepted.currentBarExcludedFromPullback, true);

  const triggerOnly = makeSignalBars();
  triggerOnly[60].low = 0;
  assert.equal(evaluatePullbackReclaim({ bars: triggerOnly, index: 60 }).pullbackTouch, false);
  assert.equal(evaluatePullbackReclaim({ bars: triggerOnly, index: 60 }).qualifies, false);

  const broken = makeSignalBars();
  broken[58].close = 1;
  broken[58].low = 0;
  assert.equal(evaluatePullbackReclaim({ bars: broken, index: 60 }).pullbackIntact, false);
  assert.equal(evaluatePullbackReclaim({ bars: broken, index: 60 }).qualifies, false);
});

test('non-completed trigger bars cannot generate the rule', () => {
  const bars = makeSignalBars({ currentFinal: false });
  bars[58].low = 140;
  const signal = evaluatePullbackReclaim({ bars, index: 60 });
  assert.equal(signal.qualifies, false);
});

test('exact +5m entry is required and a later bar cannot rescue a missing entry', () => {
  const fixture = makeExecutionFixture();
  const missing = new Map(fixture.fiveByOpenTime);
  missing.delete(fixture.entryTime);
  missing.set(fixture.entryTime + FIVE_MINUTES, fixture.bars5m[1]);
  const label = labelPullbackReclaim({
    candidate: fixture.candidate,
    bars1h: fixture.bars1h,
    bars5m: fixture.bars5m,
    fiveByOpenTime: missing
  });
  assert.equal(label.usable, false);
  assert.equal(label.rejection, 'MISSING_EXACT_5M_EXECUTION_BAR');
});

test('stop has priority, otherwise SMA20 failure is causal, otherwise maxHold is 12 bars', () => {
  const stopped = makeExecutionFixture({ breachStop: true });
  const stopLabel = labelPullbackReclaim({
    candidate: stopped.candidate,
    bars1h: stopped.bars1h,
    bars5m: stopped.bars5m,
    fiveByOpenTime: stopped.fiveByOpenTime
  });
  assert.equal(stopLabel.usable, true);
  assert.equal(stopLabel.exitReason, 'ATR_STOP');
  assert.equal(stopLabel.stopPrice, 100 - HY_EXP_0029_STOP_ATR_MULTIPLE);

  const trendFailure = makeExecutionFixture({ smaFailure: true });
  const smaLabel = labelPullbackReclaim({
    candidate: trendFailure.candidate,
    bars1h: trendFailure.bars1h,
    bars5m: trendFailure.bars5m,
    fiveByOpenTime: trendFailure.fiveByOpenTime
  });
  assert.equal(smaLabel.usable, true);
  assert.equal(smaLabel.exitReason, 'SMA20_TREND_FAILURE');

  const terminal = makeExecutionFixture();
  const terminalLabel = labelPullbackReclaim({
    candidate: terminal.candidate,
    bars1h: terminal.bars1h,
    bars5m: terminal.bars5m,
    fiveByOpenTime: terminal.fiveByOpenTime
  });
  assert.equal(terminalLabel.usable, true);
  assert.equal(terminalLabel.exitReason, 'TERMINAL_TWELFTH_BAR');
  assert.equal(HY_EXP_0029_MAX_HOLD_BARS, 12);
});

test('Development result is the single fixed rule OOF and failed gates are terminal', () => {
  const result = readJson(RESULT_PATH);
  const closure = readJson(CLOSURE_PATH);
  const metrics = result.development.metrics;
  assert.equal(result.status, 'DEVELOPMENT_FAILED_TERMINAL');
  assert.equal(result.experimentalReleaseReady, false);
  assert.equal(result.development.sourceExperimentId, 'HY-EXP-0001');
  assert.equal(result.development.noHoldoutRead, true);
  assert.equal(result.development.finalOosRead, false);
  assert.equal(result.development.edgeAvailableCount, 0);
  assert.equal(result.noMl, true);
  assert.equal(result.noRidge, true);
  assert.equal(result.noFeatureSearch, true);
  assert.equal(result.development.rawCandidateCount, 2626);
  assert.equal(result.development.labeledCandidateCount, 2626);
  assert.equal(result.development.oofPredictionCount, 1137);
  assert.equal(result.development.advisoryCount, 1137);
  assert.equal(metrics.usableAdvisoriesPer30Days, 62.472527472527474);
  assert.equal(metrics.net18ExpectancyBps, -16.069622173011844);
  assert.equal(metrics.net18ProfitFactor, 0.8330555105639036);
  assert.equal(metrics.net27ExpectancyBps, -25.069622173011815);
  assert.equal(metrics.net27ProfitFactor, 0.7200644314023573);
  assert.equal(metrics.activeMonthCount, 11);
  assert.equal(metrics.positiveActiveMonthShare, 0.18181818181818182);
  assert.deepEqual(metrics.symbols, ['BNBUSDT','BTCUSDT','DOGEUSDT','ETHUSDT','LINKUSDT','LTCUSDT','SOLUSDT','XRPUSDT']);
  assert.equal(metrics.largestSingleSymbolShare, 0.15303430079155672);
  assert.equal(metrics.maxMtmDrawdown, 0.3434633966390158);
  assert.equal(metrics.cvar95LossFraction, 0.04450682546237883);
  assert.equal(metrics.maxLossStreak, 44);
  assert.equal(metrics.bestMonthPositivePnlShare, 0.9908354497299171);
  assert.equal(metrics.netPnlWithoutBestMonth, -51858.32141972777);
  assert.deepEqual(Object.entries(metrics.developmentGates.checks).filter(([, value]) => !value).map(([name]) => name), [
    'net18ExpectancyGreaterThan8',
    'net18ProfitFactorGreaterThan1_15',
    'net27ExpectancyGreaterThan0',
    'net27ProfitFactorGreaterThan1_02',
    'positiveActiveMonthShareAtLeast0_45',
    'maxMtmDrawdownAtMost15Percent',
    'maxLossStreakAtMost8',
    'bestMonthPositivePnlShareAtMost0_50',
    'netPnlWithoutBestMonthGreaterThan0'
  ]);
  assert.equal(metrics.developmentGates.pass, false);
  assert.equal(closure.status, 'DEVELOPMENT_FAILED_TERMINAL');
  assert.equal(closure.terminal, true);
  assert.equal(closure.finalOosRead, false);
  assert.equal(closure.productionDeploy, false);
  assert.equal(closure.paperOnly, true);
  assert.equal(closure.signalOnly, true);
  assert.equal(sha256(CLOSURE_PATH), '3f88c2e824c1ea317f985cacaebc8bb0c4dda1084c6457b453069a2f21951904');
});

test('Development cost and funding semantics stay separate and paper-only', () => {
  const result = readJson(RESULT_PATH);
  const advisory = result.advisories[0];
  assert.equal(advisory.costs.baseTotalBps, HY_EXP_0029_BASE_COST_BPS);
  assert.equal(advisory.costs.stressTotalBps, 27);
  assert.ok(Math.abs((advisory.net18Bps - advisory.net27Bps) - 9) < 1e-9);
  assert.ok(advisory.realizedFunding);
  assert.equal(advisory.paperOnly, true);
  assert.equal(advisory.signalOnly, true);
  assert.equal(advisory.liveOrdersEnabled, false);
  assert.equal(advisory.accountApi, false);
  assert.equal(advisory.orderApi, false);
  assert.equal(advisory.side, 'BUY');
  assert.equal(advisory.family, 'TREND_PULLBACK_RECLAIM');
  assert.equal(advisory.exitReason === 'ATR_STOP' || advisory.exitReason === 'SMA20_TREND_FAILURE' || advisory.exitReason === 'TERMINAL_TWELFTH_BAR', true);
});

test('registry keeps 0024-0028 terminal and closes 0029 exactly once', () => {
  const entries = fs.readFileSync(REGISTRY_PATH, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const byExperiment = id => entries.filter(entry => entry.experiment_id === id).map(entry => entry.event_type);
  for (const id of ['HY-EXP-0024','HY-EXP-0025','HY-EXP-0026','HY-EXP-0027','HY-EXP-0028']) {
    assert.ok(byExperiment(id).at(-1) === 'failed');
  }
  assert.deepEqual(byExperiment('HY-EXP-0029'), ['preregistered', 'failed']);
  assert.equal(entries.at(-1).hash, REGISTRY_HEAD);
});
