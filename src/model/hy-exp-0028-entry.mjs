import { methodAllowed, sendJson } from '../../api/_lib/http.mjs';
import { authorizeInternalScheduler } from '../../api/_lib/internal-scheduler-auth.mjs';
import {
  EMAIL_SIGNAL_CUTOVER_CONFIG,
  isLightweightEmailSignalCutoverConfigValid
} from './email-signal-cutover-config.mjs';

const READY_STATE = 'EMAIL_SIGNAL_RELEASE_READY';
const RELEASED_STATE = 'EMAIL_SIGNAL_RELEASED';

function safeText(value, fallback = null) {
  return typeof value === 'string' && value.length <= 128 ? value : fallback;
}

function safeDiagnostic(error) {
  return {
    name: safeText(error?.name, 'Error'),
    ...(safeText(error?.code) ? { code: safeText(error.code) } : {})
  };
}

function safeFailure(response, stage, error) {
  const diagnostic = safeDiagnostic(error);
  console.error(JSON.stringify({
    event: 'hy_exp_0028_scan_failed',
    stage,
    error: diagnostic
  }));
  return sendJson(response, 503, {
    error: 'hy_exp_0028_scan_failed',
    stage,
    paperOnly: true,
    signalOnly: true
  });
}

function readyNoOp() {
  return {
    ok: true,
    noOp: true,
    reason: 'EMAIL_STRATEGY_NOT_RELEASED',
    marketDataFetched: false,
    candidates: 0,
    advisories: 0,
    outbox: 0,
    smtpDispatched: 0,
    paperOnly: true,
    signalOnly: true
  };
}

export function createHyExp0028Handler({
  authorize = authorizeInternalScheduler,
  loadConfig = () => EMAIL_SIGNAL_CUTOVER_CONFIG,
  validateConfig = isLightweightEmailSignalCutoverConfigValid,
  loadRunner = () => import('./hy-exp-0028-runner.mjs')
} = {}) {
  return async function hyExp0028Handler(request, response) {
    if (request.method !== 'GET') return methodAllowed(response, ['GET']);

    let authorized;
    try {
      authorized = await authorize(request);
    } catch (error) {
      return safeFailure(response, 'AUTH', error);
    }
    if (!authorized) return sendJson(response, 401, { error: 'unauthorized' });

    let config;
    try {
      config = await loadConfig();
    } catch (error) {
      return safeFailure(response, 'RELEASE_GATE_LOAD', error);
    }

    let valid;
    try {
      valid = await validateConfig(config);
    } catch (error) {
      return safeFailure(response, 'RELEASE_GATE_VALIDATE', error);
    }
    if (!valid) {
      console.error(JSON.stringify({
        event: 'hy_exp_0028_scan_failed',
        stage: 'RELEASE_GATE_VALIDATE',
        error: { name: 'Error', code: 'EMAIL_CUTOVER_CONFIG_INVALID' }
      }));
      return sendJson(response, 503, {
        error: 'EMAIL_CUTOVER_CONFIG_INVALID',
        stage: 'RELEASE_GATE_VALIDATE',
        paperOnly: true,
        signalOnly: true
      });
    }

    if (config.releaseState === READY_STATE) {
      return sendJson(response, 200, readyNoOp());
    }
    if (config.releaseState !== RELEASED_STATE) {
      return sendJson(response, 503, {
        error: 'EMAIL_CUTOVER_CONFIG_INVALID',
        stage: 'RELEASE_GATE_VALIDATE',
        paperOnly: true,
        signalOnly: true
      });
    }

    let runner;
    try {
      const loaded = await loadRunner();
      runner = loaded?.runHyExp0028Scan;
      if (typeof runner !== 'function') {
        const error = new Error('runner_export_invalid');
        error.code = 'RUNNER_EXPORT_INVALID';
        throw error;
      }
    } catch (error) {
      return safeFailure(response, 'RUNNER_IMPORT', error);
    }

    try {
      const result = await runner();
      return sendJson(response, result?.ok ? 200 : 503, result);
    } catch (error) {
      return safeFailure(response, 'RUNNER_EXECUTE', error);
    }
  };
}
