import { sendJson, methodAllowed } from './_lib/http.mjs';
import { authorizeInternalScheduler } from './_lib/internal-scheduler-auth.mjs';
import { runHyExp0028Scan } from '../src/model/hy-exp-0028-runner.mjs';

export default async function handler(request, response) {
  if (request.method !== 'GET') return methodAllowed(response, ['GET']);
  if (!await authorizeInternalScheduler(request)) {
    return sendJson(response, 401, { error: 'unauthorized' });
  }
  try {
    const result = await runHyExp0028Scan();
    return sendJson(response, result.ok ? 200 : 503, result);
  } catch {
    return sendJson(response, 503, {
      error: 'hy_exp_0028_scan_failed',
      paperOnly: true,
      signalOnly: true
    });
  }
}
