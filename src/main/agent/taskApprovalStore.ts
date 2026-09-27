import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteJsonAsync } from '../storage/atomicWrite'
import { logger } from '../../shared/logger'

/**
 * "Allow for this task", kept next to the task's other records.
 *
 * Each run (one start or follow-up) builds a fresh approval gate, so a grant
 * held only on the gate ended with the run and the next follow-up asked again.
 * The card promises the whole task, follow-ups included, so the grant is read
 * back from the task's own directory whenever a run starts. It is scoped to
 * that one task: other tasks, and delegated child tasks with their own
 * directories, still ask. "Always allow" is the workspace-wide choice.
 */

export const TASK_APPROVALS_FILENAME = 'approvals.json'

const TASK_APPROVALS_VERSION = 1 as const

type TaskApprovalsFile = {
  version: typeof TASK_APPROVALS_VERSION
  /** Allow keys, as the gate matches them: a tool name or an agent-built tool's key. */
  allow: string[]
}

/** Serialises writes per task so two grants in one step cannot drop each other. */
const chains = new Map<string, Promise<void>>()

function parse(raw: string): string[] {
  const data = JSON.parse(raw) as Partial<TaskApprovalsFile> | null
  if (!data || data.version !== TASK_APPROVALS_VERSION || !Array.isArray(data.allow)) return []
  return data.allow.filter((key): key is string => typeof key === 'string' && key.length > 0)
}

/** The task's standing grants; empty when there are none or the file is unreadable. */
export function readTaskAllowlist(runDir: string): string[] {
  const file = join(runDir, TASK_APPROVALS_FILENAME)
  if (!existsSync(file)) return []
  try {
    return parse(readFileSync(file, 'utf8'))
  } catch (err) {
    // A damaged file costs the user one extra prompt, nothing more.
    logger.warn('Unreadable task approvals', { scope: 'agent', code: 'PERSIST', err })
    return []
  }
}

/** Add one grant to the task. Returns once it is on disk (or the write failed). */
export function persistTaskAllow(runDir: string, key: string): Promise<void> {
  const previous = chains.get(runDir) ?? Promise.resolve()
  const next = previous.then(async () => {
    const current = readTaskAllowlist(runDir)
    if (current.includes(key)) return
    const file: TaskApprovalsFile = { version: TASK_APPROVALS_VERSION, allow: [...current, key].sort() }
    try {
      await atomicWriteJsonAsync(join(runDir, TASK_APPROVALS_FILENAME), file)
    } catch (err) {
      logger.warn('Failed to persist task approval', { scope: 'agent', code: 'PERSIST', tool: key, err })
    }
  })
  chains.set(runDir, next)
  void next.finally(() => {
    if (chains.get(runDir) === next) chains.delete(runDir)
  })
  return next
}
