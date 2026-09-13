import type { WebContents } from 'electron'
import type { RunGoal } from '../../shared/ipc'
import { appendEvent } from './state'
import { getRunInvokeId } from './runRegistry'
import { sendChatEventToRenderer } from './startAgentRun'
import { resolveRunWebContents } from './launchRunInvoke'

export function emitGoalUpdate(input: {
  workspacePath: string
  runId: string
  runDir: string
  goal: RunGoal | null
  notice?: string
  wc?: WebContents | null
}): void {
  const invokeId = getRunInvokeId(input.runId)
  const event = {
    type: 'goal_update' as const,
    runId: input.runId,
    goal: input.goal,
    ...(input.notice ? { notice: input.notice } : {}),
    ...(invokeId != null ? { invokeId } : {})
  }
  appendEvent(input.runDir, event)
  const target = resolveRunWebContents(input.wc)
  if (target) sendChatEventToRenderer(input.runId, event, invokeId ?? 1, target)
}
