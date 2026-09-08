import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { IPC } from '@shared/channels'

/**
 * Every invoke channel in the IPC catalog must have a matching ipcMain
 * registration — a channel without a handler fails only when a renderer
 * calls it, which is too late. Push-only channels (main → renderer events)
 * must stay unhandled.
 */
const PUSH_ONLY = new Set<keyof typeof IPC>([
  'chatEvent',
  'toolApprovalRequest',
  'agentQuestionRequest',
  'browserState',
  'windowMaximizedChanged',
  'windowFocusChanged',
  'ptyData',
  'ptyExit',
  'themeChanged',
  'githubAuthStatusEvent',
  'codeIndexStatusEvent',
  'dictationStatusEvent',
  'skillsChanged',
  'workspaceEditorFlushRequest',
  'workspaceEditorFlushResponse',
  'notificationsChanged',
  'notificationsActivate',
  'appearanceCustomCssChanged',
  'updaterState',
  'accessibilitySupportChanged'
])

function registeredChannels(): Set<string> {
  const src = readFileSync(join(process.cwd(), 'src/main/ipc/register.ts'), 'utf8')
  return new Set(
    [...src.matchAll(/ipcMain\.(?:handle|on)\(\s*IPC\.(\w+)/g)].map((m) => m[1]!)
  )
}

describe('IPC channel parity', () => {
  it('registers a handler for every invoke channel', () => {
    const handled = registeredChannels()
    const missing = Object.keys(IPC).filter(
      (name) => !PUSH_ONLY.has(name as keyof typeof IPC) && !handled.has(name)
    )
    expect(missing).toEqual([])
  })

  it('does not register handlers for push-only event channels', () => {
    const handled = registeredChannels()
    const wrong = [...PUSH_ONLY].filter((name) => handled.has(name))
    expect(wrong).toEqual([])
  })
})
