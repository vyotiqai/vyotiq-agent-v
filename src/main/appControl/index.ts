/**
 * The app's actions, wired to the real app: the workspaces, the task lists,
 * the main window, settings and the system shell. See runner.ts.
 */
import { app, shell } from 'electron'
import { getWorkspaces } from '../workspace/workspaces'
import { listRuns } from '../agent/state'
import { cancelRun } from '../agent/runRegistry'
import { launchRunSync } from '../agent/launchRun'
import { enqueueSettingsMutation, getSettings, setSettings } from '../settings/settings'
import { applyWindowChrome, getMainWindow } from '../app/window'
import type { Settings } from '../../shared/ipc'
import { runAppAction, type AppActionContext, type AppActionResult, type AppControlDeps } from './runner'

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
  startTask: (workspacePath, message, wc) => {
    const outcome = launchRunSync({ workspacePath, messages: [message], wc, source: 'app-control' })
    return outcome.ok ? { ok: true, runId: outcome.runId } : { ok: false, error: outcome.error }
  },
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
  return runAppAction(appDeps, name, args, ctx)
}
