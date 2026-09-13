import { BrowserWindow } from 'electron'
import { assertInsideWorkspace } from '../../shared/workspacePath'
import { addWorkspace } from './workspaces'

export { assertInsideWorkspace }

export async function pickWorkspace(win: BrowserWindow | null): Promise<string | null> {
  const state = await addWorkspace(win)
  return state.activePath
}
