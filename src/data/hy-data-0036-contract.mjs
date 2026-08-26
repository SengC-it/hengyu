const deepFreeze = value => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

export const HY_DATA_0036_ID = 'HY-DATA-0036';

export const HY_DATA_0036_SYMBOLS = Object.freeze([
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'LINKUSDT',
  'LTCUSDT'
]);

export const HY_DATA_0036_ENDPOINTS = deepFreeze({
  publicWebSocket: 'wss://fstream.binance.com/public/stream',
  marketWebSocket: 'wss://fstream.binance.com/market/stream',
  depthSnapshot: 'https://fapi.binance.com/fapi/v1/depth'
});

export const HY_DATA_0036_STREAMS = deepFreeze([
  {
    id: 'aggTrade',
    subscription: '<symbol>@aggTrade',
    endpoint: HY_DATA_0036_ENDPOINTS.marketWebSocket,
    required: true
  },
  {
    id: 'bookTicker',
    subscription: '<symbol>@bookTicker',
    endpoint: HY_DATA_0036_ENDPOINTS.publicWebSocket,
    required: true
  },
  {
    id: 'depth20',
    subscription: '<symbol>@depth20@100ms',
    endpoint: HY_DATA_0036_ENDPOINTS.publicWebSocket,
    required: true
  },
  {
    id: 'depth.diff',
    subscription: '<symbol>@depth@100ms',
    endpoint: HY_DATA_0036_ENDPOINTS.publicWebSocket,
    required: true
  },
  {
    id: 'depth.snapshot',
    subscription: null,
    endpoint: HY_DATA_0036_ENDPOINTS.depthSnapshot,
    required: true
  }
]);

export const HY_DATA_0036_RAW_FIELDS = Object.freeze([
  'source',
  'stream',
  'symbol',
  'exchangeEventTime',
  'tradeTime',
  'localReceiveTime',
  'sequence',
  'rawPayload',
  'schemaVersion'
]);

export const HY_DATA_0036_FEATURE_FIELDS = Object.freeze([
  'midPrice',
  'spreadBps',
  'bidQtyTop1',
  'askQtyTop1',
  'bookImbalanceTop1',
  'bidQtyTop5',
  'askQtyTop5',
  'bookImbalanceTop5',
  'bidQtyTop20',
  'askQtyTop20',
  'bookImbalanceTop20',
  'depthWithin5Bps',
  'depthWithin10Bps',
  'depthWithin25Bps',
  'microPrice',
  'aggressiveBuyNotional',
  'aggressiveSellNotional',
  'tradeImbalance',
  'tradeCount',
  'largeTradeBuyNotional',
  'largeTradeSellNotional',
  'signedVolume',
  'cumulativeVolumeDelta',
  'orderFlowImbalance',
  'midReturn1s',
  'midReturn5s',
  'midReturn30s',
  'realizedVol30s',
  'spreadChange',
  'depthChange'
]);

export const HY_DATA_0036_INTERVALS = Object.freeze(['1s', '5s', '1m']);

export const HY_DATA_0036_DEPTH_FEATURE_FIELDS = Object.freeze([
  'midPrice',
  'spreadBps',
  'bidQtyTop1',
  'askQtyTop1',
  'bookImbalanceTop1',
  'bidQtyTop5',
  'askQtyTop5',
  'bookImbalanceTop5',
  'bidQtyTop20',
  'askQtyTop20',
  'bookImbalanceTop20',
  'depthWithin5Bps',
  'depthWithin10Bps',
  'depthWithin25Bps',
  'microPrice',
  'depthChange'
]);

export const HY_DATA_0036_RESERVED_FAMILIES = Object.freeze([
  'ORDER_FLOW_IMBALANCE',
  'LIQUIDITY_VACUUM',
  'AGGRESSIVE_FLOW_EXHAUSTION',
  'MICROPRICE_PRESSURE',
  'CROSS_SYMBOL_FLOW_PROPAGATION'
]);

export const HY_DATA_0036_QUALITY_TARGETS = deepFreeze({
  uptime: 0.99,
  bookValidCoverage: 0.98,
  aggTradeCoverage: 0.99,
  bookTickerCoverage: 0.99
});

export const HY_DATA_0036_SAFETY = deepFreeze({
  publicMarketDataOnly: true,
  apiKeyRequired: false,
  accountApi: false,
  orderApi: false,
  privateStream: false,
  paperOnly: true,
  signalOnly: true,
  gmail: false,
  scheduler: false,
  realEmail: false,
  autoTrading: false,
  finalOosRead: false,
  pnlComputed: false
});

export const HY_DATA_0036_CONTRACT = deepFreeze({
  datasetId: HY_DATA_0036_ID,
  schemaVersion: 1,
  symbols: HY_DATA_0036_SYMBOLS,
  endpoints: HY_DATA_0036_ENDPOINTS,
  streams: HY_DATA_0036_STREAMS,
  rawFields: HY_DATA_0036_RAW_FIELDS,
  featureIntervals: HY_DATA_0036_INTERVALS,
  featureFields: HY_DATA_0036_FEATURE_FIELDS,
  depthFeatureFields: HY_DATA_0036_DEPTH_FEATURE_FIELDS,
  reservedFeatureFamilies: HY_DATA_0036_RESERVED_FAMILIES,
  qualityTargets: HY_DATA_0036_QUALITY_TARGETS,
  collectionStartAtPolicy: 'persist-before-first-connection',
  engineeringDryRunEligible: false,
  safety: HY_DATA_0036_SAFETY
});
