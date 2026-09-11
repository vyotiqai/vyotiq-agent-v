import { IPC } from '../../shared/channels'
import type { GitStatusChangedPayload } from '../../shared/ipc'
import { getMainWindow } from '../app/window'

/**
 * Push a git-status-changed event to the renderer after a workspace's git
 * status may have changed (commit, stage/unstage, agent write resolution).
 * No-op without a live window; subscribers re-pull a fresh snapshot via
 * IPC.gitStatus, so the payload only identifies the workspace.
 */
export function emitGitStatusChanged(workspacePath: string): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  const payload: GitStatusChangedPayload = { workspacePath }
  win.webContents.send(IPC.gitStatusChanged, payload)
}
