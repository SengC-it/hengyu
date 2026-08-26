import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const draftPath = path.join(ROOT, 'registry', 'experiments', 'HY-EXP-0030', 'preregistration-draft.json');

test('HY-EXP-0030 remains an unaccepted preregistration draft with no outcomes', () => {
  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  const ledger = fs.readFileSync(path.join(ROOT, 'registry', 'ledger.jsonl'), 'utf8');
  assert.equal(draft.experiment_id, 'HY-EXP-0030');
  assert.equal(draft.status, 'DRAFT_PENDING_USER_ACCEPTANCE');
  assert.equal(draft.registry_event, null);
  assert.equal(draft.acceptance_boundary.development_allowed, false);
  assert.equal(draft.acceptance_boundary.outcomes_read, false);
  assert.equal(draft.acceptance_boundary.pnl_computed, false);
  assert.equal(draft.acceptance_boundary.final_oos_read, false);
  assert.equal(ledger.includes('HY-EXP-0030'), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'artifacts', 'HY-EXP-0030', 'result.json')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'artifacts', 'HY-EXP-0030', 'trades.jsonl')), false);
});

test('HY-EXP-0030 freezes the large-sample, two-direction, causal design', () => {
  const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
  assert.equal(draft.development_window.target_calendar_days, 730);
  assert.equal(draft.development_window.minimum_candidate_rows, 150);
  assert.equal(draft.development_window.preferred_candidate_rows, 250);
  assert.equal(draft.candidate_generators['HY-EXP-0028-BULL-BUY'].status, 'IMMUTABLE_IMPORTED_RULE');
  assert.equal(draft.candidate_generators['HY-EXP-0030-BEAR'].side, 'SELL');
  assert.equal(draft.candidate_generators['HY-EXP-0030-BEAR'].regime, 'BEAR');
  assert.equal(draft.candidate_generators.SIDEWAYS.status, 'NO_TRADE_CONTEXT');
  assert.equal(Object.keys(draft.feature_snapshot.features).length, 18);
  assert.equal(draft.feature_snapshot.required_coverage, 1);
  assert.equal(draft.walk_forward.random_split, false);
  assert.equal(draft.walk_forward.oof_only_metrics, true);
  assert.equal(draft.portfolio_risk.portfolio_equity_marks.includes('executable'), true);
  assert.equal(draft.promotion_gates.portfolioCvarRequired, true);
  assert.equal(draft.safety.paper_only, true);
  assert.equal(draft.safety.gmail_send_enabled, false);
  assert.equal(draft.safety.automatic_trading, false);
});
