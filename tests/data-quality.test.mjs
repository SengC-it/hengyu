import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPnlEligible, evaluateCaptureDataQuality, evaluateSignalDataQuality } from '../src/model/data-quality.mjs';

function manifest(status = 'complete', errors = []) {
  return {
    status,
    errors,
    run_id: 'run-1',
    symbols: ['BTCUSDT'],
    endpoints: [
      { endpoint: 'public', messages: 2, streams: ['btcusdt@bookTicker', 'btcusdt@depth@100ms'] },
      { endpoint: 'market', messages: 3, streams: ['btcusdt@aggTrade', 'btcusdt@forceOrder', 'btcusdt@markPrice@1s'] },
      { endpoint: 'funding', messages: 1, streams: ['btcusdt@fundingRate', 'btcusdt@openInterest'] }
    ],
    coverage: { BTCUSDT: { messages: 6 } }
  };
}

test('complete validated capture is PnL eligible only with required streams', () => {
  const quality = evaluateCaptureDataQuality({ manifest: manifest(), validation: { status: 'valid' }, requiredSymbols: ['BTCUSDT'] });
  assert.equal(quality.status, 'READY');
  assert.equal(quality.pnlEligible, true);
  assert.equal(assertPnlEligible(quality), true);
});

test('failed manifest and invalid validation are hard PnL gates', () => {
  const quality = evaluateCaptureDataQuality({ manifest: manifest('failed', ['WebSocket error']), validation: { status: 'not_ready' } });
  assert.equal(quality.pnlEligible, false);
  assert.ok(quality.reasons.includes('failed_manifest'));
  assert.ok(quality.reasons.includes('invalid_validation'));
  assert.throws(() => assertPnlEligible(quality), /not PnL eligible/);
});

test('declared streams without actual records are not PnL eligible', () => {
  const empty = manifest();
  empty.endpoints = empty.endpoints.map(endpoint => ({ ...endpoint, messages: 0 }));
  empty.coverage = { BTCUSDT: { messages: 0 } };
  const quality = evaluateCaptureDataQuality({ manifest: empty, validation: { status: 'valid' }, requiredSymbols: ['BTCUSDT'] });
  assert.equal(quality.pnlEligible, false);
  assert.ok(quality.reasons.includes('no_records:public'));
  assert.ok(quality.reasons.includes('no_symbol_records:BTCUSDT'));
});

test('signal freshness rejects future and stale timestamps', () => {
  const quality = evaluateSignalDataQuality({ now: 10_000, forecastTime: 9_900, bookTime: 9_950, receivedAt: 9_999 });
  assert.equal(quality.status, 'READY');
  const stale = evaluateSignalDataQuality({ now: 10_000, forecastTime: 1_000, bookTime: 9_950, receivedAt: 9_999 });
  assert.ok(stale.reasons.includes('stale_forecast'));
  const future = evaluateSignalDataQuality({ now: 10_000, forecastTime: 10_001, bookTime: 9_950, receivedAt: 9_999 });
  assert.ok(future.reasons.includes('future_timestamp'));
});
