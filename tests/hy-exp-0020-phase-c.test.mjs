import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(process.cwd());
const artifactPath = name => path.join(ROOT, 'artifacts', 'HY-EXP-0020', name);
const readJson = name => JSON.parse(fs.readFileSync(artifactPath(name), 'utf8'));

test('HY-EXP-0020 Phase B closure preserves the three reliability manifests and safety state', () => {
  const closure = readJson('phase-b-closure.json');
  const reliability = readJson('phase-b-reliability.json');

  assert.equal(closure.sourceCommit, 'e412c73ad39807b77351c7f1c72109cdaa733026');
  assert.equal(closure.status, 'PHASE_B_COLLECTOR_PASS');
  assert.equal(closure.reliability.result, 'PHASE_B_RELIABILITY_PASS');
  assert.equal(closure.reliability.requiredRuns, 3);
  assert.equal(closure.reliability.completedRuns, 3);
  assert.deepEqual(
    closure.reliability.manifestSha256,
    reliability.runs.map(run => run.manifestSha256)
  );
  assert.equal(closure.quality.snapshotAlignmentFailures, 0);
  assert.equal(closure.quality.sequenceGaps, 0);
  assert.equal(closure.quality.crossedBooks, 0);
  assert.equal(closure.safety.authorization, 'PAPER_ONLY');
  assert.equal(closure.safety.dataStatus, 'DATA_FAIL');
  assert.equal(closure.safety.pnlComputed, false);
  assert.equal(closure.safety.developmentAllowed, false);
  assert.equal(closure.scope.phaseBCollectorEvidenceUnmodified, true);
});

test('HY-EXP-0020 Phase C qualification fails closed without unlocking Development', () => {
  const report = readJson('historical-data-qualification.json');
  const requiredWindow = {
    start: '2024-01-01T00:00:00.000Z',
    endExclusive: '2026-07-01T00:00:00.000Z'
  };

  assert.deepEqual(
    {
      start: report.qualificationWindow.start,
      endExclusive: report.qualificationWindow.endExclusive
    },
    requiredWindow
  );
  assert.equal(report.historicalL2, 'NOT_ACQUIRED');
  assert.equal(report.historicalExchangeInfo, 'NOT_ACQUIRED');
  assert.equal(report.funding, 'PARTIAL');
  assert.equal(report.fullWindowCoverage, false);
  assert.equal(report.developmentDataFeasible, false);
  assert.equal(report.developmentAllowed, false);
  assert.equal(report.pnlComputed, false);
  assert.equal(report.decision, 'STOP_HY_EXP_0020_DATA_INFEASIBLE');
  assert.equal(report.promotion.phaseCDataLockAuthorized, false);
  assert.equal(report.sampleValidation.dataFeasible, false);
  assert.equal(report.sampleValidation.developmentUnlocked, false);
  assert.equal(report.sourcePolicy.ohlcvDepthProxyAccepted, false);
  assert.equal(report.sourcePolicy.bookTickerAcceptedAsL2, false);
  assert.equal(report.sourcePolicy.currentExchangeInfoBackfillAccepted, false);
  assert.equal(report.sourcePolicy.syntheticSequenceOrGapFillAccepted, false);

  const coverageFields = report.symbolCoverageAudit.requiredRowFields;
  assert.ok(report.symbolCoverageAudit.rows.length >= 1);
  for (const row of report.symbolCoverageAudit.rows) {
    for (const field of coverageFields) assert.ok(Object.hasOwn(row, field), `${row.symbol}:${field}`);
  }

  const normalizedSource = report.candidateSources.find(
    source => source.sourceId === 'TARDIS_NORMALIZED_INCREMENTAL_BOOK_L2_CSV'
  );
  assert.equal(normalizedSource.qualification, 'NOT_QUALIFIED_FOR_HY_EXP_0020');
  assert.equal(report.provenanceAndLicense.historicalL2.authorization, false);
  assert.equal(report.provenanceAndLicense.historicalL2.immutableManifest, false);
  assert.equal(report.promotion.developmentRead, false);
  assert.equal(report.promotion.backtestRun, false);
  assert.equal(report.promotion.oosRead, false);
  assert.equal(fs.existsSync(artifactPath('result.json')), false);
  assert.equal(fs.existsSync(artifactPath('trades.jsonl')), false);
  assert.doesNotMatch(JSON.stringify(report), /DATA_FEASIBLE/);
});
