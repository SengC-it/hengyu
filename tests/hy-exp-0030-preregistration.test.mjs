import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preregistrationPath = path.join(ROOT, 'registry', 'experiments', 'HY-EXP-0030', 'preregistration.json');

test('HY-EXP-0030 keeps its preregistration immutable after development evidence', () => {
  const draft = JSON.parse(fs.readFileSync(preregistrationPath, 'utf8'));
  const ledger = fs.readFileSync(path.join(ROOT, 'registry', 'ledger.jsonl'), 'utf8');
  assert.equal(draft.experiment_id, 'HY-EXP-0030');
  assert.equal(draft.status, 'PREREGISTERED');
  assert.equal('registry_event' in draft, false);
  assert.equal(draft.pre_outcome_lock.outcomes_read, false);
  assert.equal(draft.pre_outcome_lock.pnl_computed, false);
  assert.equal(draft.pre_outcome_lock.final_oos_read, false);
  assert.equal(ledger.includes('"experiment_id":"HY-EXP-0030"'), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'artifacts', 'HY-EXP-0030', 'development-result.json')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'artifacts', 'HY-EXP-0030', 'trades.jsonl')), true);
});

test('HY-EXP-0030 freezes the large-sample, two-direction, causal design', () => {
  const draft = JSON.parse(fs.readFileSync(preregistrationPath, 'utf8'));
  assert.equal(draft.development_window.target_calendar_days, 730);
  assert.equal(draft.development_window.hard_minimum_calendar_days, 365);
  assert.equal(draft.development_window.preferred_calendar_days, 730);
  assert.equal(draft.pre_outcome_dataset_gate.raw_candidates_at_least, 300);
  assert.equal(draft.pre_outcome_dataset_gate.BUY_candidates_at_least, 100);
  assert.equal(draft.pre_outcome_dataset_gate.SELL_candidates_at_least, 100);
  assert.equal(draft.primary_model.minimum_training_candidates, 150);
  assert.equal(draft.candidate_generators['HY-EXP-0030_BULL'].side, 'BUY');
  assert.equal(draft.candidate_generators['HY-EXP-0030_BEAR'].side, 'SELL');
  assert.equal(draft.candidate_generators['HY-EXP-0030_BEAR'].regime, 'BEAR');
  assert.equal(draft.candidate_generators.SIDEWAYS.status, 'NO_TRADE_CONTEXT');
  assert.equal(Object.keys(draft.feature_snapshot.features).length, 21);
  assert.equal(draft.feature_snapshot.required_coverage, 1);
  assert.equal(draft.walk_forward.random_split, false);
  assert.equal(draft.walk_forward.oof_only, true);
  assert.equal(draft.portfolio_risk.mark_series.includes('markPriceKlines'), true);
  assert.equal(draft.portfolio_risk.required_portfolio_mtm, true);
  assert.equal(draft.portfolio_risk.single_trade_proxy_substitution, false);
  assert.equal(draft.promotion_gates.portfolio_cvar_required, true);
  assert.equal(draft.safety.paper_only, true);
  assert.equal(draft.safety.gmail_send_enabled, false);
  assert.equal(draft.safety.automatic_trading, false);
});
