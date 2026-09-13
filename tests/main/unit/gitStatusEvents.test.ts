import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getMainWindow } from '@main/app/window'
import { emitGitStatusChanged } from '@main/git/gitStatusEvents'
import { IPC } from '@shared/channels'
import { GitStatusChangedPayloadSchema } from '@shared/ipc'

const { mockSend, mockWin } = vi.hoisted(() => {
  const mockSend = vi.fn()
  const mockWin = {
    isDestroyed: vi.fn((): boolean => false),
    webContents: {
      isDestroyed: vi.fn((): boolean => false),
      send: mockSend
    }
  }
  return { mockSend, mockWin }
})

vi.mock('@main/app/window', () => ({
  getMainWindow: vi.fn(() => mockWin as unknown as ReturnType<typeof getMainWindow>)
}))

describe('emitGitStatusChanged', () => {
  beforeEach(() => {
    mockSend.mockClear()
    mockWin.isDestroyed.mockReturnValue(false)
    mockWin.webContents.isDestroyed.mockReturnValue(false)
    vi.mocked(getMainWindow).mockReturnValue(mockWin as unknown as ReturnType<typeof getMainWindow>)
  })

  it('sends a schema-valid payload identifying the workspace', () => {
    emitGitStatusChanged('C:/workspaces/demo')

    expect(mockSend).toHaveBeenCalledTimes(1)
    const [channel, payload] = mockSend.mock.calls[0] as [string, unknown]
    expect(channel).toBe(IPC.gitStatusChanged)
    const parsed = GitStatusChangedPayloadSchema.safeParse(payload)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toEqual({ workspacePath: 'C:/workspaces/demo' })
  })

  it('is a no-op when no window is live', () => {
    vi.mocked(getMainWindow).mockReturnValue(undefined as unknown as ReturnType<typeof getMainWindow>)

    emitGitStatusChanged('C:/workspaces/demo')

    expect(mockSend).not.toHaveBeenCalled()
  })

  it('is a no-op when the window is destroyed', () => {
    mockWin.isDestroyed.mockReturnValue(true)

    emitGitStatusChanged('C:/workspaces/demo')

    expect(mockSend).not.toHaveBeenCalled()
  })

  it('is a no-op when webContents are destroyed', () => {
    mockWin.webContents.isDestroyed.mockReturnValue(true)

    emitGitStatusChanged('C:/workspaces/demo')

    expect(mockSend).not.toHaveBeenCalled()
  })
})
