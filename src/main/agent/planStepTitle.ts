import { readFile } from 'fs/promises'
import { join } from 'path'
import { STEP_TITLE_MAX, type RunStatus } from '../../shared/ipc'
import { canonicalTodoId } from '../../shared/utils/todoContent'
import { readTodos } from './tools/todo'

/**
 * The title the parent's plan gives a step, as its list stands: the name the
 * parent's record gives the child it spawned for that step, so the navigator
 * can call the child the same.
 */
export function planStepTitle(parentDir: string, stepId: string | undefined): string | undefined {
  const id = stepId?.trim()
  if (!id) return undefined
  const want = canonicalTodoId(id)
  const todo = readTodos(parentDir).find((t) => t.id === id || canonicalTodoId(t.id) === want)
  const title = todo?.content.replace(/\s+/g, ' ').trim()
  return title ? title.slice(0, STEP_TITLE_MAX) : undefined
}

/**
 * An inline instance's step title for the run list: its step as the parent's
 * plan titles it now (a later list can rename it, and the record shows the
 * latest), else as it was at the spawn. A child spawned before its status
 * kept its step finds it in the parent's start events.
 */
export async function instanceStepTitle(sessionsRoot: string, runId: string, status: RunStatus): Promise<string | undefined> {
  if (!status.inlineInstance || !status.parentRunId) return undefined
  const parentDir = join(sessionsRoot, status.parentRunId)
  const stepId = status.stepId ?? (status.stepTitle ? undefined : (await spawnedStepIds(parentDir)).get(runId))
  return planStepTitle(parentDir, stepId) ?? status.stepTitle
}

/**
 * Which step each child was spawned for, from a parent's start events. Only
 * children that predate their status keeping it are looked up here, and their
 * parents are finished, so each parent's log is read once.
 */
const spawnedSteps = new Map<string, Promise<Map<string, string>>>()

function spawnedStepIds(parentDir: string): Promise<Map<string, string>> {
  let read = spawnedSteps.get(parentDir)
  if (!read) {
    read = readSpawnedStepIds(parentDir)
    spawnedSteps.set(parentDir, read)
  }
  return read
}

async function readSpawnedStepIds(parentDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let text: string
  try {
    text = await readFile(join(parentDir, 'events.jsonl'), 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    if (!line.includes('agent_instance_update') || !line.includes('"stepId"')) continue
    try {
      const row = JSON.parse(line) as { event?: Record<string, unknown> } & Record<string, unknown>
      const event = row.event ?? row
      const child = event.instanceRunId
      const step = event.stepId
      if (event.type === 'agent_instance_update' && typeof child === 'string' && typeof step === 'string' && !out.has(child)) {
        out.set(child, step)
      }
    } catch {
      /* a torn line: the rest still count */
    }
  }
  return out
}

export function resetPlanStepTitlesForTests(): void {
  spawnedSteps.clear()
}
