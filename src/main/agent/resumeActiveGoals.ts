import { readdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { WebContents } from 'electron'
import { getWorkspaces } from '../workspace/workspaces'
import { workspaceSessionsRoot, resolveRunDir } from '@main/storage/paths'
import { loadStatus } from './state'
import { readGoal } from './runGoal'
import { emitGoalUpdate } from './goalEvents'
import { rearmLoopFromDisk } from './runLoopScheduler'
import { launchRunFollowUpOrStart } from './launchRunInvoke'
import { formatGoalContinueMessage } from '../../shared/goalRuntime'
import { isQuotaExhaustedMessage } from './quotaGate'
import { isActive } from './runRegistry'
import { logger } from '../../shared/logger'

let resumedOnce = false

export function resetGoalResumeForTests(): void {
  resumedOnce = false
}

export function resumeActiveGoalsAndLoops(wc: WebContents): void {
  if (resumedOnce) return
  resumedOnce = true
  const open = getWorkspaces().openPaths
  for (const workspacePath of open) {
    const root = workspaceSessionsRoot(workspacePath)
    if (!existsSync(root)) continue
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const runId = entry.name
      const runDir = join(root, runId)
      const status = loadStatus(runDir)
      if (!status || status.inlineInstance) continue

      // Quota exhaustion is a billing gate, not an outage (quotaGate contract):
      // relaunching cannot succeed until the plan resets, so an app-start
      // relaunch would re-stop instantly on the same terminal error at every
      // restart. Leave the goal active for a user continue.
      if (status.status === 'error' && isQuotaExhaustedMessage(status.error ?? '')) {
        logger.warn('Goal run stopped on provider quota exhaustion — not relaunching at startup', {
          scope: 'goal',
          correlationId: runId
        })
        continue
      }

      const loop = rearmLoopFromDisk(workspacePath, runId, runDir)
      if (loop?.status === 'armed') {
        logger.info('Re-armed chat loop', { scope: 'loop', correlationId: runId })
      }

      const goal = readGoal(runDir)
      if (goal?.status !== 'active') continue
      if (isActive(runId)) continue

      const launched = launchRunFollowUpOrStart({
        workspacePath,
        runId,
        wc,
        mode: status?.mode ?? 'agent',
        message: {
          role: 'user',
          content: formatGoalContinueMessage(goal.objective),
          synthetic: true
        }
      })
      if (!launched.ok) {
        logger.warn('Failed to resume active goal', {
          scope: 'goal',
          correlationId: runId,
          err: launched.error
        })
        continue
      }
      emitGoalUpdate({
        workspacePath,
        runId,
        runDir: resolveRunDir(workspacePath, runId),
        goal,
        notice: `Resuming goal: ${goal.objective}`,
        wc
      })
    }
  }
}
