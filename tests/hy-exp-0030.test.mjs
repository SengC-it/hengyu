import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import {
  HY_EXP_0030_MAX_HOLD_BARS,
  HY_EXP_0030_PREREGISTRATION_SHA256,
  HY_EXP_0030_STOP_ATR_MULTIPLE,
  evaluateCompressionExpansion,
  labelCompressionExpansion
} from '../src/research/hy-exp-0030.mjs';

const PREREG_PATH = 'registry/experiments/HY-EXP-0030/preregistration.json';
const RESULT_PATH = 'artifacts/HY-EXP-0030/development-result.json';
const CLOSURE_PATH = 'artifacts/HY-EXP-0030/closure.json';
const REGISTRY_PATH = 'registry/ledger.jsonl';
const REGISTRY_HEAD = 'a75bb8e274891f48845b42a358af4c33b56d83589259e14ea7c9c6e72b650201';
const HOUR = 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeCompressionBars({ currentFinal = true } = {}) {
  const bars = Array.from({ length: 145 }, (_, index) => ({
    openTime: index * HOUR,
    closeBoundary: (index + 1) * HOUR,
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    final: true
  }));
  const previous = bars[139];
  previous.high = 100.01;
  previous.low = 99.99;
  const current = bars[140];
  current.open = 99.5;
  current.high = 102;
  current.low = 99;
  current.close = 101.9;
  current.final = currentFinal;
  return bars;
}

function makeExecutionFixture({ breachStop = false, midpointFailure = false } = {}) {
  const bars1h = Array.from({ length: 82 }, (_, index) => {
    const close = 100 + index * 0.2;
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
  return {
    bars1h,
    bars5m,
    fiveByOpenTime: new Map(bars5m.map(row => [row.openTime, row])),
    candidate: {
      id: 'BTCUSDT:test',
      symbol: 'BTCUSDT',
      side: 'BUY',
      decisionTime,
      atr20: 1,
      triggerMidpoint: midpointFailure ? 120 : 90,
      fundingRows: []
    },
    entryTime
  };
}

test('HY-EXP-0030 preregistration is frozen and paper-only', () => {
  const prereg = readJson(PREREG_PATH);
  assert.equal(sha256(PREREG_PATH), HY_EXP_0030_PREREGISTRATION_SHA256);
  assert.equal(prereg.experimentId, 'HY-EXP-0030');
  assert.equal(prereg.baseCommit, '61a8c9199919cfd42bb305de31a3078375278d73');
  assert.equal(prereg.candidateFamily.id, 'VOLATILITY_COMPRESSION_EXPANSION');
  assert.equal(prereg.candidateFamily.q75Allowed, false);
  assert.equal(prereg.candidateFamily.mlAllowed, false);
  assert.equal(prereg.candidateFamily.ridgeAllowed, false);
  assert.equal(prereg.candidateFamily.featureSearchAllowed, false);
  assert.equal(prereg.candidateFamily.compression.baselineExcludesCurrentTrigger, true);
  assert.equal(prereg.candidateFamily.expansion.prior24ExcludesCurrent, true);
  assert.equal(prereg.execution.exit.maximumHoldCompleted1hBars, 12);
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
test('compression uses the previous bar and a 120-bar median without the trigger', () => {
  const bars = makeCompressionBars();
  const signal = evaluateCompressionExpansion({ bars, index: 140 });
  assert.equal(signal.historyComplete, true);
  assert.equal(signal.compression, true);
  assert.equal(signal.compressionBaseline.length, 120);
  assert.equal(signal.triggerBarExcludedFromBaseline, true);
  assert.equal(signal.triggerBarExcludedFromPrior24, true);
  assert.ok(signal.previousNormalizedAtr < signal.compressionMedian);
  assert.equal(signal.expansionRange, true);
  assert.equal(signal.breakout, true);
  assert.equal(signal.green, true);
  assert.equal(signal.upper25Close, true);
  assert.equal(signal.qualifies, true);
});

test('the trigger must be completed and the current bar cannot supply compression state', () => {
  const incomplete = makeCompressionBars({ currentFinal: false });
  assert.equal(evaluateCompressionExpansion({ bars: incomplete, index: 140 }).qualifies, false);

  const noCompression = makeCompressionBars();
  noCompression[139].high = 100.5;
  noCompression[139].low = 99.5;
  assert.equal(evaluateCompressionExpansion({ bars: noCompression, index: 140 }).compression, false);
});

test('exact +5m entry is required and a later bar cannot rescue it', () => {
  const fixture = makeExecutionFixture();
  const missing = new Map(fixture.fiveByOpenTime);
  missing.delete(fixture.entryTime);
  missing.set(fixture.entryTime + FIVE_MINUTES, fixture.bars5m[1]);
  const label = labelCompressionExpansion({
    candidate: fixture.candidate,
    bars1h: fixture.bars1h,
    bars5m: fixture.bars5m,
    fiveByOpenTime: missing
  });
  assert.equal(label.usable, false);
  assert.equal(label.rejection, 'MISSING_EXACT_5M_EXECUTION_BAR');
});

test('stop precedes midpoint failure and otherwise maxHold is 12 completed bars', () => {
  const stopped = makeExecutionFixture({ breachStop: true, midpointFailure: true });
  const stopLabel = labelCompressionExpansion({
    candidate: stopped.candidate,
    bars1h: stopped.bars1h,
    bars5m: stopped.bars5m,
    fiveByOpenTime: stopped.fiveByOpenTime
  });
  assert.equal(stopLabel.usable, true);
  assert.equal(stopLabel.exitReason, 'ATR_STOP');
  assert.equal(stopLabel.stopPrice, 100 - HY_EXP_0030_STOP_ATR_MULTIPLE);

  const midpoint = makeExecutionFixture({ midpointFailure: true });
  const midpointLabel = labelCompressionExpansion({
    candidate: midpoint.candidate,
    bars1h: midpoint.bars1h,
    bars5m: midpoint.bars5m,
    fiveByOpenTime: midpoint.fiveByOpenTime
  });
  assert.equal(midpointLabel.usable, true);
  assert.equal(midpointLabel.exitReason, 'MIDPOINT_FAILURE');

  const terminal = makeExecutionFixture();
  const terminalLabel = labelCompressionExpansion({
    candidate: terminal.candidate,
    bars1h: terminal.bars1h,
    bars5m: terminal.bars5m,
    fiveByOpenTime: terminal.fiveByOpenTime
  });
  assert.equal(terminalLabel.usable, true);
  assert.equal(terminalLabel.exitReason, 'TERMINAL_TWELFTH_BAR');
  assert.equal(HY_EXP_0030_MAX_HOLD_BARS, 12);
});

test('Development result is one fixed-rule OOF and terminally failed without OOS', () => {
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
  assert.equal(result.development.rawCandidateCount, 581);
  assert.equal(result.development.labeledCandidateCount, 581);
  assert.equal(result.development.oofPredictionCount, 264);
  assert.equal(result.development.advisoryCount, 264);
  assert.equal(metrics.advisoriesPer30Days, 14.505494505494505);
  assert.equal(metrics.net18ExpectancyBps, -23.616468711168125);
  assert.equal(metrics.net18ProfitFactor, 0.6213331153428044);
  assert.equal(metrics.net27ExpectancyBps, -32.61646871116812);
  assert.equal(metrics.net27ProfitFactor, 0.5424536239782797);
  assert.equal(metrics.activeMonthCount, 11);
  assert.equal(metrics.positiveActiveMonthShare, 0.2727272727272727);
  assert.deepEqual(metrics.symbols, ['BNBUSDT','BTCUSDT','DOGEUSDT','ETHUSDT','LINKUSDT','LTCUSDT','SOLUSDT','XRPUSDT']);
  assert.equal(metrics.largestSymbolShare, 0.14772727272727273);
  assert.equal(metrics.maxMtmDrawdown, 0.20628373797437327);
  assert.equal(metrics.cvar95LossFraction, 0.033989584560797946);
  assert.equal(metrics.maxLossStreak, 22);
  assert.equal(metrics.bestMonthPositivePnlShare, 0.6750444618334872);
  assert.equal(metrics.netPnlWithoutBestMonth, -20029.552955887964);
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
  assert.equal(sha256(CLOSURE_PATH), '5acdc8a285bcbaea2c630d91fad63b7411f687727f803dd4bee03041388e9527');
});

test('costs, funding and safety remain separate and BUY-only', () => {
  const result = readJson(RESULT_PATH);
  const advisory = result.advisories[0];
  assert.equal(advisory.costs.baseTotalBps, 18);
  assert.equal(advisory.costs.stressTotalBps, 27);
  assert.ok(Math.abs((advisory.net18Bps - advisory.net27Bps) - 9) < 1e-9);
  assert.ok(advisory.realizedFunding);
  assert.equal(advisory.side, 'BUY');
  assert.equal(advisory.family, 'VOLATILITY_COMPRESSION_EXPANSION');
  assert.equal(advisory.paperOnly, true);
  assert.equal(advisory.signalOnly, true);
  assert.equal(advisory.liveOrdersEnabled, false);
  assert.equal(advisory.accountApi, false);
  assert.equal(advisory.orderApi, false);
});

test('registry preserves all earlier terminal experiments and closes 0030 once', () => {
  const entries = fs.readFileSync(REGISTRY_PATH, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const eventsFor = id => entries.filter(entry => entry.experiment_id === id).map(entry => entry.event_type);
  for (const id of ['HY-EXP-0024','HY-EXP-0025','HY-EXP-0026','HY-EXP-0027','HY-EXP-0028','HY-EXP-0029']) {
    assert.equal(eventsFor(id).at(-1), 'failed');
  }
  assert.deepEqual(eventsFor('HY-EXP-0030'), ['preregistered', 'failed']);
  assert.equal(entries.at(-1).hash, REGISTRY_HEAD);
});
