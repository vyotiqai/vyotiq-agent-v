/**
 * The app's actions, wired to the real app: the workspaces, the task lists,
 * the main window, settings and the system shell. See runner.ts.
 */
import { app, shell } from 'electron'
import { getWorkspaces } from '../workspace/workspaces'
import { listRuns } from '../agent/state'
import { cancelRun, enqueueFollowUp, followUpPreview, getRunInvokeId, getRunWorkspace, isActive, waitUntilRunInactive } from '../agent/runRegistry'
import { launchRun, launchRunSync } from '../agent/launchRun'
import { syncFollowUpsToDisk } from '../agent/followUpStore'
import { getChatEventDispatcher } from '../ipc/streamBatch'
import { resolveRunDir } from '../storage/paths'
import { logger } from '../../shared/logger'
import { IPC } from '../../shared/channels'
import type { AgentEvent, ChatMessage } from '../../shared/ipc'
import type { WebContents } from 'electron'
import { enqueueSettingsMutation, getSettings, setSettings } from '../settings/settings'
import { applyWindowChrome, getMainWindow } from '../app/window'
import type { Settings } from '../../shared/ipc'
import { contextAtHome, runAppAction, type AppActionContext, type AppActionResult, type AppControlDeps } from './runner'

export { settleWindowAction, setWindowActionChannel, type AppActionResult, type AppActionContext } from './runner'

const appDeps: AppControlDeps = {
  openWorkspaces: () => getWorkspaces().openPaths,
  activeWorkspace: () => getWorkspaces().activePath,
  listTasks: async (workspacePath) => {
    const { runs } = await listRuns(workspacePath)
    return runs.map((r) => ({ runId: r.runId, title: (r.goal ?? '').split('\n')[0]!.trim(), status: r.status }))
  },
  window: () => getMainWindow()?.webContents ?? null,
  cancelRun: (runId) => cancelRun(runId),
  runActive: (runId) => isActive(runId),
  startTask: (workspacePath, message, wc) => {
    const outcome = launchRunSync({ workspacePath, messages: [message], wc, source: 'app-control' })
    return outcome.ok ? { ok: true, runId: outcome.runId } : { ok: false, error: outcome.error }
  },
  sendToTask: (workspacePath, runId, message, wc) => sendToTask(workspacePath, runId, message, wc),
  patchSettings: async (patch) => {
    const next = await enqueueSettingsMutation(() => setSettings(patch as Partial<Settings>))
    if (patch.theme !== undefined || patch.skinId !== undefined) applyWindowChrome(next.theme, next.skinId)
  },
  settings: () => getSettings(),
  openPath: (path) => shell.openPath(path),
  revealPath: (path) => shell.showItemInFolder(path),
  openExternal: (url) => shell.openExternal(url),
  quit: () => app.quit()
}

export function runAppActionInApp(name: string, args: unknown, ctx: AppActionContext): Promise<AppActionResult> {
  return runAppAction(appDeps, name, args, contextAtHome(ctx, ctx.runId ? getRunWorkspace(ctx.runId) : undefined))
}

/**
 * More work for a task, as its composer would send it: queued on a running
 * run (chat:followUp's path, so the window's queue shows it), else the run
 * goes again with the message appended to its saved history.
 */
async function sendToTask(
  workspacePath: string,
  runId: string,
  message: ChatMessage,
  wc: WebContents
): Promise<{ ok: true; queued: boolean } | { ok: false; error: string }> {
  if (isActive(runId)) {
    const queued = enqueueFollowUp(runId, message)
    if (queued.ok) {
      syncFollowUpsToDisk(resolveRunDir(workspacePath, runId), runId)
      getChatEventDispatcher().flush(runId)
      const invokeId = getRunInvokeId(runId)
      wc.send(IPC.chatEvent, {
        type: 'follow_up_queued',
        runId,
        id: queued.id,
        position: queued.position,
        queueLength: queued.queueLength,
        preview: followUpPreview(message),
        ...(invokeId != null ? { invokeId } : {})
      } satisfies AgentEvent)
      logger.info('Chat follow-up queued', { scope: 'app-control', correlationId: runId, queueLength: queued.queueLength })
      return { ok: true, queued: true }
    }
    // Finishing its turn: wait it out and send it as a new turn instead.
    if (queued.error !== 'Run is finishing') return { ok: false, error: queued.error }
    await waitUntilRunInactive(runId)
  }
  // Everything on disk counts as already sent: the message is appended after it.
  const outcome = await launchRun({
    workspacePath,
    runId,
    newMessages: [message],
    incremental: true,
    persistedMessageCount: Number.MAX_SAFE_INTEGER,
    wc,
    source: 'app-control'
  })
  return outcome.ok ? { ok: true, queued: false } : { ok: false, error: outcome.error }
}
