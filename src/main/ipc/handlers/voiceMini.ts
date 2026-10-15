import { ipcMain } from 'electron'
import { IPC } from '../../../shared/channels'
import { VoiceMiniCommandSchema, VoiceMiniLevelSchema, VoiceMiniOpenSchema, VoiceMiniResizeSchema, VoiceMiniStateSchema, ok, fail, type IpcResult } from '../../../shared/ipc'
import {
  closeVoiceMiniWindow,
  openVoiceMiniWindow,
  pushVoiceMiniLevel,
  pushVoiceMiniState,
  replayVoiceMiniState,
  resizeVoiceMiniWindow,
  sendToMain,
  senderIsVoiceMini,
  showMainWindow
} from '../../app/voiceMiniWindow'
import { failFrom, senderOk } from '../ipcShared'

/** A mirrored state is small (a capped transcript); anything far past this is not ours. */
const MAX_STATE_BYTES = 512 * 1024

/**
 * The voice mini window's channels (docs/voice-mode.md §26.5). Each direction
 * has one sender: the main window opens it and pushes its state; the mini
 * window sends clicks, its size and "show the app". Every payload is parsed.
 * Registered once by registerIpc.
 */
export function registerVoiceMiniIpc(): void {
  ipcMain.handle(IPC.voiceMiniOpen, async (event, raw): Promise<IpcResult<boolean>> => {
    if (!senderOk(event)) return fail('Invalid sender')
    try {
      const req = VoiceMiniOpenSchema.parse(raw)
      if (req.open) openVoiceMiniWindow()
      else closeVoiceMiniWindow()
      return ok(true)
    } catch (err) {
      return failFrom(err, IPC.voiceMiniOpen)
    }
  })

  // Hot paths (a state per change, a level ~20 a second): no logging, no throw.
  ipcMain.on(IPC.voiceMiniPushState, (event, raw) => {
    if (!senderOk(event)) return
    const parsed = VoiceMiniStateSchema.safeParse(raw)
    if (!parsed.success) return
    if (JSON.stringify(parsed.data).length > MAX_STATE_BYTES) return
    pushVoiceMiniState(parsed.data)
  })

  ipcMain.on(IPC.voiceMiniPushLevel, (event, raw) => {
    if (!senderOk(event)) return
    const parsed = VoiceMiniLevelSchema.safeParse(raw)
    if (parsed.success) pushVoiceMiniLevel(parsed.data)
  })

  ipcMain.on(IPC.voiceMiniSendCommand, (event, raw) => {
    if (!senderIsVoiceMini(event)) return
    const parsed = VoiceMiniCommandSchema.safeParse(raw)
    // 'closed' is main's own word, never the window's.
    if (!parsed.success || parsed.data.kind === 'closed') return
    if (parsed.data.kind === 'ready') return replayVoiceMiniState()
    sendToMain(parsed.data)
  })

  ipcMain.on(IPC.voiceMiniResize, (event, raw) => {
    if (!senderIsVoiceMini(event)) return
    const parsed = VoiceMiniResizeSchema.safeParse(raw)
    if (parsed.success) resizeVoiceMiniWindow(parsed.data.open)
  })

  ipcMain.on(IPC.voiceMiniShowApp, (event) => {
    if (senderIsVoiceMini(event)) showMainWindow()
  })
}
