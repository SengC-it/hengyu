import {
  HY_DATA_0036_CONTRACT,
  HY_DATA_0036_ENDPOINTS,
  HY_DATA_0036_ID,
  HY_DATA_0036_STREAMS,
  HY_DATA_0036_SYMBOLS
} from './hy-data-0036-contract.mjs';
import { createAppendOnlyRawWriter, validateRawRecord } from './hy-data-0036-validator.mjs';

export function createHyData0036CollectorPlan({ collectionStartAt = null } = {}) {
  if (collectionStartAt !== null && !Number.isSafeInteger(collectionStartAt)) {
    throw new Error('collectionStartAt must be an explicit UTC millisecond boundary or null before activation');
  }
  return Object.freeze({
    datasetId: HY_DATA_0036_ID,
    status: 'PREPARATION_ONLY',
    collectionStartAt,
    activationRequiredBeforeFirstEvent: true,
    endpoints: HY_DATA_0036_ENDPOINTS,
    symbols: HY_DATA_0036_SYMBOLS,
    streams: HY_DATA_0036_STREAMS,
    boundedSymbolBatches: true,
    reconnectCreatesNewSegment: true,
    invalidDepthSegmentRequiresFreshSnapshot: true,
    storage: 'persistent-node-process',
    networkStarted: false,
    publicOnly: true,
    safety: HY_DATA_0036_CONTRACT.safety
  });
}

export function createRawCaptureSink({ collectionStartAt } = {}) {
  if (!Number.isSafeInteger(collectionStartAt)) throw new Error('collectionStartAt is required before capture');
  const sink = createAppendOnlyRawWriter();
  return Object.freeze({
    append(record) {
      validateRawRecord(record, { collectionStartAt });
      return sink.append(record);
    },
    snapshot: sink.snapshot,
    seal: sink.seal,
    get sealed() {
      return sink.sealed;
    }
  });
}

export function main(args = process.argv.slice(2)) {
  if (!args.includes('--plan')) {
    throw new Error('HY-DATA-0036 is preparation-only; activation is required before collection');
  }
  console.log(JSON.stringify(createHyData0036CollectorPlan(), null, 2));
}

if (process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replaceAll('\\', '/'))) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
