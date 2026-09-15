import { resolveRunDir } from '../storage/paths'
import { createRunId } from './loop'
import { isActive } from './runRegistry'
import {
  createRun,
  loadMessagesAsync,
  loadStatus,
  runExists,
  syncMessagesAsync,
  updateStatus
} from './state'

/**
 * Fork a chat session: clone the source run's transcript into a brand-new run
 * (optionally truncated to the first `forkIndex` messages) and leave the
 * original run untouched.
 *
 * Returns the new run's id.
 */
export async function forkRun(
  workspacePath: string,
  runId: string,
  forkIndex?: number
): Promise<string> {
  if (isActive(runId)) throw new Error('Cancel run first')
  if (!runExists(workspacePath, runId)) throw new Error('Run not found')
  const parsed = loadStatus(resolveRunDir(workspacePath, runId))
  if (!parsed) throw new Error('Invalid run status')

  const source = await loadMessagesAsync(workspacePath, runId)
  const keep =
    forkIndex === undefined
      ? source.length
      : Math.max(0, Math.min(Math.trunc(forkIndex), source.length))
  const forkedRunId = createRunId()
  // Fresh contract + status + empty events: the fork is a new run whose
  // transcript below is the clone. events.jsonl stays empty — telemetry
  // belongs to the new run, not the source.
  createRun(workspacePath, forkedRunId, `${parsed.goal} (fork)`, {
    mode: parsed.mode,
    parentRunId: runId
  })
  const forkedDir = resolveRunDir(workspacePath, forkedRunId)
  await syncMessagesAsync(forkedDir, source.slice(0, keep))
  // A fork is a finished conversation until the user continues it.
  await updateStatus(forkedDir, { status: 'done' }, { sync: true })
  return forkedRunId
}
