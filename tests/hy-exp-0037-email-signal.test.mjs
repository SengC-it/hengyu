import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  BASE_MAIN_COMMIT,
  COSTS_BPS,
  DEVELOPMENT_END,
  DEVELOPMENT_START,
  FEATURE_NAMES,
  FIXED_SYMBOLS,
  MODEL_LAMBDAS,
  SOURCE_MANIFEST_PATH,
  SOURCE_MANIFEST_SHA256,
  VALIDATION_END,
  VALIDATION_START,
  applyFrequency,
  blockBootstrap,
  buildEmailPreparation,
  evaluatePromotionGates,
  fitRidge,
  selectDevelopmentConfig,
  summarizeRows
} from '../src/research/hy-exp-0037-email-signal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = relative => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));

test('HY-EXP-0037 preregistration freezes causal windows, source and safety', () => {
  const prereg = readJson('registry/experiments/HY-EXP-0037/preregistration.json');
  assert.equal(prereg.status, 'PREREGISTERED');
  assert.equal(prereg.baseMainCommit, BASE_MAIN_COMMIT);
  assert.equal(prereg.dataWindow.development.start, '2024-08-26T00:00:00Z');
  assert.equal(prereg.dataWindow.development.endExclusive, '2025-08-26T00:00:00Z');
  assert.equal(prereg.dataWindow.historicalValidation.start, '2025-08-26T00:00:00Z');
  assert.equal(prereg.dataWindow.historicalValidation.endExclusive, '2026-08-26T00:00:00Z');
  assert.equal(prereg.dataWindow.finalOosRead, false);
  assert.equal(prereg.dataPolicy.sourceManifestPath, SOURCE_MANIFEST_PATH);
  assert.equal(prereg.dataPolicy.sourceManifestSha256, SOURCE_MANIFEST_SHA256);
  assert.deepEqual(prereg.universe.fixedSymbols, FIXED_SYMBOLS);
  assert.equal(prereg.universe.pointInTime, true);
  assert.equal(prereg.universe.survivorshipSelection, false);
  assert.deepEqual(prereg.features.names, FEATURE_NAMES);
  assert.deepEqual(prereg.model.lambdaGrid, MODEL_LAMBDAS);
  assert.deepEqual(prereg.referenceTrade.costs, {
    baseBps: 18,
    stressBps: 27,
    severeBps: 36,
    charge: 'One frozen all-in execution cost budget per entry and exit fill; source-embedded costs are not charged twice.'
  });
  assert.equal(prereg.safety.SIGNAL_ONLY, true);
  assert.equal(prereg.safety.PAPER_ONLY, true);
  assert.equal(prereg.safety.AUTO_TRADING, false);
  assert.equal(prereg.safety.accountApi, false);
  assert.equal(prereg.safety.orderApi, false);
  assert.equal(prereg.safety.finalOosRead, false);
});

test('HY-EXP-0037 research implementation has no external or private execution path', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/research/hy-exp-0037-email-signal.mjs'), 'utf8');
  const script = fs.readFileSync(path.join(ROOT, 'scripts/hy-exp-0037.mjs'), 'utf8');
  for (const value of [source, script]) {
    assert.equal(value.includes('fetch('), false);
    assert.equal(value.includes('createTransport'), false);
    assert.equal(value.includes('nodemailer'), false);
    assert.equal(value.includes('PRIVATE_STREAM'), false);
    assert.equal(value.includes('ACCOUNT_API'), false);
    assert.equal(value.includes('ORDER_API'), false);
  }
});

test('HY-EXP-0037 rejects empty or incomplete promotion risk evidence', () => {
  const risk = {
    portfolioMtmStatus: 'NOT_RECONSTRUCTED',
    portfolioMtmDrawdownFraction: null,
    portfolioCvarStatus: 'NOT_EVALUATED',
    portfolioCvar95: null
  };
  const bootstrap = blockBootstrap([]);
  const gates = evaluatePromotionGates([], { status: 'NO_DEVELOPMENT_CONFIG' }, risk, bootstrap);
  assert.equal(gates.pass, false);
  assert.equal(gates.checks.portfolioMtm, false);
  assert.equal(gates.checks.portfolioCvar, false);
  assert.equal(gates.checks.bootstrapNet27Lower95, false);
  assert.equal(bootstrap.status, 'EMPTY_SAMPLE_NOT_EVALUABLE');
  assert.equal(bootstrap.iterations, 5000);
});

test('HY-EXP-0037 preserves exact three cost bases and explicit non-email preparation', () => {
  assert.deepEqual(COSTS_BPS, { 18: 18, 27: 27, 36: 36 });
  const preparation = buildEmailPreparation({
    validation: { emailPreparationEligible: true },
    codeCommit: 'a'.repeat(40),
    preregistrationSha256: 'b'.repeat(64),
    dataManifestSha256: 'c'.repeat(64)
  });
  assert.equal(preparation.EMAIL_PREPARED, true);
  assert.equal(preparation.EMAIL_ACTIVATED, false);
  assert.equal(preparation.gmailSendEnabled, false);
  assert.equal(preparation.noQuantity, true);
  assert.equal(preparation.noLeverage, true);
  assert.equal(preparation.noOrderInstruction, true);
  assert.equal(preparation.finalOosRead, false);
});

test('HY-EXP-0037 applies deterministic frequency and same-symbol cooldown', () => {
  const start = DEVELOPMENT_START + 200 * 24 * 60 * 60 * 1000;
  const rows = [
    { candidateId: 'a', symbol: 'BTCUSDT', decisionTime: start, exitTime: start + 12 * 60 * 60 * 1000, predictedEdgeBps: 10 },
    { candidateId: 'b', symbol: 'BTCUSDT', decisionTime: start + 15 * 60 * 1000, exitTime: start + 13 * 60 * 60 * 1000, predictedEdgeBps: 11 },
    { candidateId: 'c', symbol: 'ETHUSDT', decisionTime: start + 30 * 60 * 1000, exitTime: start + 12 * 60 * 60 * 1000, predictedEdgeBps: 9 },
    { candidateId: 'd', symbol: 'BNBUSDT', decisionTime: start + 45 * 60 * 1000, exitTime: start + 12 * 60 * 60 * 1000, predictedEdgeBps: 8 },
    { candidateId: 'e', symbol: 'SOLUSDT', decisionTime: start + 24 * 60 * 60 * 1000, exitTime: start + 36 * 60 * 60 * 1000, predictedEdgeBps: 12 }
  ];
  const selected = applyFrequency(rows, 8);
  assert.deepEqual(selected.map(row => row.candidateId), ['a', 'c', 'e']);
});

test('HY-EXP-0037 ridge model is deterministic and uses only finite fixed features', () => {
  const training = Array.from({ length: 180 }, (_, index) => ({
    features: FEATURE_NAMES.map((_, feature) => ((index + 1) * (feature + 1) % 17) / 17),
    net27Bps: ((index % 11) - 5) + index / 100
  }));
  const model = fitRidge(training, 1);
  assert.ok(model);
  assert.equal(model.trainingCount, 180);
  assert.equal(Number.isFinite(model.predict(training[0].features)), true);
  assert.equal(fitRidge(training.slice(0, 149), 1), null);
});

test('HY-EXP-0037 development selection fails closed without OOF rows', () => {
  const result = selectDevelopmentConfig([]);
  assert.equal(result.status, 'NO_DEVELOPMENT_CONFIG');
  assert.equal(result.reason, 'NO_OOF_PREDICTIONS');
});

test('HY-EXP-0037 metrics preserve calendar boundaries and empty risk semantics', () => {
  const rows = [{
    candidateId: 'one',
    symbol: 'BTCUSDT',
    side: 'BUY',
    decisionTime: VALIDATION_START,
    exitTime: VALIDATION_START + 60 * 60 * 1000,
    net18Bps: 2,
    net27Bps: -7,
    net36Bps: -16,
    fundingBps: 0,
    exitReason: 'TARGET'
  }];
  const summary = summarizeRows(rows, 'net27Bps');
  assert.equal(summary.netPnlBps, -7);
  assert.equal(summary.netExpectancyBps, -7);
  assert.equal(summary.activeMonths, 1);
  assert.equal(summary.netPnlWithoutBestMonthBps, 0);
  assert.equal(VALIDATION_END - VALIDATION_START, 365 * 24 * 60 * 60 * 1000);
  assert.equal(DEVELOPMENT_END - DEVELOPMENT_START, 365 * 24 * 60 * 60 * 1000);
});
