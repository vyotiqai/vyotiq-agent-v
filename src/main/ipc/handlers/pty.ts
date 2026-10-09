import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../../shared/channels'
import {
  PtyCreateRequestSchema,
  PtyListRequestSchema,
  PtyIdRequestSchema,
  PtyRenameRequestSchema,
  PtyWriteRequestSchema,
  PtyResizeRequestSchema,
  ok,
  fail
} from '../../../shared/ipc'
import {
  createPtySession,
  killPty,
  renamePty,
  listPtySessions,
  resizePty,
  writePty
} from '@main/app/ptySessions'
import { failFrom, isOpenWorkspace, senderOk } from '../ipcShared'

/** The terminal panel's own shells. Registered once by registerIpc. */
export function registerPtyIpc(): void {
  ipcMain.handle(IPC.ptyCreate, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PtyCreateRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return fail('No window')
      return ok(
        createPtySession({
          cwd: req.workspacePath,
          cols: req.cols,
          rows: req.rows,
          shell: req.shell,
          sendTo: win
        })
      )
    } catch (err) {
      return failFrom(err, IPC.ptyCreate)
    }
  })

  ipcMain.handle(IPC.ptyList, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PtyListRequestSchema.parse(raw ?? {})
      if (req.workspacePath && !isOpenWorkspace(req.workspacePath)) {
        return fail('Workspace is not open')
      }
      // Never disclose sessions (cwd paths) of workspaces that are not open.
      return ok(listPtySessions(req.workspacePath, (path) => isOpenWorkspace(path)))
    } catch (err) {
      return failFrom(err, IPC.ptyList)
    }
  })

  ipcMain.handle(IPC.ptyWrite, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PtyWriteRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(writePty(req.id, req.data, req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.ptyWrite)
    }
  })

  ipcMain.handle(IPC.ptyResize, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PtyResizeRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(resizePty(req.id, req.cols, req.rows, req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.ptyResize)
    }
  })

  ipcMain.handle(IPC.ptyKill, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PtyIdRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(killPty(req.id, req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.ptyKill)
    }
  })

  ipcMain.handle(IPC.ptyRename, async (event, raw) => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PtyRenameRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(renamePty(req.id, req.title, req.workspacePath))
    } catch (err) {
      return failFrom(err, IPC.ptyRename)
    }
  })
}
