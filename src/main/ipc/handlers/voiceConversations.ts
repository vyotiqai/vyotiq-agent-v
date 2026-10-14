import { ipcMain } from 'electron'
import { IPC } from '../../../shared/channels'
import {
  VoiceConversationReadRequestSchema,
  VoiceConversationsListRequestSchema,
  ok,
  fail,
  type IpcResult,
  type VoiceConversation,
  type VoiceConversationSummary
} from '../../../shared/ipc'
import { listVoiceConversations, readVoiceConversation } from '../../voice/conversationHistory'
import { voiceLogDir } from '../../voice/sessions'
import { failFrom, isOpenWorkspace, senderOk } from '../ipcShared'

/**
 * Kept voice conversations (docs/voice-mode.md §24.8): only an open
 * workspace's, and only from its voice folder. Registered once by registerIpc.
 */
export function registerVoiceConversationsIpc(): void {
  ipcMain.handle(IPC.voiceConversationsList, async (event, raw): Promise<IpcResult<VoiceConversationSummary[]>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = VoiceConversationsListRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      return ok(await listVoiceConversations(voiceLogDir(req.workspacePath)))
    } catch (err) {
      return failFrom(err, IPC.voiceConversationsList)
    }
  })

  ipcMain.handle(IPC.voiceConversationRead, async (event, raw): Promise<IpcResult<VoiceConversation>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = VoiceConversationReadRequestSchema.parse(raw)
      if (!isOpenWorkspace(req.workspacePath)) return fail('Workspace is not open')
      const conversation = await readVoiceConversation(voiceLogDir(req.workspacePath), req.id)
      return conversation ? ok(conversation) : fail('That voice conversation is no longer kept')
    } catch (err) {
      return failFrom(err, IPC.voiceConversationRead)
    }
  })
}
