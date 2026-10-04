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
  disposeAllPtySessions,
  killPty,
  listPtySessions,
  writeAgentTerminalMirror
} from '@main/app/ptySessions'
import {
  mirrorAgentCommandEnd,
  mirrorAgentCommandStart,
  mirrorAgentOutput
} from '@main/agent/tools/terminalMirror'
import {
  flushTerminalMirror,
  MIRROR_FLUSH_MS,
  setTerminalMirrorSink
} from '@main/agent/tools/terminalMirrorSink'

const WS = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const OTHER = process.platform === 'win32' ? 'C:\\other' : '/other'

/**
 * A chatty command — `pnpm test`, a log tail, `git log -p` — produces hundreds
 * of pipe reads a second. One IPC message per read asks the Terminal panel to
 * redraw hundreds of times a second for a panel that paints at 60Hz, so the
 * mirror batches: writes accumulate per workspace and leave on one flush.
 *
 * The contract that makes batching safe is the one these tests hold: whatever
 * the panel receives must be the same bytes, in the same order, however they
 * were split on the way in.
 */
describe('mirror writes are coalesced per workspace', () => {
  let sinkCalls: Array<{ workspacePath: string; text: string }>

  beforeEach(() => {
    sinkCalls = []
    setTerminalMirrorSink((workspacePath, text) => {
      sinkCalls.push({ workspacePath, text })
    })
  })

  afterEach(() => {
    setTerminalMirrorSink(null)
  })

  it('turns many chunks written in one tick into one send', () => {
    const chunks = Array.from({ length: 50 }, (_, i) => `line ${i}\n`)
    for (const chunk of chunks) mirrorAgentOutput(WS, chunk)
    flushTerminalMirror()

    expect(sinkCalls).toHaveLength(1)
    expect(sinkCalls[0]?.workspacePath).toBe(WS)
    expect(sinkCalls[0]?.text).toBe(chunks.join(''))
  })

  it('keeps a command end marker behind the output of that same command', () => {
    mirrorAgentCommandStart(WS, 'pnpm vitest run')
    mirrorAgentOutput(WS, 'chunk one\n')
    mirrorAgentOutput(WS, 'chunk two\n')
    mirrorAgentCommandEnd(
      WS,
      'pnpm vitest run',
      ['cwd: /ws', 'shell: cmd', '', 'ok', 'exit_code: 0'].join('\n')
    )
    flushTerminalMirror()

    expect(sinkCalls).toHaveLength(1)
    const text = sinkCalls[0]?.text ?? ''
    expect(text.indexOf('chunk one')).toBeGreaterThan(text.indexOf('pnpm vitest run'))
    expect(text.indexOf('chunk two')).toBeGreaterThan(text.indexOf('chunk one'))
    expect(text.indexOf('exit 0')).toBeGreaterThan(text.indexOf('chunk two'))
  })

  it('never lets one workspace write land in another workspace buffer', () => {
    mirrorAgentOutput(WS, 'a1\n')
    mirrorAgentOutput(OTHER, 'b1\n')
    mirrorAgentOutput(WS, 'a2\n')
    flushTerminalMirror()

    expect(sinkCalls).toEqual([
      { workspacePath: WS, text: 'a1\na2\n' },
      { workspacePath: OTHER, text: 'b1\n' }
    ])
  })

  it('sends a lone write on the flush timer, with no caller asking', async () => {
    mirrorAgentOutput(WS, 'tick\n')
    expect(sinkCalls).toHaveLength(0)

    await new Promise((r) => setTimeout(r, MIRROR_FLUSH_MS * 6))

    expect(sinkCalls).toEqual([{ workspacePath: WS, text: 'tick\n' }])
  })

  it('still ignores an empty chunk', () => {
    mirrorAgentOutput(WS, '')
    flushTerminalMirror()

    expect(sinkCalls).toHaveLength(0)
  })
})

describe('batched mirror IPC', () => {
  function withWindow(): void {
    hoisted.state.win = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: hoisted.send }
    }
  }

  function mirroredData(): string[] {
    return (
      hoisted.send.mock.calls
        .filter((call) => call[0] === IPC.ptyData)
        .map((call) => (call[1] as { data: string }).data)
    )
  }

  beforeEach(() => {
    flushTerminalMirror()
    hoisted.send.mockClear()
    withWindow()
    setTerminalMirrorSink(writeAgentTerminalMirror)
  })

  afterEach(() => {
    flushTerminalMirror()
    disposeAllPtySessions()
    hoisted.state.win = null
  })

  it('sends one ptyData message per burst instead of one per chunk', () => {
    const chunks = Array.from({ length: 50 }, (_, i) => `line ${i}\n`)
    for (const chunk of chunks) mirrorAgentOutput(WS, chunk)
    flushTerminalMirror()

    expect(mirroredData()).toHaveLength(1)
    expect(mirroredData()[0]).toBe(chunks.join(''))
    expect(listPtySessions(WS)).toHaveLength(1)
  })

  it('flushes pending bytes before disposing the mirror session', () => {
    const id = writeAgentTerminalMirror(WS, 'first\n')
    expect(id).toBeTruthy()

    mirrorAgentOutput(WS, 'pending\n')
    killPty(id!)

    // The buffered bytes went out while the session still existed; the flush
    // that would follow cannot resurrect a session whose workspace is done.
    expect(mirroredData().join('')).toBe('first\npending\n')
    expect(listPtySessions(WS)).toEqual([])
    flushTerminalMirror()
    expect(listPtySessions(WS)).toEqual([])
    expect(mirroredData().join('')).toBe('first\npending\n')
  })
})