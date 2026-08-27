import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

function parseOffsetMs(text) {
  const seconds = String(text).match(/System time\s*:\s*([+-]?[0-9]+(?:\.[0-9]+)?)\s+seconds/i);
  if (seconds) return Number(seconds[1]) * 1_000;
  const windowsSeconds = String(text).match(/Offset\s*:\s*([+-]?[0-9]+(?:\.[0-9]+)?)s/i);
  if (windowsSeconds) return Number(windowsSeconds[1]) * 1_000;
  const milliseconds = String(text).match(/Offset\s*:\s*([+-]?[0-9]+(?:\.[0-9]+)?)ms/i);
  if (milliseconds) return Number(milliseconds[1]);
  const microseconds = String(text).match(/NTPOffsetUSec=([+-]?[0-9]+)/i);
  if (microseconds) return Number(microseconds[1]) / 1_000;
  return null;
}

function synchronizedFrom(text) {
  const value = String(text);
  if (/NTPSynchronized=(yes|true|1)/i.test(value)) return true;
  if (/Leap status\s*:\s*Normal/i.test(value) && /Reference time\s*:/i.test(value)) return true;
  if (/Last Successful Sync Time\s*:/i.test(value) && !/Source\s*:\s*Free-running System Clock/i.test(value)) return true;
  return false;
}

async function defaultCommandRunner(command, args) {
  const result = await execFile(command, args, { timeout: 3_000, maxBuffer: 256 * 1024, windowsHide: true });
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

/**
 * Host NTP is the primary clock trust source. Binance /fapi/v1/time is
 * intentionally not consulted here, so an exchange REST ban cannot make a
 * healthy host clock appear unhealthy.
 */
export async function readHostNtpEvidence({
  platform = process.platform,
  commandRunner = defaultCommandRunner,
  now = () => Date.now()
} = {}) {
  const checkedAt = new Date(now()).toISOString();
  const attempts = platform === 'win32'
    ? [{ command: 'w32tm', args: ['/query', '/status'], method: 'w32tm /query /status' }]
    : [
      { command: 'chronyc', args: ['tracking'], method: 'chronyc tracking' },
      { command: 'timedatectl', args: ['show', '--property=NTPSynchronized', '--property=NTPOffsetUSec'], method: 'timedatectl show' }
    ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      const output = await commandRunner(attempt.command, attempt.args);
      const offsetMs = parseOffsetMs(output);
      const synchronized = synchronizedFrom(output);
      if (synchronized || offsetMs !== null) {
        const trusted = synchronized && offsetMs !== null && Number.isFinite(offsetMs) && Math.abs(offsetMs) <= 500;
        return Object.freeze({
          status: trusted ? 'CLOCK_TRUSTED' : 'CLOCK_UNTRUSTED',
          clockSource: 'HOST_NTP_EVIDENCE',
          checkedAt,
          synchronized,
          offsetMs: Number.isFinite(offsetMs) ? offsetMs : null,
          evidenceMethod: attempt.method,
          error: null
        });
      }
      errors.push(`${attempt.method}:UNSYNCHRONIZED`);
    } catch (error) {
      errors.push(`${attempt.method}:${error.code ?? error.name ?? 'ERROR'}`);
    }
  }
  return Object.freeze({
    status: 'CLOCK_UNTRUSTED',
    clockSource: 'HOST_NTP_EVIDENCE',
    checkedAt,
    synchronized: false,
    offsetMs: null,
    evidenceMethod: attempts.map(attempt => attempt.method).join(' then '),
    error: errors.join(';') || 'NO_NTP_EVIDENCE'
  });
}
