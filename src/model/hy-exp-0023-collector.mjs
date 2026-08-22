import {
  buildCollectorEngineeringReadiness,
  runCollectorEngineeringDryRun
} from './hy-exp-0022-collector.mjs';
import {
  assertHyExp0023CaptureMode,
  HY_EXP_0023_ACCOUNT_ENDPOINTS,
  HY_EXP_0023_CAPTURE_START,
  HY_EXP_0023_DEVELOPMENT_END_EXCLUSIVE,
  HY_EXP_0023_DIAGNOSTIC_STREAMS,
  HY_EXP_0023_ENGINEERING_ROOT,
  HY_EXP_0023_FINAL_OOS_END_EXCLUSIVE,
  HY_EXP_0023_FINAL_OOS_START,
  HY_EXP_0023_ID,
  HY_EXP_0023_ORDER_ENDPOINTS,
  HY_EXP_0023_REQUIRED_CAPTURE_STREAMS,
  HY_EXP_0023_TRANSPORT_ENDPOINTS,
  HY_EXP_0023_WINDOWS
} from './hy-exp-0023-prospective.mjs';

export const HY_EXP_0023_COLLECTOR_PROFILE = Object.freeze({
  experimentId: HY_EXP_0023_ID,
  engineeringRoot: HY_EXP_0023_ENGINEERING_ROOT,
  captureStart: HY_EXP_0023_CAPTURE_START,
  windows: HY_EXP_0023_WINDOWS,
  transportEndpoints: HY_EXP_0023_TRANSPORT_ENDPOINTS,
  requiredCaptureStreams: HY_EXP_0023_REQUIRED_CAPTURE_STREAMS,
  diagnosticStreams: HY_EXP_0023_DIAGNOSTIC_STREAMS,
  orderEndpoints: HY_EXP_0023_ORDER_ENDPOINTS,
  accountEndpoints: HY_EXP_0023_ACCOUNT_ENDPOINTS,
  finalOosStart: HY_EXP_0023_FINAL_OOS_START,
  finalOosEndExclusive: HY_EXP_0023_FINAL_OOS_END_EXCLUSIVE,
  maxSymbolsPerConnection: 20,
  depthSymbolsPerConnection: 5,
  manifestType: 'HY-EXP-0023-ENGINEERING-DIAGNOSTIC',
  readinessArtifactType: 'HY_EXP_0023_ENGINEERING_READINESS'
});

/** Run only under the isolated engineering root; official capture remains locked. */
export async function runHyExp0023EngineeringDiagnostic({
  projectRoot = process.cwd(),
  maxRuntimeMs = 5 * 60 * 1_000,
  maxSymbols = 20,
  segmentMaxMs,
  confirmationTimeoutMs,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket
} = {}) {
  assertHyExp0023CaptureMode('ENGINEERING_DRY_RUN');
  return runCollectorEngineeringDryRun({
    projectRoot,
    maxRuntimeMs,
    maxSymbols,
    segmentMaxMs,
    confirmationTimeoutMs,
    fetchImpl,
    WebSocketImpl,
    profile: HY_EXP_0023_COLLECTOR_PROFILE
  });
}

export function buildHyExp0023CollectorReadiness({
  result,
  requiredDurationMs = 30 * 60 * 1_000,
  minimumDynamicSymbols = 20,
  operations = {}
} = {}) {
  const base = buildCollectorEngineeringReadiness({
    result,
    requiredDurationMs,
    minimumDynamicSymbols,
    profile: HY_EXP_0023_COLLECTOR_PROFILE
  });
  const checks = {
    ...base.checks,
    collectorProcessHealthy: operations.collectorProcessHealthy === true,
    automaticRestartVerified: operations.automaticRestartVerified === true,
    websocketReconnectVerified: operations.websocketReconnectVerified === true,
    segmentRotationVerified: operations.segmentRotationVerified === true,
    alertsActive: operations.alertsActive === true,
    clockReady: operations.clockReady === true,
    storageReady: operations.storageReady === true
  };
  return {
    ...base,
    status: Object.values(checks).every(Boolean) ? 'PASS' : 'COLLECTOR_NOT_READY',
    checks,
    operations,
    officialCaptureAuthorized: false,
    developmentAllowed: false,
    pnlComputed: false,
    finalOosRead: false,
    paperOnly: true,
    orderApiEnabled: false,
    accountApiEnabled: false,
    errors: [
      ...(base.errors ?? []),
      ...Object.entries(checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => `READINESS_GATE_FAILED:${name}`)
    ]
  };
}
