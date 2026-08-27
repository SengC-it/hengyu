import { HY_DATA_0036_SYMBOLS } from './hy-data-0036-contract.mjs';

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const THIRTY_SECONDS_MS = 30_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const HY_DATA_0036_FEATURE_INTERVALS = Object.freeze([
  Object.freeze({ id: '1s', milliseconds: SECOND_MS }),
  Object.freeze({ id: '5s', milliseconds: 5 * SECOND_MS }),
  Object.freeze({ id: '1m', milliseconds: MINUTE_MS })
]);

export const HY_DATA_0036_RUNTIME_FEATURE_FIELDS = Object.freeze([
  'midPrice',
  'spreadBps',
  'bidQtyTop1',
  'askQtyTop1',
  'bidQtyTop5',
  'askQtyTop5',
  'bidQtyTop20',
  'askQtyTop20',
  'bookImbalanceTop1',
  'bookImbalanceTop5',
  'bookImbalanceTop20',
  'depthWithin5Bps',
  'depthWithin10Bps',
  'depthWithin25Bps',
  'microPrice',
  'totalAggressiveBuyNotional',
  'totalAggressiveSellNotional',
  'totalSignedVolume',
  'visibleAggressiveBuyNotional',
  'visibleAggressiveSellNotional',
  'visibleSignedVolume',
  'visibleTradeImbalance',
  'visibleOrderFlowImbalance',
  'tradeCount',
  'largeTradeBuyNotional',
  'largeTradeSellNotional',
  'CVD',
  'cumulativeVolumeDelta',
  'midReturn1s',
  'midReturn5s',
  'midReturn30s',
  'realizedVol30s',
  'spreadChange',
  'depthChange',
  'bookStateValid',
  'clockStatus',
  'featureCoverage'
]);

function fail(message) {
  throw new Error(message);
}

function finite(name, value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) fail(`invalid ${name}`);
  return parsed;
}

function optionalFinite(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedSymbol(value) {
  const result = String(value ?? '').toUpperCase();
  if (!HY_DATA_0036_SYMBOLS.includes(result)) fail(`symbol outside frozen universe: ${result}`);
  return result;
}

function cloneLevels(levels = []) {
  return levels.map(level => [finite('book price', level[0]), finite('book quantity', level[1])]);
}

function latestAt(history, at) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].localReceiveTime <= at) return history[index];
  }
  return null;
}

function sumTop(levels, count) {
  return levels.slice(0, count).reduce((sum, [, quantity]) => sum + quantity, 0);
}

function imbalance(bidQuantity, askQuantity) {
  const denominator = bidQuantity + askQuantity;
  return denominator === 0 ? 0 : (bidQuantity - askQuantity) / denominator;
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * percentileValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function ratio(numerator, denominator) {
  if (numerator == null || denominator == null || denominator === 0) return null;
  return numerator / denominator;
}

function standardDeviation(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function copyBook(book) {
  if (!book) return null;
  return Object.freeze({
    bids: Object.freeze(cloneLevels(book.bids ?? []).sort((left, right) => right[0] - left[0])),
    asks: Object.freeze(cloneLevels(book.asks ?? []).sort((left, right) => left[0] - right[0]))
  });
}

/**
 * Deterministic feature materialization. The event log is deliberately
 * ordered by local receipt, while each sealed snapshot only considers events
 * whose local receipt is <= snapshotAt. A late event is retained for audit
 * and can never rewrite a snapshot that has already been sealed.
 */
export function createCausalFeatureBuilder({ symbol: inputSymbol, clockStatus = 'CLOCK_UNTRUSTED' } = {}) {
  const symbol = normalizedSymbol(inputSymbol);
  const events = [];
  const books = [];
  const snapshots = new Map(HY_DATA_0036_FEATURE_INTERVALS.map(interval => [interval.id, []]));
  const lastSnapshotAt = new Map(HY_DATA_0036_FEATURE_INTERVALS.map(interval => [interval.id, null]));
  let totalEvents = 0;
  let lateEventCount = 0;
  let currentClockStatus = String(clockStatus);

  function setClockStatus(value) {
    currentClockStatus = String(value ?? 'CLOCK_UNTRUSTED');
  }

  function ingest(stream, data, localReceiveTime) {
    const at = finite('localReceiveTime', localReceiveTime);
    if (lastSnapshotAt.size && [...lastSnapshotAt.values()].some(value => value !== null && at < value)) lateEventCount += 1;
    const event = Object.freeze({ stream: String(stream), data, localReceiveTime: at });
    events.push(event);
    totalEvents += 1;
    return event;
  }

  function setDepthBook(book, localReceiveTime, valid = true) {
    const at = finite('book localReceiveTime', localReceiveTime);
    const record = Object.freeze({
      localReceiveTime: at,
      valid: Boolean(valid),
      book: copyBook(book)
    });
    books.push(record);
    return record;
  }

  function rowsBefore(intervalId, at) {
    return snapshots.get(intervalId).filter(row => row.snapshotAt <= at);
  }

  function currentBook(at) {
    return latestAt(books, at);
  }

  function eventWindow(start, at) {
    return events.filter(event => event.localReceiveTime > start && event.localReceiveTime <= at);
  }

  function allEventsAt(at) {
    return events.filter(event => event.localReceiveTime <= at);
  }

  function bookMetrics(at) {
    const bookState = currentBook(at);
    const book = bookState?.book;
    const validBook = Boolean(bookState?.valid && book?.bids?.length && book?.asks?.length);
    if (!validBook) {
      return {
        midPrice: null,
        spreadBps: null,
        bidQtyTop1: null,
        askQtyTop1: null,
        bidQtyTop5: null,
        askQtyTop5: null,
        bidQtyTop20: null,
        askQtyTop20: null,
        bookImbalanceTop1: null,
        bookImbalanceTop5: null,
        bookImbalanceTop20: null,
        depthWithin5Bps: null,
        depthWithin10Bps: null,
        depthWithin25Bps: null,
        microPrice: null,
        bookStateValid: false,
        depthTotalTop20: null
      };
    }
    const bid = book.bids[0][0];
    const ask = book.asks[0][0];
    const bidQty = book.bids[0][1];
    const askQty = book.asks[0][1];
    const midPrice = bid != null && ask != null ? (bid + ask) / 2 : null;
    const spreadBps = midPrice && bid != null && ask != null ? ((ask - bid) / midPrice) * 10_000 : null;
    const top = count => validBook ? {
      bid: sumTop(book.bids, count),
      ask: sumTop(book.asks, count)
    } : { bid: null, ask: null };
    const top1 = top(1);
    const top5 = top(5);
    const top20 = top(20);
    const depthWithin = bps => {
      if (!validBook || midPrice == null) return null;
      const distance = midPrice * bps / 10_000;
      return book.bids.filter(([price]) => price >= midPrice - distance).reduce((sum, [, quantity]) => sum + quantity, 0)
        + book.asks.filter(([price]) => price <= midPrice + distance).reduce((sum, [, quantity]) => sum + quantity, 0);
    };
    const microDenominator = bidQty != null && askQty != null ? bidQty + askQty : 0;
    return {
      midPrice,
      spreadBps,
      bidQtyTop1: top1.bid,
      askQtyTop1: top1.ask,
      bidQtyTop5: top5.bid,
      askQtyTop5: top5.ask,
      bidQtyTop20: top20.bid,
      askQtyTop20: top20.ask,
      bookImbalanceTop1: top1.bid == null ? null : imbalance(top1.bid, top1.ask),
      bookImbalanceTop5: top5.bid == null ? null : imbalance(top5.bid, top5.ask),
      bookImbalanceTop20: top20.bid == null ? null : imbalance(top20.bid, top20.ask),
      depthWithin5Bps: depthWithin(5),
      depthWithin10Bps: depthWithin(10),
      depthWithin25Bps: depthWithin(25),
      microPrice: bid != null && ask != null && microDenominator > 0 ? ((ask * bidQty) + (bid * askQty)) / microDenominator : null,
      bookStateValid: validBook,
      depthTotalTop20: top20.bid == null ? null : top20.bid + top20.ask
    };
  }

  function flowMetrics(start, at) {
    const window = eventWindow(start, at);
    const trades = window.filter(event => event.stream === 'aggTrade').map(event => event.data);
    const totalBuy = trades.filter(trade => trade.aggressorSide === 'BUY').reduce((sum, trade) => sum + trade.totalAggressorNotional, 0);
    const totalSell = trades.filter(trade => trade.aggressorSide === 'SELL').reduce((sum, trade) => sum + trade.totalAggressorNotional, 0);
    const totalSignedVolume = totalBuy - totalSell;
    const visibleComplete = trades.length > 0 && trades.every(trade => trade.normalQuantity !== null && trade.normalQuantity !== undefined);
    const visibleBuy = visibleComplete ? trades.filter(trade => trade.aggressorSide === 'BUY').reduce((sum, trade) => sum + trade.visibleBookComparableAggressorNotional, 0) : null;
    const visibleSell = visibleComplete ? trades.filter(trade => trade.aggressorSide === 'SELL').reduce((sum, trade) => sum + trade.visibleBookComparableAggressorNotional, 0) : null;
    const visibleSigned = visibleBuy == null ? null : visibleBuy - visibleSell;
    const visibleImbalance = visibleBuy == null ? null : ratio(visibleSigned, visibleBuy + visibleSell);
    const priorTrades = allEventsAt(at).filter(event => event.stream === 'aggTrade' && event.localReceiveTime > at - DAY_MS).map(event => event.data);
    const earliest = events.find(event => event.stream === 'aggTrade')?.localReceiveTime ?? null;
    const thresholdReady = earliest !== null && at - earliest >= DAY_MS && priorTrades.length > 0;
    const threshold = thresholdReady ? percentile(priorTrades.map(trade => trade.totalAggressorNotional), 0.95) : null;
    const largeTrades = threshold == null ? [] : trades.filter(trade => trade.totalAggressorNotional >= threshold);
    const cumulative = allEventsAt(at).filter(event => event.stream === 'aggTrade').reduce((sum, event) => sum + event.data.signedVolume, 0);
    return {
      totalAggressiveBuyNotional: totalBuy,
      totalAggressiveSellNotional: totalSell,
      totalSignedVolume,
      visibleAggressiveBuyNotional: visibleBuy,
      visibleAggressiveSellNotional: visibleSell,
      visibleSignedVolume: visibleSigned,
      visibleTradeImbalance: visibleImbalance,
      visibleOrderFlowImbalance: visibleImbalance,
      tradeCount: trades.length,
      largeTradeBuyNotional: threshold == null ? null : largeTrades.filter(trade => trade.aggressorSide === 'BUY').reduce((sum, trade) => sum + trade.totalAggressorNotional, 0),
      largeTradeSellNotional: threshold == null ? null : largeTrades.filter(trade => trade.aggressorSide === 'SELL').reduce((sum, trade) => sum + trade.totalAggressorNotional, 0),
      CVD: cumulative,
      cumulativeVolumeDelta: cumulative
    };
  }

  function priorRow(intervalId, at) {
    return snapshots.get(intervalId).find(row => row.snapshotAt === at) ?? null;
  }

  function midReturn(intervalId, currentMid, at, offset) {
    const previous = snapshots.get(intervalId).find(row => row.snapshotAt === at - offset) ?? null;
    if (!currentMid || !previous?.midPrice) return null;
    return currentMid / previous.midPrice - 1;
  }

  function buildSnapshot(interval, snapshotAt) {
    const start = snapshotAt - interval.milliseconds;
    const metrics = bookMetrics(snapshotAt);
    const flow = flowMetrics(start, snapshotAt);
    const previous = priorRow(interval.id, snapshotAt - interval.milliseconds);
    const return1s = interval.id === '1s' ? midReturn(interval.id, metrics.midPrice, snapshotAt, SECOND_MS) : null;
    const return5s = interval.id === '5s' ? midReturn(interval.id, metrics.midPrice, snapshotAt, 5 * SECOND_MS) : null;
    const return30s = midReturn(interval.id, metrics.midPrice, snapshotAt, THIRTY_SECONDS_MS);
    const oneSecondRows = rowsBefore('1s', snapshotAt).filter(row => row.snapshotAt > snapshotAt - THIRTY_SECONDS_MS);
    const realizedVol30s = standardDeviation(oneSecondRows.map(row => row.midReturn1s).filter(value => value != null));
    const coverageEvents = allEventsAt(snapshotAt).filter(event => event.localReceiveTime > start);
    const coverageBooks = books.filter(book => book.localReceiveTime > start && book.localReceiveTime <= snapshotAt);
    if (!coverageEvents.length && !coverageBooks.length) return null;
    return Object.freeze({
      schemaVersion: 1,
      datasetId: 'HY-DATA-0036',
      symbol,
      interval: interval.id,
      snapshotAt,
      ...metrics,
      ...flow,
      midReturn1s: return1s,
      midReturn5s: return5s,
      midReturn30s: return30s,
      realizedVol30s,
      spreadChange: previous?.spreadBps != null && metrics.spreadBps != null ? metrics.spreadBps - previous.spreadBps : null,
      depthChange: previous?.depthTotalTop20 != null && metrics.depthTotalTop20 != null ? metrics.depthTotalTop20 - previous.depthTotalTop20 : null,
      clockStatus: currentClockStatus,
      featureCoverage: Object.freeze({
        interval: interval.id,
        eventCount: coverageEvents.length,
        tradeEventCount: coverageEvents.filter(event => event.stream === 'aggTrade').length,
        depthEventCount: coverageEvents.filter(event => event.stream === 'depth.diff').length,
        bookStateValid: metrics.bookStateValid,
        sourceTimeRule: 'localReceiveTime<=snapshotAt'
      })
    });
  }

  function materializeAt(inputAt) {
    const input = finite('snapshotAt', inputAt);
    if (!Number.isSafeInteger(input)) fail('snapshotAt must be an integer');
    const created = [];
    for (const interval of HY_DATA_0036_FEATURE_INTERVALS) {
      const snapshotAt = Math.floor(input / interval.milliseconds) * interval.milliseconds;
      const last = lastSnapshotAt.get(interval.id);
      let next = last === null ? snapshotAt : last + interval.milliseconds;
      while (next <= snapshotAt) {
        const row = buildSnapshot(interval, next);
        if (!row) {
          next += interval.milliseconds;
          continue;
        }
        snapshots.get(interval.id).push(row);
        lastSnapshotAt.set(interval.id, next);
        created.push(row);
        next += interval.milliseconds;
      }
    }
    return Object.freeze(created);
  }

  function getSnapshots(intervalId = null) {
    if (intervalId === null) return Object.freeze(Object.fromEntries([...snapshots].map(([key, rows]) => [key, Object.freeze(rows.slice())])));
    if (!snapshots.has(intervalId)) fail(`unknown feature interval: ${intervalId}`);
    return Object.freeze(snapshots.get(intervalId).slice());
  }

  return Object.freeze({
    symbol,
    ingest,
    setDepthBook,
    setClockStatus,
    materializeAt,
    getSnapshots,
    diagnostics: () => Object.freeze({
      symbol,
      totalEvents,
      lateEventCount,
      lateEventRate: totalEvents ? lateEventCount / totalEvents : 0,
      snapshotCounts: Object.freeze(Object.fromEntries([...snapshots].map(([key, rows]) => [key, rows.length]))),
      firstSnapshot: Object.freeze(Object.fromEntries([...snapshots].map(([key, rows]) => [key, rows[0]?.snapshotAt ?? null]))),
      lastSnapshot: Object.freeze(Object.fromEntries([...snapshots].map(([key, rows]) => [key, rows.at(-1)?.snapshotAt ?? null])))
    })
  });
}
