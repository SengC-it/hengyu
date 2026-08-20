import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function loadJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

export const H12_CONFIG = Object.freeze(loadJson('config/h12-production.json'));
export const NET_EDGE_CONFIG = Object.freeze(loadJson('config/net-edge-model.json'));

export function netEdgeAdvisoryPolicy(overrides = {}) {
  const execution = NET_EDGE_CONFIG.execution ?? {};
  const gate = NET_EDGE_CONFIG.gate ?? {};
  const delivery = NET_EDGE_CONFIG.delivery ?? {};
  return {
    modelId: NET_EDGE_CONFIG.modelId,
    evidenceClass: NET_EDGE_CONFIG.evidenceClass ?? 'F0_PENDING',
    signalValidityMs: NET_EDGE_CONFIG.signalValidityMs ?? 2_000,
    researchExpiryMs: NET_EDGE_CONFIG.researchExpiryMs ?? 15 * 60_000,
    strongMinConservativeNetBps: NET_EDGE_CONFIG.strongMinConservativeNetBps ?? 6,
    strongMinGrossToCostRatio: NET_EDGE_CONFIG.strongMinGrossToCostRatio ?? 2,
    mediumMinConservativeNetBps: NET_EDGE_CONFIG.mediumMinConservativeNetBps ?? 3,
    mediumMinGrossToCostRatio: NET_EDGE_CONFIG.mediumMinGrossToCostRatio ?? 1.5,
    feeRatePerFill: execution.feeRatePerFill,
    bookStressMultiplier: execution.bookStressMultiplier,
    impactBufferBpsPerFill: execution.impactBufferBpsPerFill,
    latencyBufferBpsPerFill: execution.latencyBufferBpsPerFill,
    confidenceZ: gate.confidenceZ,
    minimumConservativeNetBps: gate.minimumConservativeNetBps,
    minimumGrossToCostRatio: gate.minimumGrossToCostRatio,
    maximumForecastAgeMs: gate.maximumForecastAgeMs,
    maximumBookAgeMs: gate.maximumBookAgeMs,
    maximumVisibleBookFraction: gate.maximumVisibleBookFraction,
    delivery,
    ...overrides
  };
}
