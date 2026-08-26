import { runAudit, runDevelopment } from '../src/research/hy-exp-0030-development.mjs';

const mode = process.argv[2] || 'audit';
if (!['audit', 'run'].includes(mode)) throw new Error('Usage: audit|run');

const result = mode === 'audit' ? await runAudit() : await runDevelopment();
const artifact = mode === 'audit' ? result.artifact : result.result;
console.log(JSON.stringify({
  experimentId: artifact.experimentId,
  status: mode === 'audit' ? artifact.status : result.status,
  developmentAllowed: mode === 'audit' ? artifact.developmentAllowed : result.status !== 'DATASET_INSUFFICIENT',
  gate: mode === 'audit' ? artifact.gate : result.audit.gate,
  candidateCounts: mode === 'audit' ? artifact.candidateCounts : artifact.counts,
  pitExpanded: mode === 'audit' ? artifact.cohorts.PIT_EXPANDED.status : 'EXPANDED_UNIVERSE_NOT_EVALUABLE',
  outcomeRead: mode === 'audit' ? artifact.outcomeRead : artifact.sourceBoundary.outcomeRead,
  pnlComputed: mode === 'audit' ? artifact.pnlComputed : artifact.sourceBoundary.pnlComputed,
  finalOosRead: mode === 'audit' ? artifact.finalOosRead : artifact.sourceBoundary.finalOosRead
}, null, 2));

if (mode === 'audit' && !result.artifact.gate.pass) process.exitCode = 2;
