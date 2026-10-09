/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TerminalPanel } from '@renderer/features/chat/components/TerminalPanel'
import {
  ASK_OUTPUT_MAX_LINES,
  askAboutOutputInstruction,
  bufferText,
  findInLines
} from '@renderer/features/chat/components/terminalBuffer'
import type { PtySessionInfo } from '@shared/ipc'

/** The terminal's own find, copy, clear, rename, shell choice and "ask the agent". */

type FakeTerm = {
  lines: string[]
  selected: { col: number; row: number; length: number } | null
  cleared: number
  handler: ((event: KeyboardEvent) => boolean) | null
}

const terms = vi.hoisted(() => [] as FakeTerm[])
const copied = vi.hoisted(() => [] as string[])

vi.mock('@renderer/lib/markdown/copyText', () => ({
  copyText: async (text: string) => {
    copied.push(text)
    return true
  }
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 10
    options: Record<string, unknown> = {}
    lines = ['PS C:\\ws> pnpm test', 'Error: cannot find module x', 'done', 'PS C:\\ws> ', '']
    selected: { col: number; row: number; length: number } | null = null
    cleared = 0
    handler: ((event: KeyboardEvent) => boolean) | null = null
    constructor() {
      terms.push(this as unknown as FakeTerm)
    }
    get buffer() {
      const lines = this.lines
      return { active: { length: lines.length, getLine: (i: number) => ({ translateToString: () => lines[i] ?? '' }) } }
    }
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    write(): void {}
    writeln(): void {}
    dispose(): void {}
    clear(): void {
      this.cleared += 1
    }
    select(col: number, row: number, length: number): void {
      this.selected = { col, row, length }
    }
    clearSelection(): void {
      this.selected = null
    }
    scrollToLine(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => undefined }
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      this.handler = handler
    }
    hasSelection(): boolean {
      return false
    }
    getSelection(): string {
      return ''
    }
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

const session: PtySessionInfo = { id: 'sess-1', title: 'PowerShell', cwd: '/ws', running: true, backend: 'pty' }
let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  terms.length = 0
  copied.length = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  api = {
    ptyList: vi.fn().mockResolvedValue({ ok: true, data: [session] }),
    ptyCreate: vi.fn().mockResolvedValue({ ok: true, data: { ...session, id: 'sess-2', title: 'WSL' } }),
    ptyKill: vi.fn().mockResolvedValue({ ok: true, data: true }),
    ptyWrite: vi.fn().mockResolvedValue({ ok: true, data: true }),
    ptyResize: vi.fn().mockResolvedValue({ ok: true, data: true }),
    ptyRename: vi.fn().mockResolvedValue({ ok: true, data: true }),
    onPtyData: vi.fn().mockReturnValue(() => undefined),
    onPtyExit: vi.fn().mockReturnValue(() => undefined)
  }
  Object.defineProperty(window, 'vyotiq', { configurable: true, writable: true, value: api })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function openMenu(): Promise<void> {
  await waitFor(() => expect(terms.length).toBeGreaterThan(0))
  fireEvent.click(screen.getByRole('button', { name: 'Terminal actions' }))
}

describe('terminalBuffer', () => {
  it('finds every match ignoring case, and drops trailing blank rows from the text', () => {
    expect(findInLines(['Error one', 'no', 'error, error'], 'ERROR')).toEqual([
      { row: 0, col: 0, length: 5 },
      { row: 2, col: 0, length: 5 },
      { row: 2, col: 7, length: 5 }
    ])
    expect(findInLines(['x'], '')).toEqual([])
    expect(bufferText(['a  ', 'b', '', '   '])).toBe('a\nb')
  })

  it('hands the agent the end of long output, fenced', () => {
    const long = Array.from({ length: ASK_OUTPUT_MAX_LINES + 5 }, (_, i) => `line ${i}`).join('\n')
    const text = askAboutOutputInstruction(long, { shell: 'PowerShell' })
    expect(text).toMatch(/^This is the end of the output in my PowerShell terminal\./)
    expect(text).not.toContain('line 4\n')
    expect(text).toContain(`line ${ASK_OUTPUT_MAX_LINES + 4}`)
    expect(askAboutOutputInstruction('has ``` inside', { selected: true })).toContain('````text')
  })
})

describe('TerminalPanel actions', () => {
  it('finds in the output, starting from the latest match, and steps through', async () => {
    render(<TerminalPanel workspacePath="/ws" visible />)
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Find/ }))
    const field = await screen.findByRole('textbox', { name: 'Find in terminal output' })
    fireEvent.change(field, { target: { value: 'ps c:' } })
    expect(screen.getByText('2 of 2')).toBeTruthy()
    expect(terms[0]!.selected).toEqual({ col: 0, row: 3, length: 5 })
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    expect(terms[0]!.selected).toEqual({ col: 0, row: 0, length: 5 })
    fireEvent.change(field, { target: { value: 'nothing' } })
    expect(screen.getByText('No results')).toBeTruthy()
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Find in terminal output' })).toBeNull()
  })

  it('opens find from Ctrl F inside the terminal, and keeps it from the shell', async () => {
    render(<TerminalPanel workspacePath="/ws" visible />)
    await waitFor(() => expect(terms[0]?.handler).toBeTruthy())
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true })
    expect(terms[0]!.handler!(event)).toBe(false)
    expect(await screen.findByRole('textbox', { name: 'Find in terminal output' })).toBeTruthy()
  })

  it('copies all output, clears the screen, and renames the tab', async () => {
    render(<TerminalPanel workspacePath="/ws" visible />)
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy all output/ }))
    await waitFor(() => expect(copied).toEqual(['PS C:\\ws> pnpm test\nError: cannot find module x\ndone\nPS C:\\ws>']))
    fireEvent.click(screen.getByRole('button', { name: 'Terminal actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Clear/ }))
    expect(terms[0]!.cleared).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }))
    const name = await screen.findByRole('textbox')
    fireEvent.change(name, { target: { value: 'tests' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(api.ptyRename).toHaveBeenCalledWith({ id: 'sess-1', workspacePath: '/ws', title: 'tests' }))
  })

  it('opens a tab with a chosen shell', async () => {
    render(<TerminalPanel workspacePath="/ws" visible />)
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /PowerShell/ }))
    await waitFor(() => expect(api.ptyCreate).toHaveBeenCalledWith({ workspacePath: '/ws', cols: 80, rows: 24, shell: 'powershell' }))
  })

  it('asks the agent about the output', async () => {
    const onAskAgent = vi.fn()
    render(<TerminalPanel workspacePath="/ws" visible onAskAgent={onAskAgent} />)
    await openMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: /Ask the agent about this output/ }))
    expect(onAskAgent).toHaveBeenCalledTimes(1)
    const text = onAskAgent.mock.calls[0]![0] as string
    expect(text).toMatch(/^This is the output in my PowerShell terminal\./)
    expect(text).toContain('Error: cannot find module x')
  })
})
