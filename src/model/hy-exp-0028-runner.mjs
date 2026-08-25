import { ingestAdvisoryBundle } from '../../api/ingest.mjs';
import { dispatchPendingEmails } from '../../api/_lib/gmail.mjs';
import {
  EMAIL_SIGNAL_CUTOVER_CONFIG,
  isEmailSignalCutoverConfigValid
} from './email-signal-cutover.mjs';
import {
  buildHyExp0028Candidates,
  buildHyExp0028EmailAdvisory
} from './hy-exp-0028-email-signal.mjs';
import {
  fetchHyExp0028CausalInputs,
  fetchHyExp0028LiveEntryBar
} from './hy-exp-0028-market-data.mjs';

const SIGNAL_EXPIRY_MS = 15 * 60 * 1_000;

function nowValue(clock) {
  const value = typeof clock === 'function' ? clock() : clock;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('invalid_runner_clock');
  return parsed;
}

function notReleasedResult() {
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

function invalidConfigResult() {
  return {
    ok: false,
    noOp: true,
    reason: 'EMAIL_CUTOVER_CONFIG_INVALID',
    marketDataFetched: false,
    candidates: 0,
    advisories: 0,
    outbox: 0,
    smtpDispatched: 0,
    paperOnly: true,
    signalOnly: true
  };
}

export async function runHyExp0028Scan({
  config = EMAIL_SIGNAL_CUTOVER_CONFIG,
  fetchImpl = fetch,
  clock = Date.now,
  causalInputFetcher = fetchHyExp0028CausalInputs,
  entryBarFetcher = fetchHyExp0028LiveEntryBar,
  candidateBuilder = buildHyExp0028Candidates,
  advisoryBuilder = buildHyExp0028EmailAdvisory,
  ingestImpl = ingestAdvisoryBundle,
  dispatchImpl = dispatchPendingEmails,
  sleepImpl
} = {}) {
  // This gate intentionally precedes every market-data, ingestion, and SMTP call.
  if (!isEmailSignalCutoverConfigValid(config)) return invalidConfigResult();
  if (config.releaseState !== 'EMAIL_SIGNAL_RELEASED') return notReleasedResult();

  const scannedAt = nowValue(clock);
  let causalInput;
  try {
    causalInput = await causalInputFetcher({
      asOf: scannedAt,
      fetchImpl,
      clock
    });
  } catch {
    return {
      ok: false,
      reason: 'HY_EXP_0028_CAUSAL_DATA_UNAVAILABLE',
      marketDataFetched: true,
      candidates: 0,
      advisories: 0,
      outbox: 0,
      smtpDispatched: 0,
      paperOnly: true,
      signalOnly: true
    };
  }

  const built = candidateBuilder(causalInput);
  const candidates = Array.isArray(built?.candidates) ? built.candidates : [];
  if (!candidates.length) {
    return {
      ok: true,
      reason: 'NO_CANDIDATE',
      marketDataFetched: true,
      candidates: 0,
      advisories: 0,
      outbox: 0,
      smtpDispatched: 0,
      rejections: built?.rejections ?? [],
      paperOnly: true,
      signalOnly: true
    };
  }

  const accepted = [];
  const entryRejections = [];
  const captureStartedAt = nowValue(clock);
  const entryResults = await Promise.allSettled(candidates.map(async candidate => {
    const targetEntryTime = candidate.decisionTime + 300_000;
    const deadlineAt = targetEntryTime + 90_000;
    if (captureStartedAt > deadlineAt) {
      return {
        candidate,
        entryBar: null,
        rejection: 'ENTRY_CAPTURE_WINDOW_EXPIRED'
      };
    }
    try {
      const entryBar = await entryBarFetcher(candidate.symbol, targetEntryTime, {
        fetchImpl,
        clock,
        sleepImpl,
        deadlineAt,
        maxDelayMs: 90_000
      });
      return {
        candidate,
        entryBar,
        rejection: entryBar ? null : 'ENTRY_BAR_NOT_AVAILABLE'
      };
    } catch {
      return {
        candidate,
        entryBar: null,
        rejection: 'ENTRY_BAR_CAPTURE_FAILED'
      };
    }
  }));

  for (const settled of entryResults) {
    if (settled.status !== 'fulfilled' || !settled.value.entryBar) {
      const value = settled.status === 'fulfilled' ? settled.value : null;
      entryRejections.push({
        symbol: value?.candidate?.symbol ?? null,
        decisionTime: value?.candidate?.decisionTime ?? null,
        rejection: value?.rejection ?? 'ENTRY_BAR_CAPTURE_FAILED'
      });
      continue;
    }
    const { candidate, entryBar } = settled.value;
    const result = advisoryBuilder({
      candidate,
      entryBar,
      expiresAt: new Date(candidate.decisionTime + SIGNAL_EXPIRY_MS).toISOString(),
      now: nowValue(clock)
    });
    if (result?.accepted !== true) {
      entryRejections.push({
        symbol: candidate.symbol,
        decisionTime: candidate.decisionTime,
        rejection: result?.rejection ?? 'EMAIL_CANDIDATE_REJECTED'
      });
      continue;
    }
    accepted.push(result);
  }

  const ingested = [];
  for (const result of accepted) {
    ingested.push(await ingestImpl({ advisory: result.advisory, email: result.email }));
  }
  const queued = ingested.filter(result => result?.email?.queued === true);
  const dispatched = queued.length ? await dispatchImpl() : [];
  const allEntryWindowsExpired = candidates.length > 0
    && entryRejections.length === candidates.length
    && entryRejections.every(row => row.rejection === 'ENTRY_CAPTURE_WINDOW_EXPIRED');
  return {
    ok: true,
    reason: allEntryWindowsExpired
      ? 'ENTRY_CAPTURE_WINDOW_EXPIRED'
      : accepted.length ? 'ADVISORIES_PROCESSED' : 'NO_VALID_ENTRY_OBSERVATION',
    marketDataFetched: true,
    candidates: candidates.length,
    advisories: accepted.length,
    outbox: queued.length,
    smtpDispatched: Array.isArray(dispatched)
      ? dispatched.filter(result => result?.status === 'SENT').length
      : 0,
    entryRejections,
    ingest: ingested,
    dispatch: dispatched,
    paperOnly: true,
    signalOnly: true
  };
}
