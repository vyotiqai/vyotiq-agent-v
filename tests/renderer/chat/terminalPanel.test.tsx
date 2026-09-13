/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { TerminalPanel } from '@renderer/features/chat/components/TerminalPanel'
import type { PtySessionInfo } from '@shared/ipc'

type CapturedTerm = {
  handler: ((event: KeyboardEvent) => boolean) | null
  hasSelection: () => boolean
  getSelection: () => string
}

const termMocks = vi.hoisted(() => [] as CapturedTerm[])

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    handler: ((event: KeyboardEvent) => boolean) | null = null
    selection = false
    constructor() {
      termMocks.push(this)
    }
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    write(): void {}
    writeln(): void {}
    dispose(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => undefined }
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      this.handler = handler
    }
    hasSelection(): boolean {
      return this.selection
    }
    getSelection(): string {
      return 'selected output'
    }
  }
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  }
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {}
}))

const session: PtySessionInfo = {
  id: 'sess-1',
  title: 'cmd',
  cwd: '/ws',
  running: true,
  backend: 'pty'
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

describe('TerminalPanel', () => {
  it('renders session tabs inline when no dock host is provided', async () => {
    const ptyList = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: [] as PtySessionInfo[] })
      .mockResolvedValue({ ok: true, data: [session] })
    const ptyCreate = vi.fn().mockResolvedValue({ ok: true, data: session })

    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ptyList,
        ptyCreate,
        ptyKill: vi.fn().mockResolvedValue({ ok: true, data: true }),
        ptyWrite: vi.fn().mockResolvedValue({ ok: true, data: true }),
        ptyResize: vi.fn().mockResolvedValue({ ok: true, data: true }),
        onPtyData: vi.fn().mockReturnValue(() => undefined),
        onPtyExit: vi.fn().mockReturnValue(() => undefined)
      }
    })

    render(<TerminalPanel workspacePath="/ws" visible />)

    await waitFor(() => {
      expect(document.querySelector('[data-pty-host]')).toBeTruthy()
    })
    expect(screen.queryByText('No terminal')).toBeNull()
    expect(ptyCreate).toHaveBeenCalled()
    expect(document.querySelector('[data-terminal-session-bar]')).toBeTruthy()
  })

  it('portals session tabs to a dock host instead of rendering an inline bar', async () => {
    const ptyList = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: [] as PtySessionInfo[] })
      .mockResolvedValue({ ok: true, data: [session] })
    const ptyCreate = vi.fn().mockResolvedValue({ ok: true, data: session })

    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ptyList,
        ptyCreate,
        ptyKill: vi.fn().mockResolvedValue({ ok: true, data: true }),
        ptyWrite: vi.fn().mockResolvedValue({ ok: true, data: true }),
        ptyResize: vi.fn().mockResolvedValue({ ok: true, data: true }),
        onPtyData: vi.fn().mockReturnValue(() => undefined),
        onPtyExit: vi.fn().mockReturnValue(() => undefined)
      }
    })

    function HostHarness() {
      const hostRef = useRef<HTMLDivElement>(null)
      return (
        <div>
          <div ref={hostRef} data-terminal-session-bar-host />
          <TerminalPanel workspacePath="/ws" visible sessionBarHostRef={hostRef} />
        </div>
      )
    }

    render(<HostHarness />)

    await waitFor(() => {
      expect(document.querySelector('[data-terminal-session-bar-host] [data-terminal-session-bar]')).toBeTruthy()
    })
    expect(document.querySelector('[data-terminal-panel] [data-terminal-session-bar]')).toBeNull()
  })

  it('surfaces ptyCreate failure as an error banner', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ptyList: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        ptyCreate: vi.fn().mockResolvedValue({ ok: false, error: 'spawn failed' }),
        ptyKill: vi.fn().mockResolvedValue({ ok: true, data: true }),
        ptyWrite: vi.fn().mockResolvedValue({ ok: true, data: true }),
        ptyResize: vi.fn().mockResolvedValue({ ok: true, data: true }),
        onPtyData: vi.fn().mockReturnValue(() => undefined),
        onPtyExit: vi.fn().mockReturnValue(() => undefined)
      }
    })

    render(<TerminalPanel workspacePath="/ws" visible />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('spawn failed')
    expect(document.querySelector('[data-terminal-error]')).toBeTruthy()
    expect(screen.getByText('No terminal')).toBeTruthy()
  })

  it('shows empty-state copy when no workspace is open', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ptyList: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        ptyCreate: vi.fn(),
        onPtyData: vi.fn().mockReturnValue(() => undefined),
        onPtyExit: vi.fn().mockReturnValue(() => undefined)
      }
    })

    render(<TerminalPanel workspacePath={null} visible />)

    expect(await screen.findByText('No terminal')).toBeTruthy()
    expect(screen.getByText(/Open a workspace to start an interactive shell/i)).toBeTruthy()
    expect(window.vyotiq.ptyCreate).not.toHaveBeenCalled()
  })

  it('keeps split panes when selecting the secondary session', async () => {
    const sessA: PtySessionInfo = {
      id: 'a',
      title: 'Shell A',
      cwd: '/ws',
      running: true,
      backend: 'pty'
    }
    const sessB: PtySessionInfo = {
      id: 'b',
      title: 'Shell B',
      cwd: '/ws',
      running: true,
      backend: 'pty'
    }
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ptyList: vi.fn().mockResolvedValue({ ok: true, data: [sessA, sessB] }),
        ptyCreate: vi.fn(),
        ptyKill: vi.fn().mockResolvedValue({ ok: true, data: true }),
        ptyWrite: vi.fn().mockResolvedValue({ ok: true, data: true }),
        ptyResize: vi.fn().mockResolvedValue({ ok: true, data: true }),
        onPtyData: vi.fn().mockReturnValue(() => undefined),
        onPtyExit: vi.fn().mockReturnValue(() => undefined)
      }
    })

    render(<TerminalPanel workspacePath="/ws" visible />)

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Shell A/i })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: /Split terminal/i }))
    await waitFor(() => {
      expect(document.querySelectorAll('[data-pty-host]').length).toBe(2)
    })
    fireEvent.click(screen.getByRole('tab', { name: /Shell B/i }))
    await waitFor(() => {
      expect(document.querySelectorAll('[data-pty-host]').length).toBe(2)
    })
  })

  it('copies the selection on Ctrl+C instead of sending ^C', async () => {
    const writeClipboard = vi.fn(() => true)
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ptyList: vi
          .fn()
          .mockResolvedValueOnce({ ok: true, data: [] as PtySessionInfo[] })
          .mockResolvedValue({ ok: true, data: [session] }),
        ptyCreate: vi.fn().mockResolvedValue({ ok: true, data: session }),
        ptyKill: vi.fn().mockResolvedValue({ ok: true, data: true }),
        ptyWrite: vi.fn().mockResolvedValue({ ok: true, data: true }),
        ptyResize: vi.fn().mockResolvedValue({ ok: true, data: true }),
        onPtyData: vi.fn().mockReturnValue(() => undefined),
        onPtyExit: vi.fn().mockReturnValue(() => undefined),
        writeClipboard
      }
    })

    render(<TerminalPanel workspacePath="/ws" visible />)

    await waitFor(() => {
      expect(document.querySelector('[data-pty-host]')).toBeTruthy()
    })
    const term = termMocks[termMocks.length - 1] as CapturedTerm & { selection: boolean }
    expect(term.handler).toBeTypeOf('function')

    const ctrlC = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true })
    // Without a selection, Ctrl+C flows through to the shell.
    expect(term.handler!(ctrlC)).toBe(true)
    expect(writeClipboard).not.toHaveBeenCalled()

    // With a selection, Ctrl+C copies and swallows the keypress.
    term.selection = true
    expect(term.handler!(ctrlC)).toBe(false)
    await waitFor(() => {
      expect(writeClipboard).toHaveBeenCalledWith('selected output')
    })

    // Other chords always flow through.
    term.selection = true
    expect(
      term.handler!(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true }))
    ).toBe(true)
    expect(term.handler!(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))).toBe(true)
    expect(term.handler!(new KeyboardEvent('keyup', { key: 'c', ctrlKey: true }))).toBe(true)
  })
})
