import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(process.cwd());
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'HY-EXP-0020');
const readJson = name => JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIR, name), 'utf8'));

const REQUIRED_FIELDS = [
  'listingOnboardDate',
  'status',
  'contractType',
  'quoteAsset',
  'tickSize',
  'stepSize',
  'minQty',
  'minNotional'
];

test('HY-EXP-0020 Phase C2 kills the frozen PIT metadata requirement fail-closed', () => {
  const report = readJson('phase-c2-metadata-kill-test.json');
  assert.deepEqual(report.frozenWindow, {
    start: '2024-01-01T00:00:00.000Z',
    endExclusive: '2026-07-01T00:00:00.000Z',
    finalOosStart: '2026-09-01T00:00:00.000Z',
    finalOosEndExclusive: '2027-03-01T00:00:00.000Z',
    finalOosRead: false
  });
  assert.deepEqual(report.requiredFields, REQUIRED_FIELDS);
  assert.equal(report.historicalExchangeInfo, 'NOT_QUALIFIED');
  assert.equal(report.canEverSatisfyFrozen0020WithoutChangingSpec, false);
  assert.equal(report.recommendedDecision, 'CLOSE_HY_EXP_0020_DATA_FAIL');
  assert.equal(report.qualificationRule.currentExchangeInfoBackfillAllowed, false);
  assert.equal(report.qualificationRule.announcementStitchingAllowed, false);
  assert.equal(report.qualificationRule.bestEffortHistoryAllowed, false);
  assert.equal(report.completenessGuarantee.qualifiedSource, null);
  assert.equal(report.completenessGuarantee.allEightFieldsGuaranteed, false);
  assert.equal(report.completenessGuarantee.completeEffectiveTimeHistoryGuaranteed, false);
  assert.equal(report.effectiveTimestampAvailable.allEightFieldsAtEveryDecisionTime, false);
  assert.equal(report.effectiveTimestampAvailable.announcementDatesAreNotFilterEffectiveHistory, true);
  assert.equal(report.sourcesAudited.length, 5);
  for (const source of report.sourcesAudited) {
    assert.notEqual(source.qualification, 'QUALIFIED', source.sourceId);
    assert.equal(source.completenessGuarantee, false, source.sourceId);
    assert.equal(source.effectiveTimestampAvailable === true, false, source.sourceId);
  }
  const tardis = report.sourcesAudited.find(source => source.sourceId === 'TARDIS_INSTRUMENTS_METADATA');
  assert.ok(tardis);
  assert.match(tardis.observedEvidence.join('\n'), /best effort/i);
  assert.equal(tardis.fieldCoverage.minNotional, 'not_documented_as_complete_historical_field');
});

test('HY-EXP-0020 closure records frozen DATA_FAIL and forbids rescue or execution', () => {
  const closure = readJson('closure.json');
  assert.equal(closure.status, 'DATA_FAIL_FROZEN');
  assert.equal(closure.reason, 'HISTORICAL_PIT_EXCHANGE_INFO_UNAVAILABLE_OR_NOT_PROVABLY_COMPLETE');
  assert.equal(closure.historicalExchangeInfo, 'NOT_QUALIFIED');
  assert.equal(closure.decision, 'CLOSE_HY_EXP_0020_DATA_FAIL');
  assert.equal(closure.canEverSatisfyFrozen0020WithoutChangingSpec, false);
  assert.deepEqual(closure.safety, {
    paperOnly: true,
    tardisL2Purchase: false,
    developmentRun: false,
    finalOosRead: false,
    pnlComputed: false,
    preregistrationModified: false,
    specificationModified: false,
    currentExchangeInfoBackfillUsed: false,
    announcementStitchingUsed: false,
    mergePerformed: false,
    productionDeployed: false
  });
  assert.equal(fs.existsSync(path.join(ARTIFACT_DIR, 'result.json')), false);
  assert.equal(fs.existsSync(path.join(ARTIFACT_DIR, 'trades.jsonl')), false);
  assert.match(closure.closureStatements.join('\n'), /new experiment ID/i);
});
