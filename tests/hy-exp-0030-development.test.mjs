import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(ROOT, 'artifacts', 'HY-EXP-0030');
const readJson = name => JSON.parse(fs.readFileSync(path.join(artifactRoot, name), 'utf8'));

test('HY-EXP-0030 data audit is prospective and public-only', () => {
  const audit = readJson('data-availability-audit.json');
  assert.equal(audit.status, 'DATA_AVAILABLE_AUDIT_PASS');
  assert.equal(audit.developmentAllowed, true);
  assert.equal(audit.outcomeRead, false);
  assert.equal(audit.pnlComputed, false);
  assert.equal(audit.finalOosRead, false);
  assert.equal(audit.historicalSources.privateApiUsed, false);
  assert.equal(audit.historicalSources.accountApiUsed, false);
  assert.equal(audit.historicalSources.orderApiUsed, false);
  assert.equal(audit.historicalSources.openInterestHistoricalUsed, false);
  assert.equal(audit.historicalSources.historicalL2Used, false);
  assert.equal(audit.historicalSources.ohlcvDepthProxyUsed, false);
});

test('HY-EXP-0030 development has both directional candidates and no-trade context', () => {
  const audit = readJson('data-availability-audit.json');
  const context = readJson('sideways-context.json');
  assert.ok(audit.candidateCounts.BUY >= 100);
  assert.ok(audit.candidateCounts.SELL >= 100);
  assert.ok(audit.candidateCounts.SIDEWAYS_CONTEXT > 0);
  assert.equal(context.length, audit.candidateCounts.SIDEWAYS_CONTEXT);
  assert.ok(context.every(row => row.side === 'NO_TRADE' && row.contextStatus === 'NO_TRADE' && row.symbols.length > 0));
  assert.ok(context.every(row => !('netPnl' in row) && !('exitTime' in row) && !('futureFunding' in row)));
  assert.equal(fs.existsSync(path.join(artifactRoot, 'candidate-feature-snapshot.json')), true);
});

test('HY-EXP-0030 result is fail-closed when no OOF candidate is accepted', () => {
  const result = readJson('development-result.json');
  const manifest = readJson('data-manifest.json');
  assert.equal(result.counts.oofPredictions, 1836);
  assert.equal(result.counts.accepted, 0);
  assert.equal(result.status, 'NOT_READY');
  assert.equal(result.promotionEligible, false);
  assert.equal(result.portfolioRisk.portfolioMtmDrawdownFraction, null);
  assert.equal(result.portfolioRisk.portfolioMtmStatus, 'EMPTY_SAMPLE_NOT_EVALUABLE');
  assert.equal(result.portfolioRisk.portfolioCvar95, null);
  assert.equal(result.portfolioRisk.portfolioCvarStatus, 'EMPTY_SAMPLE_NOT_EVALUABLE');
  assert.ok(manifest.files.some(file => file.stream === 'mark5m'));
});

test('HY-EXP-0030 diagnostic models cannot become promotion models', () => {
  const result = readJson('development-result.json');
  assert.equal(result.modelComparison.RULE_SCORECARD.diagnosticOnly, true);
  assert.equal(result.modelComparison.SHALLOW_GBT.diagnosticOnly, true);
  assert.equal(result.primaryModel.name, 'RIDGE_LOGISTIC_CONDITIONAL_RETURN_EDGE');
  assert.equal(result.sourceBoundary.finalOosRead, false);
});
