// Pure frozen evidence constants shared by lightweight and full validators.
// Keep this module free of filesystem, network, database, and mail imports so
// READY requests can validate the release gate without loading heavy runtime code.
export const HY_EXP_0028_STRATEGY_ID = 'HY-EXP-0028';
export const HY_EXP_0028_POLICY_ID = 'EMAIL_SIGNAL_RELEASE-001';
export const HY_EXP_0028_SOURCE_COMMIT = 'a61cb20318af1e0b188c0276a1a3d65e52bc4467';
export const HY_EXP_0028_PREREGISTRATION_SHA256 = '4085fad293275ce055a67516d1c8168331f221a91b688f3b093ff2eef11708a3';
export const HY_EXP_0028_HOLDOUT_RESULT_SHA256 = '92304ec0252be9ee2bba2e13a9ccc64c923f3b067d91e12513be089d56f3d2e5';
export const HY_EXP_0028_FROZEN_Q75 = 10.051547664406323;
export const HY_EXP_0028_BASE_COST_BPS = 18;
export const HY_EXP_0028_STRESS_COST_BPS = 27;
export const HY_EXP_0028_RESEARCH_EQUITY_USDT = 100_000;
export const HY_EXP_0028_ENTRY_OFFSET_MS = 5 * 60 * 1_000;
export const HY_EXP_0028_MAX_HOLD_BARS = 6;
export const HY_EXP_0028_SYMBOLS = Object.freeze([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
  'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'
]);
export const HY_EXP_0028_SOURCE_FILE_HASHES = Object.freeze({
  'scripts/hy-exp-0028-holdout.mjs': 'f5f04b5cde4ce00c235f0e6c0be08904a71ea0fe2335582724a2298b14ab1ab7',
  'src/research/hy-exp-0024.mjs': 'd8120efd3650e828bfa6c6277c70605ccab51396e0ecb9107df38b934cd87174',
  'src/research/hy-exp-0028.mjs': 'a665bc805ea107dcc97df5326b31fc29a9cfba0f01119448e338b2f741d8ce17',
  'artifacts/HY-EXP-0028/frozen-q75.json': '1d85f472c24d45b3ea09ecb28be68269fe89f298464b0a58d9da286445ae3ed3'
});
export const HY_VAL_PUBLIC_ENDPOINTS = Object.freeze([
  'https://fapi.binance.com/fapi/v1/klines',
  'https://fapi.binance.com/fapi/v1/fundingRate',
  'https://fapi.binance.com/fapi/v1/exchangeInfo'
]);
