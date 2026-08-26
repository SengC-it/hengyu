import {
  HY_DATA_0036_ENDPOINTS,
  HY_DATA_0036_ID,
  HY_DATA_0036_SYMBOLS
} from './hy-data-0036-contract.mjs';

const deepFreeze = value => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

export const HY_DATA_0036_SUP_001_ID = 'HY-DATA-0036-SUP-001';

export const HY_DATA_0036_SUP_001_STREAMS = deepFreeze([
  {
    id: 'markPrice',
    subscription: '<symbol>@markPrice@1s',
    endpoint: HY_DATA_0036_ENDPOINTS.marketWebSocket,
    required: true,
    fields: [
      'eventTime',
      'symbol',
      'markPrice',
      'indexPrice',
      'estimatedSettlePrice',
      'fundingRate',
      'markPriceMovingAverage',
      'nextFundingTime',
      'st',
      'rawPayload'
    ]
  },
  {
    id: 'forceOrder',
    subscription: '<symbol>@forceOrder',
    endpoint: HY_DATA_0036_ENDPOINTS.marketWebSocket,
    required: true,
    fields: [
      'eventTime',
      'symbol',
      'side',
      'orderType',
      'timeInForce',
      'originalQty',
      'price',
      'averagePrice',
      'status',
      'lastFilledQty',
      'accumulatedFilledQty',
      'tradeTime',
      'st',
      'rawPayload'
    ]
  }
]);

export const HY_DATA_0036_SUP_001_CONTRACT = deepFreeze({
  schemaVersion: 1,
  contractId: HY_DATA_0036_SUP_001_ID,
  parentDatasetId: HY_DATA_0036_ID,
  status: 'FROZEN_BEFORE_COLLECTION',
  symbols: HY_DATA_0036_SYMBOLS,
  collectionStartAtPolicy: 'same-as-parent-future-activation-boundary',
  streams: HY_DATA_0036_SUP_001_STREAMS,
  forceOrderSemantics: 'Binance 1-second liquidation snapshot; not a complete tick-by-tick liquidation stream.',
  privateStreamsAllowed: false,
  safety: {
    publicMarketDataOnly: true,
    apiKeyRequired: false,
    privateStream: false,
    accountApi: false,
    orderApi: false,
    paperOnly: true,
    signalOnly: true,
    gmail: false,
    scheduler: false,
    realEmail: false,
    autoTrading: false,
    finalOosRead: false,
    pnlComputed: false
  }
});

export function getHyData0036Sup001Subscription(streamId, symbol) {
  const stream = HY_DATA_0036_SUP_001_STREAMS.find(candidate => candidate.id === streamId);
  if (!stream) throw new Error(`unknown SUP-001 stream: ${streamId}`);
  return stream.subscription.replace('<symbol>', String(symbol).toLowerCase());
}
