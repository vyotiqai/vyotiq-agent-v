import { existsSync } from 'fs'
import type { WebContents } from 'electron'
import type { AgentInteractionMode, ChatMessage, ProviderId } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { workspacePathsEqual } from '../../shared/workspacePath'
import { getWorkspaces } from '../workspace/workspaces'
import { loadStatus, runExists } from './state'
import { resolveRunDir } from '../storage/paths'
import { createRunId, validateExistingRunStart } from './loop'
import {
  clearRunAbort,
  isActive,
  isRunTurnComplete,
  tryRegisterRunAbort,
  waitUntilRunInactive
} from './runRegistry'
import { hydrateRunFollowUps, startAgentRunInBackground } from './startAgentRun'

/**
 * The one path that starts an agent run.
 *
 * Chat IPC, the delegated-task scheduler and boot relaunch all used to repeat
 * this sequence — workspace validation, run id allocation, immutable-binding
 * checks, atomic registration, follow-up hydration and background start — with
 * small divergences between copies. Those divergences are how a task-launched
 * run ended up without the checks a user-launched one got. Callers now supply
 * intent; this owns the order.
 *
 * Zod parsing and sender authorization stay with the IPC layer: they are about
 * trusting the request, not about starting a run.
 */

export type LaunchRunRequest = {
  workspacePath: string
  /** Existing run to continue; omit for a new run. */
  runId?: string
  messages?: ChatMessage[]
  newMessages?: ChatMessage[]
  persistedMessageCount?: number
  incremental?: boolean
  mode?: AgentInteractionMode
  focusedFile?: string | null
  provider?: ProviderId
  model?: string
  modelExplicit?: boolean
  agentProfileId?: string
  runtime?: 'local' | 'cloud'
  /** Delegated task that owns this run (scheduler launches only). */
  delegatedTaskId?: string
  /**
   * Which binding fields the caller stated explicitly. An absent field inherits
   * the run's persisted binding; a field set to a DIFFERENT value is a rebind
   * attempt and is refused — so `undefined` and "not provided" cannot mean the
   * same thing here.
   */
  explicit?: { agentProfileId?: boolean; runtime?: boolean }
  /**
   * Refuse the launch if another live run already holds this teammate. Taken
   * atomically with the run registration, so no window exists where two
   * callers both observe the identity as free.
   */
  requireProfileSlot?: boolean
  /**
   * Runs after the run slot is claimed and before the run starts. Throwing
   * aborts the launch and releases the claim. Callers that must have durable
   * state on disk before any work begins (the task scheduler writing its
   * `running` record) hook in here, so a failed write means the run never ran
   * rather than running untracked.
   */
  onClaimed?: (claim: { runId: string; invokeId: number }) => void
  /** Where this run's events stream. */
  wc: WebContents
  /** Log label for the originating surface. */
  source: string
}

export type LaunchRunOutcome =
  | { ok: true; runId: string; invokeId: number; resume: boolean }
  | { ok: false; error: string; code?: string }

function refuse(error: string, code?: string): LaunchRunOutcome {
  return { ok: false, error, ...(code ? { code } : {}) }
}

/**
 * Synchronous launch. Used wherever the caller must observe the started run in
 * the same tick (the scheduler returns the stored record straight after
 * enqueue). Refuses rather than waits when the run is still unwinding —
 * `launchRun` is the variant that waits.
 */
export function launchRunSync(request: LaunchRunRequest): LaunchRunOutcome {
  const { workspacePath, wc } = request
  const open = getWorkspaces().openPaths.some((p) => workspacePathsEqual(p, workspacePath))
  if (!open) return refuse('Workspace is not open')
  if (!existsSync(workspacePath)) return refuse('Workspace path does not exist')

  let runId: string
  let resume = false
  if (request.runId && runExists(workspacePath, request.runId)) {
    if (isActive(request.runId)) return refuse('Run is already active')
    // Early reject on an immutable-binding violation so the caller gets a clear
    // error before a run slot is taken. A run dir with no readable status still
    // resumes: there is no persisted binding to contradict, and runAgent
    // re-derives (and re-validates) whatever it can from disk.
    const persisted = loadStatus(resolveRunDir(workspacePath, request.runId))
    if (persisted) {
      validateExistingRunStart(persisted, request, {
        agentProfileId: request.explicit?.agentProfileId === true,
        runtime: request.explicit?.runtime === true
      })
    }
    runId = request.runId
    resume = true
  } else {
    runId = createRunId()
  }

  // Atomic register BEFORE any await so cancel works during startup and two
  // concurrent launches cannot overlap the same runDir.
  const registered = tryRegisterRunAbort(runId, workspacePath, request.agentProfileId, {
    requireProfileSlot: request.requireProfileSlot === true
  })
  if (!registered.ok) return refuse(registered.error, registered.code)
  const { invokeId, controller } = registered

  if (request.onClaimed) {
    try {
      request.onClaimed({ runId, invokeId })
    } catch (err) {
      // Release the claim: the run never started, so the teammate must not
      // stay blocked and the id must stay reusable.
      clearRunAbort(runId, invokeId)
      return refuse(err instanceof Error ? err.message : String(err))
    }
  }

  if (resume) {
    // Dedupe against the freshly sent messages: a crash between enqueue and
    // apply followed by a manual resend must not apply the text twice.
    hydrateRunFollowUps(workspacePath, runId, request.newMessages)
  }
  logger.info('Agent run start', {
    scope: 'agent',
    correlationId: runId,
    source: request.source,
    resume,
    ...(request.delegatedTaskId ? { delegatedTaskId: request.delegatedTaskId } : {})
  })

  const shared = {
    runId,
    workspacePath,
    resume,
    mode: request.mode,
    focusedFile: request.focusedFile,
    provider: request.provider,
    model: request.model,
    modelExplicit: request.modelExplicit,
    ...(request.delegatedTaskId ? { delegatedTaskId: request.delegatedTaskId } : {}),
    // Presence matters, not value: only a stated field participates in the
    // immutable-binding comparison downstream.
    ...(request.explicit?.agentProfileId ? { agentProfileId: request.agentProfileId } : {}),
    ...(request.explicit?.runtime ? { runtime: request.runtime } : {})
  }
  const agentInput =
    request.incremental && request.runId && request.newMessages?.length
      ? {
          ...shared,
          newMessages: request.newMessages,
          persistedMessageCount: request.persistedMessageCount
        }
      : { ...shared, messages: request.messages ?? [] }

  startAgentRunInBackground({ runId, workspacePath, invokeId, controller, wc, agentInput })
  return { ok: true, runId, invokeId, resume }
}

/**
 * Launch, tolerating a run whose previous turn is still unwinding. The UI can
 * show "done" while the loop's finally is still flushing, so a quick next send
 * waits for the slot instead of failing with "Run is already active".
 */
export async function launchRun(request: LaunchRunRequest): Promise<LaunchRunOutcome> {
  if (
    request.runId &&
    isActive(request.runId) &&
    isRunTurnComplete(request.runId) &&
    runExists(request.workspacePath, request.runId)
  ) {
    await waitUntilRunInactive(request.runId)
  }
  return launchRunSync(request)
}
