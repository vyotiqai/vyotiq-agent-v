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
import { resolveAgentProfile } from '@main/settings/agentProfiles'
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

      // Re-arm the chat loop BEFORE any early continue: a run that stopped on
      // quota exhaustion must still get its interval timer re-registered (the
      // scheduler holds at tick time on quota — see runLoopScheduler). The
      // quota gate only suppresses the relaunches below.
      const loop = rearmLoopFromDisk(workspacePath, runId, runDir)
      if (loop?.status === 'armed') {
        logger.info('Re-armed chat loop', { scope: 'loop', correlationId: runId })
      }

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

      const goal = readGoal(runDir)
      if (goal?.status !== 'active') {
        // Teammate auto-resume: a profile with autoResumeOnLaunch restarts its
        // own resumable (interrupted) runs at boot — crash recovery the user
        // opted into per teammate. Covers both interrupted-cancelled and
        // resumable-error (network/provider outage) stops; runs with active
        // goals resume above unconditionally.
        if (
          (status.status === 'cancelled' || status.status === 'error') &&
          status.resumable &&
          status.agentProfileId &&
          !isActive(runId)
        ) {
          const profile = resolveAgentProfile(workspacePath, status.agentProfileId)
          if (!profile) {
            logger.warn('Teammate run left resumable but its profile no longer exists', {
              scope: 'agent',
              correlationId: runId,
              profileId: status.agentProfileId
            })
          }
          if (profile?.autoResumeOnLaunch) {
            const launched = launchRunFollowUpOrStart({
              workspacePath,
              runId,
              wc,
              mode: status.mode ?? 'agent',
              message: {
                role: 'user',
                content: 'Continue where you left off.',
                synthetic: true
              }
            })
            if (launched.ok) {
              logger.info('Auto-resumed teammate run at startup', {
                scope: 'agent',
                correlationId: runId,
                profileId: profile.id
              })
            } else {
              logger.warn('Failed to auto-resume teammate run', {
                scope: 'agent',
                correlationId: runId,
                err: launched.error
              })
            }
          }
        }
        continue
      }
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
