import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { evaluateLiveH12Scan, H12_PRODUCTION_POLICY } from '../src/model/live-h12.mjs';

const audit = JSON.parse(fs.readFileSync('artifacts/audits/HY-EXP-0024-signal-funnel.json', 'utf8'));
const design = JSON.parse(fs.readFileSync('artifacts/audits/HY-EXP-0024-model-design.json', 'utf8'));

function fallingSeries(symbol, breakout = false) {
  const step = 4 * 60 * 60 * 1000;
  return Array.from({ length: 182 }, (_, index) => {
    const base = 300 - index;
    const close = breakout && index === 180 ? base - 2 : base;
    return {
      symbol,
      openTime: index * step,
      closeTime: (index + 1) * step - 1,
      open: base + 0.5,
      high: base + 1,
      low: base - 1,
      close
    };
  });
}

function marketBySymbol() {
  return Object.fromEntries(H12_PRODUCTION_POLICY.symbols.map(symbol => [symbol, {
    book: {
      bids: [[100, 1_000]],
      asks: [[100.01, 1_000]],
      receivedAt: 181 * 4 * 60 * 60 * 1000
    },
    funding: {
      fundingRate: 0,
      fundingTime: 180 * 4 * 60 * 60 * 1000,
      nextFundingTime: 182 * 4 * 60 * 60 * 1000,
      markPrice: 100
    }
  }]));
}

test('HY-EXP-0024 audit is research-only and does not reuse 0019 OOS', () => {
  assert.equal(audit.experimentId, 'HY-EXP-0024');
  assert.equal(audit.status, 'AUDIT_ONLY_NOT_PREREGISTERED');
  assert.equal(audit.authorization, 'PAPER_ONLY');
  assert.equal(audit.liveOrdersEnabled, false);
  assert.equal(audit.pnlComputed, false);
  assert.equal(audit.auditWindow.start, '2024-01-01T00:00:00.000Z');
  assert.equal(audit.auditWindow.endExclusive, '2025-07-01T00:00:00.000Z');
  assert.match(audit.auditWindow.prohibitedWindowReuse, /2025-07-01/);
  assert.equal(audit.currentH12Funnel.gmailAdvisories, 0);
  assert.equal(audit.proposedExpansionFunnel.edgeEligible, 0);
  assert.equal(audit.noPromotionDecision.betterNetProfitabilityAndUsableSignalCount, false);
});

test('live H12 otherwise-valid breakout remains structurally blocked by unverified Edge', () => {
  const series = Object.fromEntries(H12_PRODUCTION_POLICY.symbols.map(symbol => [
    symbol,
    fallingSeries(symbol, symbol === 'BTCUSDT')
  ]));
  const result = evaluateLiveH12Scan(series, {
    now: 181 * 4 * 60 * 60 * 1000 + 1,
    marketBySymbol: marketBySymbol(),
    policy: { ...H12_PRODUCTION_POLICY, forecastStandardErrorBps: 1 }
  });
  const btc = result.diagnostics.symbols.BTCUSDT;
  assert.equal(result.signals.length, 0);
  assert.equal(result.diagnostics.gmailAdvisories ?? 0, 0);
  assert.equal(btc.edgeSource, 'UNVERIFIED');
  assert.equal(btc.candidate.expectedPriceEdgeBps, null);
  assert.equal(btc.candidate.edgeModelId, null);
  assert.ok(btc.reasons.includes('EDGE_UNVERIFIED'));
  assert.ok(btc.reasons.includes('unverified_price_edge'));
});

test('HY-EXP-0024 design keeps candidate families separate and requires candidate-level edge', () => {
  assert.deepEqual(design.candidateEngine, ['Candidate', 'Edge Model', 'Net Edge Gate', 'Portfolio Risk Gate', 'Advisory']);
  assert.equal(design.edgeModel.training, 'separate ridge regression for each candidate family x regime x side; intercept included; lambda=1.0 frozen; no pooled BUY/BULL mean');
  assert.deepEqual(Object.keys(design.entry.families).sort(), ['PULLBACK_CONTINUATION', 'TREND_BREAKOUT', 'VOLATILITY_EXPANSION']);
  assert.equal(design.exits.maxHold, 'none in primary model; research expiry is not a holding-period exit');
  assert.equal(design.riskAndDelivery.orderApi, false);
  assert.equal(design.riskAndDelivery.accountApi, false);
});
