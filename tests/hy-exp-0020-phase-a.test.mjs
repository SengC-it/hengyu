import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';

const ROOT = path.resolve(process.cwd());
const specPath = path.join(ROOT, 'registry', 'experiments', 'HY-EXP-0020', 'specification.json');
const feasibilityPath = path.join(ROOT, 'artifacts', 'HY-EXP-0020', 'data-feasibility.json');
const preregPath = path.join(ROOT, 'registry', 'experiments', 'HY-EXP-0020', 'preregistration.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('HY-EXP-0020 Phase A freezes exact model, exits, gates and final OOS boundaries', () => {
  const spec = readJson(specPath);
  assert.equal(spec.status, 'PHASE_A_EXACT_SPEC_FROZEN');
  assert.equal(spec.candidate.entry_channel_bars, 120);
  assert.equal(spec.regime.fast_sma_bars, 60);
  assert.equal(spec.regime.slow_sma_bars, 180);
  assert.equal(spec.edge_model.label.forward_horizon_bars, 6);
  assert.equal(spec.edge_model.purge_and_embargo.purge_bars, 6);
  assert.equal(spec.edge_model.purge_and_embargo.embargo_bars, 6);
  assert.deepEqual(spec.edge_model.candidate_cells, ['BULL:BUY', 'BEAR:SELL']);
  assert.equal(spec.edge_model.pooled_mean_forbidden, true);
  assert.equal(spec.edge_model.training_method.ridge_lambda, 10);
  assert.equal(spec.edge_model.minimum_samples_per_cell, 100);
  assert.equal(spec.edge_model.minimum_calibration_samples, 100);
  assert.equal(spec.exit_model.dynamic_channel.channel_bars, 60);
  assert.equal(spec.exit_model.atr_stop.multiple, 2);
  assert.equal(spec.exit_model.profit_protection.enabled, true);
  assert.equal(spec.exit_model.no_fixed_max_hold, true);
  assert.equal(spec.time_windows.final_oos_start_utc, '2026-09-01T00:00:00.000Z');
  assert.equal(spec.time_windows.final_oos_end_exclusive_utc, '2027-03-01T00:00:00.000Z');
});

test('HY-EXP-0020 Phase A fails closed on missing historical L2 and forbids fallbacks or PnL', () => {
  const feasibility = readJson(feasibilityPath);
  assert.equal(feasibility.status, 'DATA_FAIL');
  assert.equal(feasibility.decision, 'STOP');
  assert.equal(feasibility.pnl_computed, false);
  assert.equal(feasibility.development_read, false);
  assert.equal(feasibility.final_oos_read, false);
  assert.equal(feasibility.promotion_effect.development_allowed, false);
  assert.equal(feasibility.promotion_effect.final_oos_allowed, false);
  assert.equal(feasibility.promotion_effect.fallback_to_bookTicker, false);
  assert.equal(feasibility.promotion_effect.fallback_to_ohlcv_proxy, false);
  assert.equal(fs.existsSync(path.join(ROOT, 'artifacts', 'HY-EXP-0020', 'result.json')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'artifacts', 'HY-EXP-0020', 'trades.jsonl')), false);
});

test('HY-EXP-0020 Phase A does not mutate the accepted preregistration', () => {
  assert.equal(
    sha256(preregPath),
    'a11b33d9740e695ecdd72a5ccdabf3db3e7646f8afc508289f790d56aaff30e8'
  );
});
