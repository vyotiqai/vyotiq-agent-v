import { ipcMain } from 'electron'
import { IPC } from '../../../shared/channels'
import {
  PromptStructureCancelRequestSchema,
  PromptStructureRequestSchema,
  ok,
  fail,
  type IpcResult,
  type PromptStructureResult
} from '../../../shared/ipc'
import { cancelPromptStructure, structurePrompt } from '@main/agent/promptStructure'
import { failFrom, isOpenWorkspace, senderOk } from '../ipcShared'

/** Structure: the composer's instruction rewritten as a brief. Registered once by registerIpc. */
export function registerPromptIpc(): void {
  ipcMain.handle(IPC.promptStructure, async (event, raw): Promise<IpcResult<PromptStructureResult>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PromptStructureRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await structurePrompt(req))
    } catch (err) {
      return failFrom(err, IPC.promptStructure)
    }
  })

  ipcMain.handle(IPC.promptStructureCancel, async (event, raw): Promise<IpcResult<{ cancelled: boolean }>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = PromptStructureCancelRequestSchema.parse(raw)
      return ok({ cancelled: cancelPromptStructure(req.requestId) })
    } catch (err) {
      return failFrom(err, IPC.promptStructureCancel)
    }
  })
}
