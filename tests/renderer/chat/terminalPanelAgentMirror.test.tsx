/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TerminalPanel } from '@renderer/features/chat/components/TerminalPanel'
import { commandProgram } from '@renderer/features/chat/components/TerminalSessionBar'
import type { PtySessionInfo } from '@shared/ipc'

type CapturedTerm = {
  options: Record<string, unknown>
  emitData: (data: string) => void
}

const termMocks = vi.hoisted(() => [] as CapturedTerm[])

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    private dataHandler: ((data: string) => void) | null = null
    constructor(options: Record<string, unknown>) {
      this.options = { ...options }
      termMocks.push(this as unknown as CapturedTerm)
    }
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    write(): void {}
    writeln(): void {}
    dispose(): void {}
    attachCustomKeyEventHandler(): void {}
    hasSelection(): boolean {
      return false
    }
    getSelection(): string {
      return ''
    }
    onData(handler: (data: string) => void): { dispose: () => void } {
      this.dataHandler = handler
      return { dispose: () => undefined }
    }
    emitData(data: string): void {
      this.dataHandler?.(data)
    }
  }
}))

vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

const shellSession: PtySessionInfo = {
  id: 'shell-1',
  title: 'cmd',
  cwd: '/ws',
  running: true,
  backend: 'pty'
}

const mirrorSession: PtySessionInfo = {
  id: 'mirror-1',
  title: 'agent',
  cwd: '/ws',
  running: true,
  backend: 'agent'
}

function installApi(overrides: Record<string, unknown> = {}) {
  const api = {
    ptyList: vi.fn().mockResolvedValue({ ok: true, data: [] as PtySessionInfo[] }),
    ptyCreate: vi.fn().mockResolvedValue({ ok: true, data: shellSession }),
    ptyKill: vi.fn().mockResolvedValue({ ok: true, data: true }),
    ptyWrite: vi.fn().mockResolvedValue({ ok: true, data: true }),
    ptyResize: vi.fn().mockResolvedValue({ ok: true, data: true }),
    onPtyData: vi.fn().mockReturnValue(() => undefined),
    onPtyExit: vi.fn().mockReturnValue(() => undefined),
    onPtySessionsChanged: vi.fn().mockReturnValue(() => undefined),
    ...overrides
  }
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: api
  })
  return api
}

beforeEach(() => {
  termMocks.length = 0
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal(
    'requestAnimationFrame',
    (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0) as unknown as number
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('TerminalPanel renders the agent mirror as a read-only session', () => {
  it('builds the mirror terminal with stdin disabled and no cursor', async () => {
    installApi({
      ptyList: vi.fn().mockResolvedValue({ ok: true, data: [mirrorSession] })
    })
    render(<TerminalPanel workspacePath="/ws" visible />)

    await waitFor(() => expect(termMocks.length).toBeGreaterThan(0))
    expect(termMocks[0]?.options.disableStdin).toBe(true)
    expect(termMocks[0]?.options.cursorBlink).toBe(false)
  })

  it('never forwards keystrokes typed into the mirror', async () => {
    const api = installApi({
      ptyList: vi.fn().mockResolvedValue({ ok: true, data: [mirrorSession] })
    })
    render(<TerminalPanel workspacePath="/ws" visible />)

    await waitFor(() => expect(termMocks.length).toBeGreaterThan(0))
    termMocks[0]?.emitData('rm -rf /\r')
    expect(api.ptyWrite).not.toHaveBeenCalled()
  })

  /**
   * `createSession` sets activeId to the new session before the next list
   * arrives, so for one render activeId names a session the panel has not
   * listed yet. A read-only check keyed on activeId reads false there and the
   * still-mounted mirror starts forwarding its keystrokes — under its own id.
   */
  it('keeps the mirror read-only while activeId points at an unlisted session', async () => {
    const api = installApi({
      ptyList: vi.fn().mockResolvedValue({ ok: true, data: [mirrorSession] })
    })
    render(<TerminalPanel workspacePath="/ws" visible />)

    await waitFor(() => expect(termMocks.length).toBeGreaterThan(0))
    // Auto-create resolves with a shell the list never reports, which is what
    // leaves activeId and sessions disagreeing.
    await waitFor(() => expect(api.ptyCreate).toHaveBeenCalled())
    await waitFor(() => expect(api.ptyList.mock.calls.length).toBeGreaterThan(1))

    termMocks[0]?.emitData('rm -rf /\r')
    expect(api.ptyWrite).not.toHaveBeenCalled()
  })

  it('still forwards keystrokes for a real shell session', async () => {
    const api = installApi({
      ptyList: vi.fn().mockResolvedValue({ ok: true, data: [shellSession] })
    })
    render(<TerminalPanel workspacePath="/ws" visible />)

    await waitFor(() => expect(termMocks.length).toBeGreaterThan(0))
    expect(termMocks[0]?.options.disableStdin).toBe(false)
    termMocks[0]?.emitData('echo hi\r')
    expect(api.ptyWrite).toHaveBeenCalledWith('shell-1', 'echo hi\r', '/ws')
  })

  it('re-lists when the session set changes, so a mid-run mirror appears', async () => {
    let fire: (() => void) | null = null
    const ptyList = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: [shellSession] })
      .mockResolvedValue({ ok: true, data: [shellSession, mirrorSession] })
    installApi({
      ptyList,
      onPtySessionsChanged: vi.fn((handler: () => void) => {
        fire = handler
        return () => undefined
      })
    })

    render(<TerminalPanel workspacePath="/ws" visible />)
    await waitFor(() => expect(ptyList).toHaveBeenCalled())
    const before = ptyList.mock.calls.length

    expect(fire).toBeTruthy()
    fire?.()
    await waitFor(() => expect(ptyList.mock.calls.length).toBeGreaterThan(before))
  })

  it('still opens a real shell when only the read-only mirror exists', async () => {
    const api = installApi({
      ptyList: vi.fn().mockResolvedValue({ ok: true, data: [mirrorSession] })
    })
    render(<TerminalPanel workspacePath="/ws" visible />)
    await waitFor(() => expect(api.ptyCreate).toHaveBeenCalled())
  })

  it('does not open a second shell when a real one is already listed', async () => {
    const api = installApi({
      ptyList: vi.fn().mockResolvedValue({ ok: true, data: [shellSession, mirrorSession] })
    })
    render(<TerminalPanel workspacePath="/ws" visible />)
    await waitFor(() => expect(termMocks.length).toBeGreaterThan(0))
    expect(api.ptyCreate).not.toHaveBeenCalled()
  })
})

describe('TerminalPanel says what the agent is running', () => {
  it('names the program on the agent tab with a live dot, and times it in the status bar', async () => {
    installApi({ ptyList: vi.fn().mockResolvedValue({ ok: true, data: [mirrorSession, shellSession] }) })
    const at = new Date(Date.now() - 41_000).toISOString()
    render(<TerminalPanel workspacePath="/ws" visible agentCommand="pnpm vitest run tests/main" agentCommandAt={at} />)

    const agentTab = await screen.findByRole('tab', { name: /^Agent · vitest/ })
    expect(agentTab.textContent).toContain('working now')
    expect(screen.getByRole('tab', { name: 'cmd' })).toBeTruthy()
    await waitFor(() => {
      expect(document.querySelector('[data-terminal-status]')?.textContent).toMatch(/running · 4\ds/)
    })
  })

  it('shows the agent tab still when nothing runs, without a dot', async () => {
    installApi({ ptyList: vi.fn().mockResolvedValue({ ok: true, data: [mirrorSession, shellSession] }) })
    render(<TerminalPanel workspacePath="/ws" visible />)
    const agentTab = await screen.findByRole('tab', { name: 'Agent' })
    expect(agentTab.textContent).not.toContain('working now')
    expect(document.querySelector('[data-terminal-status]')?.textContent).not.toContain('running')
  })

  it('says the agent session is read-only and opens a shell beside it', async () => {
    const api = installApi({ ptyList: vi.fn().mockResolvedValue({ ok: true, data: [mirrorSession, shellSession] }) })
    render(<TerminalPanel workspacePath="/ws" visible />)
    expect(await screen.findByText('Agent session · read-only')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open a shell here' }))
    await waitFor(() => expect(api.ptyCreate).toHaveBeenCalled())
  })

  it('puts the shell and the workspace in the status bar of a shell session', async () => {
    installApi({ ptyList: vi.fn().mockResolvedValue({ ok: true, data: [shellSession] }) })
    render(<TerminalPanel workspacePath="/ws/my-project" visible />)
    await waitFor(() => {
      expect(document.querySelector('[data-terminal-status]')?.textContent).toContain('cmd · my-project')
    })
    expect(screen.queryByText('Agent session · read-only')).toBeNull()
  })
})

describe('commandProgram', () => {
  it.each([
    ['pnpm vitest run tests/x', 'vitest'],
    ['npm run test', 'test'],
    ['npx tsc -p tsconfig.json', 'tsc'],
    ['git status --short', 'git'],
    ['FOO=1 node a.js', 'node'],
    [String.raw`C:\tools\rg.exe needle`, 'rg'],
    ['pnpm', 'pnpm']
  ])('%s → %s', (command, program) => {
    expect(commandProgram(command)).toBe(program)
  })
})
