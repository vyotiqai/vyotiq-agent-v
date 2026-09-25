import { resolveRunDir } from '../storage/paths'
import type { ActiveRun } from '../../shared/ipc'
import { oldestPendingAgentQuestionAt } from './agentQuestion'
import { listActiveRuns } from './runRegistry'
import { oldestPendingToolApprovalAt } from './toolApproval'
import { readTodos } from './tools/todo'

/**
 * What the navigator needs to know about a live run beyond "it is running":
 * whether it is blocked on you, and how far through its todo list it is.
 *
 * Kept out of runRegistry so the registry stays free of disk reads and of the
 * approval/question modules (runRegistry is imported by both).
 */
export function listActiveRunsView(): ActiveRun[] {
  return listActiveRuns().map((run) => {
    const view: ActiveRun = {
      runId: run.runId,
      workspacePath: run.workspacePath,
      invokeId: run.invokeId,
      pendingFollowUps: run.pendingFollowUps
    }
    const waiting = waitingFor(run.runId)
    if (waiting) view.waiting = waiting
    const steps = todoProgress(run.workspacePath, run.runId)
    if (steps) view.steps = steps
    return view
  })
}

function waitingFor(runId: string): ActiveRun['waiting'] {
  const approval = oldestPendingToolApprovalAt(runId)
  const question = oldestPendingAgentQuestionAt(runId)
  if (approval && (!question || approval <= question)) return { kind: 'approval', since: approval }
  if (question) return { kind: 'question', since: question }
  return undefined
}

function todoProgress(workspacePath: string, runId: string): ActiveRun['steps'] {
  let runDir: string
  try {
    runDir = resolveRunDir(workspacePath, runId)
  } catch {
    return undefined
  }
  const todos = readTodos(runDir).filter((todo) => todo.status !== 'cancelled')
  if (todos.length === 0) return undefined
  return {
    completed: todos.filter((todo) => todo.status === 'completed').length,
    total: todos.length
  }
}
