import { existsSync } from 'fs'
import type { WebContents } from 'electron'
import type { AgentInteractionMode, ChatMessage, ProviderId } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { workspacePathsEqual } from '../../shared/workspacePath'
import { getWorkspaces } from '../workspace/workspaces'
import { runExists } from './state'
import { createRunId } from './loop'
import {
  isActive,
  isRunTurnComplete,
  tryRegisterRunAbort,
  waitUntilRunInactive
} from './runRegistry'
import { hydrateRunFollowUps, startAgentRunInBackground } from './startAgentRun'

/**
 * The one path that starts an agent run.
 *
 * Chat IPC and boot relaunch all used to repeat this sequence — workspace
 * validation, run id allocation, atomic registration, follow-up hydration and
 * background start — with small divergences between copies. Those divergences
 * are how a background-launched run ended up without the checks a user-launched
 * one got. Callers now supply intent; this owns the order.
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
  runtime?: 'local' | 'cloud'
  /** A new task's done-when checks, from its brief. */
  doneWhen?: string[]
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
 * the same tick. Refuses rather than waits when the run is still unwinding —
 * `launchRun` is the variant that waits.
 */
export function launchRunSync(request: LaunchRunRequest): LaunchRunOutcome {
  const { workspacePath, wc } = request
  const open = getWorkspaces().openPaths.some((p) => workspacePathsEqual(p, workspacePath))
  if (!open) return refuse('Workspace is not open', 'workspace_not_open')
  if (!existsSync(workspacePath)) {
    return refuse('Workspace path does not exist', 'workspace_missing')
  }

  let runId: string
  let resume = false
  if (request.runId && runExists(workspacePath, request.runId)) {
    // Retryable: the previous invoke may still be unwinding. launchRunSync
    // refuses rather than waits (launchRun is the variant that waits), so the
    // caller's bounded retry is what covers that race.
    if (isActive(request.runId)) return refuse('Run is already active', 'run_active')
    runId = request.runId
    resume = true
  } else {
    runId = createRunId()
  }

  // Atomic register BEFORE any await so cancel works during startup and two
  // concurrent launches cannot overlap the same runDir.
  const registered = tryRegisterRunAbort(runId, workspacePath)
  if (!registered.ok) return refuse(registered.error, registered.code)
  const { invokeId, controller } = registered

  if (resume) {
    // Dedupe against the freshly sent messages: a crash between enqueue and
    // apply followed by a manual resend must not apply the text twice.
    hydrateRunFollowUps(workspacePath, runId, request.newMessages)
  }
  logger.info('Agent run start', {
    scope: 'agent',
    correlationId: runId,
    source: request.source,
    resume
  })

  const shared = {
    runId,
    workspacePath,
    resume,
    mode: request.mode,
    focusedFile: request.focusedFile,
    provider: request.provider,
    model: request.model,
    ...(request.runtime ? { runtime: request.runtime } : {})
  }
  const agentInput =
    request.incremental && request.runId && request.newMessages?.length
      ? {
          ...shared,
          newMessages: request.newMessages,
          persistedMessageCount: request.persistedMessageCount
        }
      : {
          ...shared,
          messages: request.messages ?? [],
          ...(request.doneWhen?.length ? { doneWhen: request.doneWhen } : {})
        }

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
