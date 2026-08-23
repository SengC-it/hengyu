import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  HY_SCREEN_0001_FAMILIES,
  HY_SCREEN_0001_OOF_END,
  HY_SCREEN_0001_OOF_START,
  HY_SCREEN_0001_SYMBOLS,
  evaluateFamilyAt,
  labelScreenCandidate
} from '../src/research/hy-screen-0001.mjs';

const HOUR = 60 * 60 * 1_000;
const FIVE_MINUTES = 5 * 60 * 1_000;

function makeBar(index, { open = 100, high = 101, low = 99, close = 100 } = {}) {
  const openTime = index * HOUR;
  return {
    symbol: 'TESTUSDT',
    openTime,
    closeTime: openTime + HOUR - 1,
    closeBoundary: openTime + HOUR,
    open,
    high,
    low,
    close,
    final: true,
    closed: true
  };
}

function barsBySymbol(length, updater = () => ({})) {
  return Object.fromEntries(HY_SCREEN_0001_SYMBOLS.map(symbol => [
    symbol,
    Array.from({ length }, (_, index) => makeBar(index, updater(symbol, index)))
  ]));
}

test('HY-SCREEN-0001 is fixed to the five families, OOF window and paper-only boundary', () => {
  assert.deepEqual(HY_SCREEN_0001_FAMILIES, [
    'CROSS_SECTIONAL_MOMENTUM',
    'SHORT_TERM_MEAN_REVERSION',
    'FUNDING_DISLOCATION',
    'TREND_ACCELERATION',
    'VOLATILITY_REVERSAL'
  ]);
  assert.equal(HY_SCREEN_0001_SYMBOLS.length, 8);
  assert.equal(HY_SCREEN_0001_OOF_START, Date.parse('2025-01-01T00:00:00.000Z'));
  assert.equal(HY_SCREEN_0001_OOF_END, Date.parse('2026-07-01T00:00:00.000Z'));
});

test('cross-sectional momentum selects exactly positive top-two BUY and negative bottom-two SELL', () => {
  const values = {
    BTCUSDT: 130,
    ETHUSDT: 120,
    BNBUSDT: 110,
    SOLUSDT: 105,
    XRPUSDT: 95,
    DOGEUSDT: 90,
    LINKUSDT: 80,
    LTCUSDT: 70
  };
  const input = barsBySymbol(31, (symbol, index) => index === 29 ? { close: values[symbol] } : index === 5 ? { close: 100 } : {});
  const rows = evaluateFamilyAt({ family: 'CROSS_SECTIONAL_MOMENTUM', barsBySymbol: input, fundingBySymbol: {}, index: 30, decisionTime: 30 * HOUR });
  assert.deepEqual(rows.map(row => `${row.side}:${row.symbol}`), ['BUY:BTCUSDT', 'BUY:ETHUSDT', 'SELL:LTCUSDT', 'SELL:LINKUSDT']);
});

test('short-term mean reversion uses prior three bars and current candle confirmation', () => {
  const input = barsBySymbol(25, (symbol, index) => {
    if (symbol === 'BTCUSDT' && index === 20) return { close: 110 };
    if (symbol === 'BTCUSDT' && index === 23) return { close: 100 };
    if (symbol === 'BTCUSDT' && index === 24) return { open: 100, close: 101, high: 102, low: 99 };
    return {};
  });
  const rows = evaluateFamilyAt({ family: 'SHORT_TERM_MEAN_REVERSION', barsBySymbol: input, fundingBySymbol: {}, index: 24, decisionTime: 24 * HOUR });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'BTCUSDT');
  assert.equal(rows[0].side, 'BUY');
});

test('funding dislocation uses only latest causal funding and candle direction', () => {
  const input = barsBySymbol(1, (symbol) => symbol === 'BTCUSDT'
    ? { open: 100, close: 101 }
    : symbol === 'ETHUSDT' ? { open: 101, close: 100 } : {});
  const funding = Object.fromEntries(HY_SCREEN_0001_SYMBOLS.map(symbol => [symbol, []]));
  funding.BTCUSDT = [{ eventTime: 0, fundingRate: -0.001 }];
  funding.ETHUSDT = [{ eventTime: 0, fundingRate: 0.001 }];
  const rows = evaluateFamilyAt({ family: 'FUNDING_DISLOCATION', barsBySymbol: input, fundingBySymbol: funding, index: 0, decisionTime: HOUR });
  assert.deepEqual(rows.map(row => `${row.side}:${row.symbol}`), ['BUY:BTCUSDT', 'SELL:ETHUSDT']);
});

test('trend acceleration requires SMA direction and a current-bar-excluded twelve-hour breakout', () => {
  const input = barsBySymbol(61, (symbol, index) => {
    if (symbol === 'BTCUSDT' && index === 60) return { open: 110, high: 121, low: 109, close: 120 };
    if (symbol === 'ETHUSDT' && index === 60) return { open: 90, high: 91, low: 79, close: 80 };
    return {};
  });
  const rows = evaluateFamilyAt({ family: 'TREND_ACCELERATION', barsBySymbol: input, fundingBySymbol: {}, index: 60, decisionTime: 60 * HOUR });
  assert.deepEqual(rows.map(row => `${row.side}:${row.symbol}`), ['BUY:BTCUSDT', 'SELL:ETHUSDT']);
});

test('volatility reversal uses previous-bar shock and current midpoint cross', () => {
  const input = barsBySymbol(23, (symbol, index) => {
    if (index === 21 && symbol === 'BTCUSDT') return { open: 82, high: 100, low: 80, close: 82 };
    if (index === 22 && symbol === 'BTCUSDT') return { open: 90, high: 96, low: 89, close: 95 };
    if (index === 21 && symbol === 'ETHUSDT') return { open: 118, high: 120, low: 100, close: 118 };
    if (index === 22 && symbol === 'ETHUSDT') return { open: 100, high: 101, low: 94, close: 95 };
    return {};
  });
  input.BTCUSDT[20].close = 100;
  input.ETHUSDT[20].close = 100;
  const rows = evaluateFamilyAt({ family: 'VOLATILITY_REVERSAL', barsBySymbol: input, fundingBySymbol: {}, index: 22, decisionTime: 22 * HOUR });
  assert.deepEqual(rows.map(row => `${row.side}:${row.symbol}`), ['BUY:BTCUSDT', 'SELL:ETHUSDT']);
});

test('common outcome requires exact +5m OPEN and cannot rescue with a later bar', () => {
  const bars1h = Array.from({ length: 7 }, (_, index) => makeBar(index, { open: 100, high: 102, low: 98, close: 101 }));
  const candidate = { family: 'TEST', symbol: 'BTCUSDT', side: 'BUY', index: 0, decisionTime: HOUR };
  const exactTime = HOUR + FIVE_MINUTES;
  const exact = new Map([[exactTime, { openTime: exactTime, open: 100, close: 100 }]]);
  const usable = labelScreenCandidate({ candidate, bars1h, bars5m: [...exact.values()], fundingRows: [], fiveByOpenTime: exact });
  assert.equal(usable.usable, true);
  assert.equal(usable.exitReason, 'SIXTH_COMPLETED_1H_CLOSE');
  assert.equal(usable.laterBarRescue, false);
  const missing = new Map([[exactTime + FIVE_MINUTES, { openTime: exactTime + FIVE_MINUTES, open: 100 }]]);
  const rejected = labelScreenCandidate({ candidate, bars1h, bars5m: [...missing.values()], fundingRows: [], fiveByOpenTime: missing });
  assert.deepEqual(rejected, { usable: false, rejection: 'MISSING_EXACT_5M_OPEN' });
});

test('locked screen evidence contains all five families and leaves registry and production untouched', () => {
  const result = JSON.parse(fs.readFileSync('artifacts/HY-SCREEN-0001/screen-result.json', 'utf8'));
  const diagnostics = fs.readFileSync('artifacts/HY-SCREEN-0001/screen-diagnostics.jsonl', 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const ledger = fs.readFileSync('registry/ledger.jsonl', 'utf8').trim().split(/\r?\n/);
  assert.equal(result.recommendation, 'NO_FAMILY_QUALIFIED');
  assert.deepEqual(Object.keys(result.families), HY_SCREEN_0001_FAMILIES);
  for (const family of HY_SCREEN_0001_FAMILIES) {
    assert.equal(typeof result.families[family].rawCandidateCount, 'number');
    assert.equal(typeof result.families[family].oofAdvisoryCount, 'number');
    assert.equal(result.families[family].qualified, false);
  }
  assert.equal(result.safety.signalOnly, true);
  assert.equal(result.safety.paperOnly, true);
  assert.equal(result.safety.liveOrdersEnabled, false);
  assert.equal(result.safety.accountApi, false);
  assert.equal(result.safety.orderApi, false);
  assert.equal(result.safety.finalOosRead, false);
  assert.equal(result.safety.holdout0028Read, false);
  assert.equal(result.safety.newExperimentCreated, false);
  assert.equal(ledger.length, 93);
  assert.equal(diagnostics[0].type, 'screen_metadata');
  assert.equal(diagnostics.filter(row => row.type === 'family_summary').length, 5);
});
