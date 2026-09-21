import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => {
  const send = vi.fn()
  const state: { win: unknown } = { win: null }
  return { send, state }
})

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({ terminalShell: 'cmd' })
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => hoisted.state.win
}))

import { IPC } from '@shared/ipc/channels'
import {
  agentMirrorSessionId,
  disposeAllPtySessions,
  listPtySessions,
  killPty,
  resizePty,
  writeAgentTerminalMirror,
  writePty
} from '@main/app/ptySessions'
import {
  mirrorAgentCommandAborted,
  mirrorAgentCommandEnd,
  mirrorAgentCommandStart,
  mirrorAgentOutput
} from '@main/agent/tools/terminalMirror'

const WS = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const OTHER = process.platform === 'win32' ? 'C:\\other' : '/other'

function withWindow(): void {
  hoisted.state.win = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: hoisted.send }
  }
}

function sentOn(channel: string): unknown[] {
  return hoisted.send.mock.calls.filter((call) => call[0] === channel).map((call) => call[1])
}

function mirroredText(): string {
  return (sentOn(IPC.ptyData) as Array<{ data: string }>).map((p) => p.data).join('')
}

beforeEach(() => {
  hoisted.send.mockClear()
  withWindow()
})

afterEach(() => {
  disposeAllPtySessions()
  hoisted.state.win = null
})

describe('writeAgentTerminalMirror', () => {
  it('creates one read-only session and announces it', () => {
    const id = writeAgentTerminalMirror(WS, 'hello\n')
    expect(id).toBeTruthy()

    const sessions = listPtySessions(WS)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.backend).toBe('agent')
    expect(sessions[0]?.title).toBe('agent')
    expect(sentOn(IPC.ptySessionsChanged)).toHaveLength(1)
    expect(mirroredText()).toBe('hello\n')
  })

  it('reuses the session on later writes and announces only once', () => {
    const first = writeAgentTerminalMirror(WS, 'one\n')
    const second = writeAgentTerminalMirror(WS, 'two\n')
    expect(second).toBe(first)
    expect(listPtySessions(WS)).toHaveLength(1)
    expect(sentOn(IPC.ptySessionsChanged)).toHaveLength(1)
    expect(mirroredText()).toBe('one\ntwo\n')
  })

  it('keeps one mirror per workspace', () => {
    writeAgentTerminalMirror(WS, 'a\n')
    writeAgentTerminalMirror(OTHER, 'b\n')
    expect(listPtySessions(WS)).toHaveLength(1)
    expect(listPtySessions(OTHER)).toHaveLength(1)
    expect(agentMirrorSessionId(WS)).not.toBe(agentMirrorSessionId(OTHER))
  })

  it('does nothing without a main window — there is nothing to mirror to', () => {
    hoisted.state.win = null
    expect(writeAgentTerminalMirror(WS, 'hello\n')).toBeNull()
    expect(listPtySessions(WS)).toEqual([])
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('ignores empty text and a missing workspace', () => {
    expect(writeAgentTerminalMirror(WS, '')).toBeNull()
    expect(writeAgentTerminalMirror('', 'x')).toBeNull()
    expect(listPtySessions()).toEqual([])
  })
})

describe('the mirror is not a shell', () => {
  it('refuses writes — nothing is listening on the other end', () => {
    const id = writeAgentTerminalMirror(WS, 'hello\n')
    expect(id).toBeTruthy()
    expect(writePty(id!, 'rm -rf /\n', WS)).toBe(false)
  })

  it('refuses resize', () => {
    const id = writeAgentTerminalMirror(WS, 'hello\n')
    expect(resizePty(id!, 80, 24, WS)).toBe(false)
  })

  it('closes without trying to kill a process', () => {
    const id = writeAgentTerminalMirror(WS, 'hello\n')
    expect(() => killPty(id!)).not.toThrow()
    expect(listPtySessions(WS)).toEqual([])
    expect(agentMirrorSessionId(WS)).toBeNull()
  })
})

describe('mirrored command framing', () => {
  it('writes a header naming the command', () => {
    mirrorAgentCommandStart(WS, 'pnpm vitest run')
    expect(mirroredText()).toContain('pnpm vitest run')
    expect(mirroredText()).toContain('agent')
  })

  it('notes a working directory that differs from the workspace root', () => {
    const sub = `${WS}${process.platform === 'win32' ? '\\' : '/'}packages`
    mirrorAgentCommandStart(WS, 'ls', sub)
    expect(mirroredText()).toContain(sub)
  })

  it('omits the directory when it is the workspace root', () => {
    mirrorAgentCommandStart(WS, 'ls', WS)
    expect(mirroredText()).not.toContain(`(${WS})`)
  })

  it('flattens a multi-line command onto one header line', () => {
    mirrorAgentCommandStart(WS, 'echo one\necho two')
    const header = mirroredText().trim()
    expect(header).toContain('echo one echo two')
  })

  it('truncates a very long command', () => {
    mirrorAgentCommandStart(WS, 'x'.repeat(5_000))
    expect(mirroredText()).toContain('…')
    expect(mirroredText().length).toBeLessThan(2_200)
  })

  it('stays silent for a session poll, which carries no command', () => {
    mirrorAgentCommandStart(WS, '')
    mirrorAgentCommandEnd(WS, '   ', 'exit_code: 0')
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('reports the exit code the model was given', () => {
    const frame = ['cwd: /ws', 'shell: cmd', '', 'hello', 'exit_code: 0'].join('\n')
    mirrorAgentCommandEnd(WS, 'echo hello', frame)
    expect(mirroredText()).toContain('exit 0')
  })

  it('reports a non-zero exit code', () => {
    const frame = ['cwd: /ws', 'shell: cmd', '', 'stderr:\nboom', 'exit_code: 2'].join('\n')
    mirrorAgentCommandEnd(WS, 'false', frame)
    expect(mirroredText()).toContain('exit 2')
  })

  it('falls back to a blank line when the frame carries no exit code', () => {
    mirrorAgentCommandEnd(WS, 'echo hi', 'no frame here')
    expect(mirroredText()).toBe('\n')
  })

  it('records why a command ended without a frame', () => {
    mirrorAgentCommandAborted(WS, 'sleep 100', 'Command timed out after 1000ms')
    expect(mirroredText()).toContain('Command timed out after 1000ms')
  })

  it('passes output through byte for byte', () => {
    mirrorAgentOutput(WS, 'line one\nline two\n')
    expect(mirroredText()).toBe('line one\nline two\n')
  })

  it('ignores an empty output chunk', () => {
    mirrorAgentOutput(WS, '')
    expect(hoisted.send).not.toHaveBeenCalled()
  })
})
