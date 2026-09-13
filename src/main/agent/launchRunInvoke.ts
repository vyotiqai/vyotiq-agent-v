import type { WebContents } from 'electron'
import type { AgentInteractionMode, ChatMessage } from '../../shared/ipc'
import { getMainWindow } from '../app/window'
import { resolveRunDir } from '@main/storage/paths'
import { runExists } from './state'
import { hydrateFollowUpsFromDisk, syncFollowUpsToDisk } from './followUpStore'
import {
  enqueueFollowUp,
  isActive,
  setPendingMode,
  tryRegisterRunAbort
} from './runRegistry'
import { startAgentRunInBackground } from './startAgentRun'

export function resolveRunWebContents(fallback?: WebContents | null): WebContents | null {
  const current = getMainWindow()
  if (current && !current.isDestroyed() && !current.webContents.isDestroyed()) {
    return current.webContents
  }
  if (fallback && !fallback.isDestroyed()) return fallback
  return null
}

export function launchRunFollowUpOrStart(input: {
  workspacePath: string
  runId: string
  message: ChatMessage
  mode?: AgentInteractionMode
  wc?: WebContents | null
}): { ok: true } | { ok: false; error: string } {
  const wc = resolveRunWebContents(input.wc)
  if (!wc) return { ok: false, error: 'Window is not ready' }

  if (isActive(input.runId)) {
    const queued = enqueueFollowUp(input.runId, input.message)
    if (!queued.ok) return { ok: false, error: queued.error }
    if (input.mode) setPendingMode(input.runId, input.mode)
    syncFollowUpsToDisk(resolveRunDir(input.workspacePath, input.runId), input.runId)
    return { ok: true }
  }

  if (!runExists(input.workspacePath, input.runId)) {
    return { ok: false, error: 'Run not found' }
  }

  const registered = tryRegisterRunAbort(input.runId, input.workspacePath)
  if (!registered.ok) return { ok: false, error: registered.error }

  hydrateFollowUpsFromDisk(resolveRunDir(input.workspacePath, input.runId), input.runId)
  startAgentRunInBackground({
    runId: input.runId,
    workspacePath: input.workspacePath,
    invokeId: registered.invokeId,
    controller: registered.controller,
    wc,
    agentInput: {
      runId: input.runId,
      workspacePath: input.workspacePath,
      resume: true,
      newMessages: [input.message],
      mode: input.mode ?? 'agent'
    }
  })
  return { ok: true }
}
