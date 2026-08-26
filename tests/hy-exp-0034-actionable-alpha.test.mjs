import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = relative => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
const sha256 = relative => createHash('sha256').update(fs.readFileSync(path.join(ROOT, relative))).digest('hex');

test('HY-EXP-0034 preregistration freezes five families and fifteen specifications before outcomes', () => {
  const prereg = readJson('registry/experiments/HY-EXP-0034/preregistration.json');
  assert.equal(prereg.status, 'PREREGISTERED');
  assert.equal(prereg.experimentId, 'HY-EXP-0034');
  assert.equal(prereg.dataWindow.start, '2024-08-26T00:00:00Z');
  assert.equal(prereg.dataWindow.endExclusive, '2026-08-26T00:00:00Z');
  assert.deepEqual(Object.keys(prereg.families), [
    'A_TREND_PULLBACK',
    'B_VOLATILITY_COMPRESSION_EXPANSION',
    'C_FUNDING_BASIS_CROWDING_REVERSAL',
    'D_CROSS_SECTIONAL_RELATIVE_STRENGTH',
    'E_BTC_RESIDUAL_MEAN_REVERSION'
  ]);
  assert.deepEqual(Object.keys(prereg.executionProfiles), ['P1', 'P2', 'P3']);
  assert.equal(prereg.multipleTesting.numberOfSpecificationsTried, 15);
  assert.equal(prereg.walkForward.randomSplit, false);
  assert.equal(prereg.walkForward.purgeHours, 48);
  assert.equal(prereg.walkForward.embargoHours, 36);
  assert.equal(prereg.bootstrap.iterations, 5000);
  assert.equal(prereg.bootstrap.seed, 340034);
  assert.equal(prereg.safety.paperOnly, true);
  assert.equal(prereg.safety.signalOnly, true);
  assert.equal(prereg.safety.gmailSendEnabled, false);
  assert.equal(prereg.safety.schedulerActivated, false);
  assert.equal(prereg.safety.automaticTrading, false);
  assert.equal(prereg.safety.finalOosRead, false);
  assert.equal(prereg.freezeContract.outcomesRead, false);
});

test('HY-EXP-0034 manifest is a fixed-eight, hash-locked, complete causal subset', () => {
  const manifest = readJson('artifacts/HY-EXP-0034/data-manifest.json');
  assert.equal(manifest.experimentId, 'HY-EXP-0034');
  assert.equal(manifest.sourceExperiment, 'HY-EXP-0033');
  assert.equal(manifest.sourceManifestSha256, 'c5572595820b6d58c8480edd355320bbf28e7a641350d8eeff791afcb6ff9311');
  assert.equal(manifest.preregistrationCommit, '561989374e370aed824a5c12271b25dbf2ca8a5b');
  assert.equal(manifest.preregistrationSha256, '1824b119087503b07ded2da586df87d518bda9e783b51ec025ad7989c4085f93');
  assert.equal(manifest.coverageStatus, 'PASS_FIXED_EIGHT_SOURCE_SUBSET');
  assert.equal(manifest.missingCount, 0);
  assert.equal(manifest.files.length, 992);
  assert.equal(manifest.parity.length, 16);
  assert.equal(manifest.parity.every(row => row.archiveVsRestEqual === true), true);
  assert.equal(manifest.outcomeRead, false);
  assert.equal(manifest.pnlComputed, false);
  assert.equal(manifest.finalOosRead, false);
  assert.equal(manifest.safety.paperOnly, true);
  assert.equal(manifest.safety.signalOnly, true);
  assert.equal(manifest.safety.gmail, false);
  assert.equal(manifest.safety.scheduler, false);
  assert.equal(manifest.safety.automaticTrading, false);
  assert.equal(manifest.safety.finalOosRead, false);
  assert.deepEqual(manifest.symbols, ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT']);
});

test('HY-EXP-0034 result is development-only and fails closed with no actionable winner', () => {
  const prereg = readJson('registry/experiments/HY-EXP-0034/preregistration.json');
  const result = readJson('artifacts/HY-EXP-0034/tournament-result.json');
  assert.equal(result.experimentId, 'HY-EXP-0034');
  assert.equal(result.preregistrationSha256, sha256('registry/experiments/HY-EXP-0034/preregistration.json'));
  assert.equal(result.dataManifestSha256, sha256('artifacts/HY-EXP-0034/data-manifest.json'));
  assert.equal(result.outcomeRead, true);
  assert.equal(result.pnlComputed, true);
  assert.equal(result.finalOosRead, false);
  assert.equal(result.winner, 'NO_ACTIONABLE_ALPHA_FOUND');
  assert.equal(result.conclusion, 'PUBLIC_OHLCV_MARK_FUNDING_ALPHA_EXHAUSTED');
  assert.deepEqual(result.familyPassers, []);
  assert.equal(Object.keys(result.families).length, 5);
  for (const family of Object.values(result.families)) {
    assert.equal(family.gates.pass, false);
    assert.equal(family.summary.risk.portfolioMtmStatus, 'NOT_RECONSTRUCTED');
    assert.equal(family.summary.portfolioMtmDrawdownFraction, null);
    assert.equal(family.summary.portfolioCvar95, null);
    assert.equal(family.summary.risk.portfolioCvarStatus, 'NOT_EVALUABLE');
    assert.equal(family.summary.signalCount, 0);
    assert.equal(family.summary.profileChoicesByFold.length, 18);
    assert.equal(family.summary.profileChoicesByFold.every(fold => fold.selectedProfile === 'NO_TRADE'), true);
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'artifacts', 'HY-EXP-0034', 'validation-preparation.json')), false);
  assert.equal(prereg.futureValidation.activated, false);
  assert.equal(prereg.reservedIds['HY-EXP-0035'].startsWith('DO_NOT_CREATE'), true);
});

test('HY-EXP-0034 tournament implementation has no production or private API path', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'hy-exp-0034-tournament.mjs'), 'utf8');
  assert.equal(source.includes('finalOosRead: false'), true);
  assert.equal(source.includes('https://'), false);
  assert.equal(source.includes('fetch('), false);
  assert.equal(source.includes('node:https'), false);
  assert.equal(source.includes('createTransport'), false);
});
