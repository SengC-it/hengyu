import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluatePromotion,
  lossContainmentComparison,
  summarizePerformance
} from '../src/model/performance-audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPERIMENT_ID = 'HY-EXP-0012';
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', EXPERIMENT_ID);
const AUDIT_DIR = path.join(ROOT, 'artifacts', 'audits');
const preregistration = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'registry', 'experiments', EXPERIMENT_ID, 'preregistration.json'),
  'utf8'
));
const rows = fs.readFileSync(path.join(ARTIFACT_DIR, 'portfolios.jsonl'), 'utf8')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map(JSON.parse);

const periodEnd = new Date(preregistration.data.evaluation_end_exclusive_utc);
const periodStart = new Date(periodEnd);
periodStart.setUTCFullYear(periodStart.getUTCFullYear() - 1);

const summary = summarizePerformance(rows, {
  scenario: 'stress',
  periodStart: periodStart.toISOString(),
  periodEnd: periodEnd.toISOString()
});
const screen = preregistration.development_screen;
const promotion = evaluatePromotion(summary, {
  minimumTrades: screen.minimum_event_portfolios,
  minimumProfitFactor: screen.minimum_stress_profit_factor,
  requirePositiveNet: screen.stress_net_return_units_positive,
  requirePositiveWithoutBest5: screen.stress_profit_without_best_5_events_positive,
  maximumDrawdownReturnUnits: screen.maximum_stress_drawdown_return_units
});
const comparison = lossContainmentComparison(summary, {
  referenceNotionalUsdt: preregistration.portfolio.reference_gross_notional_usdt
});
const audit = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  experimentId: EXPERIMENT_ID,
  evidenceClass: preregistration.evidence_class,
  purpose: 'ROLLING_12_MONTH_PERFORMANCE_AND_GOVERNANCE_AUDIT',
  summary,
  promotion,
  lossContainmentComparison: comparison,
  currentResearchDirection: {
    experimentId: 'HY-EXP-0014',
    status: 'F0_PENDING',
    paperOnly: true,
    historicalProfitClaimAllowed: false
  }
};

if (process.argv.includes('--write')) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(AUDIT_DIR, `${EXPERIMENT_ID}-rolling-12m.json`),
    `${JSON.stringify(audit, null, 2)}\n`
  );
}
process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
