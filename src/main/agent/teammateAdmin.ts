import type { AgentProfileDeleteResult } from '../../shared/ipc'
import { getWorkspaces } from '../workspace/workspaces'
import {
  deleteAgentProfile,
  emitAgentProfileOverridesChanged,
  emitAgentProfilesChanged,
  mutateAgentProfiles,
  removeProfileArtifactsForWorkspaces
} from '../settings/agentProfiles'
import { cancelRun, listActiveRuns } from './runRegistry'
import { cancelTasksForProfile } from './taskScheduler'

/**
 * Teammate administration shared by the IPC surface and the agent's own
 * `teammate_*` tools.
 *
 * Deleting a teammate is not one write — it ends live work, removes the roster
 * entry, retires the id, clears per-workspace overrides and re-pushes two
 * different change events, in that order. Two callers reimplementing that
 * sequence would drift on the ordering that makes it safe, so both go through
 * here.
 *
 * It lives under `agent/` rather than `settings/` because it reaches into the
 * run registry and the task scheduler, and `settings/agentProfiles` is imported
 * *by* the scheduler — putting it there would close an import cycle.
 */

/**
 * End a teammate's work, then remove it.
 *
 * Order is load-bearing: tasks and runs are cancelled **before** the roster
 * entry goes away. Committing the delete first leaves a window where live work
 * references a profile that no longer resolves, and it then fails as "profile
 * no longer exists" instead of being cancelled with its teammate.
 *
 * Run history and the private memory namespace are preserved — the id is
 * retired instead of reused, which is what makes keeping them safe. Warnings
 * name anything cleanup could not finish; the roster row is gone either way, so
 * a swallowed failure would be invisible.
 */
export async function deleteTeammateCascade(profileId: string): Promise<AgentProfileDeleteResult> {
  // Every path this install knows (open, recent, persisted UI state), not just
  // open ones — a closed workspace would otherwise keep running the dead
  // identity's tasks and revive its override.
  const workspaces = getWorkspaces()
  const knownPaths = new Set<string>([...workspaces.openPaths, ...workspaces.recentPaths])
  for (const path of Object.keys(workspaces.uiStateByPath ?? {})) knownPaths.add(path)
  const paths = [...knownPaths]
  const warnings: string[] = []

  let cancelledTasks = 0
  try {
    cancelledTasks = cancelTasksForProfile(profileId, paths)
  } catch (err) {
    warnings.push(
      `Some delegated tasks could not be cancelled: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  let cancelledRuns = 0
  for (const run of listActiveRuns()) {
    if (run.agentProfileId !== profileId) continue
    try {
      if (cancelRun(run.runId)) cancelledRuns += 1
    } catch (err) {
      warnings.push(
        `Run ${run.runId} could not be stopped: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  await mutateAgentProfiles(() => deleteAgentProfile({ id: profileId }))

  // Behaviour overrides must not survive to re-skin a future teammate.
  const artifacts = removeProfileArtifactsForWorkspaces(profileId, paths)
  for (const failure of artifacts.failures) {
    warnings.push(`Could not remove ${failure.path}: ${failure.error}`)
  }

  emitAgentProfilesChanged()
  for (const path of getWorkspaces().openPaths) emitAgentProfileOverridesChanged(path)
  return { deleted: true as const, cancelledTasks, cancelledRuns, warnings }
}
