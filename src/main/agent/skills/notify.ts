import { BrowserWindow } from 'electron'
import { IPC } from '../../../shared/ipc/channels'
import { invalidateSlashCommandsCache } from '../slashCommands/listCache'
import { clearLocalSkillsCache } from './local'

export type SkillsChangedPayload = {
  workspacePath: string | null
}

/** Drop slash + local-skill caches and tell the renderer to refetch. */
export function notifySkillsChanged(workspacePath?: string | null): void {
  if (workspacePath === undefined) {
    invalidateSlashCommandsCache()
    clearLocalSkillsCache()
  } else {
    invalidateSlashCommandsCache(workspacePath)
    clearLocalSkillsCache(workspacePath)
  }

  const payload: SkillsChangedPayload = { workspacePath: workspacePath ?? null }
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send(IPC.skillsChanged, payload)
    }
  } catch {
    // Tests and headless main may not provide BrowserWindow.
  }
}
