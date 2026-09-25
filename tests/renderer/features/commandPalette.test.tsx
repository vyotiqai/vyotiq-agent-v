/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { RunSummary } from '@shared/ipc'
import { CommandPalette, type PaletteFile } from '@renderer/features/commandPalette/CommandPalette'
import {
  labelToKeys,
  paletteCommands,
  paletteSettingsCommands,
  paletteUpdateCommands,
  runPaletteCommand
} from '@renderer/features/commandPalette/paletteCommands'
import { resetUpdaterStoreForTests } from '@renderer/features/updates/updaterStore'
import { buildNavigatorSections } from '@renderer/app/navigator/navigatorModel'

afterEach(() => cleanup())

const WS = 'C:\\work\\vyotiq'
const OTHER = 'C:\\work\\alpha'

function tasksFor(runs: RunSummary[]) {
  return buildNavigatorSections({
    runsByWorkspacePath: { [WS]: { runs } },
    openPaths: [WS],
    activePath: WS,
    activeRuns: [],
    activeRunsLoaded: true,
    scopePath: null
  }).flatMap((s) => s.rows)
}

const RUNS: RunSummary[] = [
  { runId: 'r1', status: 'done', updatedAt: new Date().toISOString(), goal: 'Fix the flaky updater test on Windows' },
  { runId: 'r2', status: 'done', updatedAt: new Date().toISOString(), goal: 'Regroup Settings' }
]

function renderPalette(over: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onOpenTask: vi.fn(),
    onOpenFile: vi.fn(),
    onRunCommand: vi.fn(),
    onNewTask: vi.fn()
  }
  render(
    <CommandPalette
      open
      tasks={tasksFor(RUNS)}
      commands={paletteCommands({ workspaces: [OTHER, WS], activePath: WS, canSendFeedback: true })}
      newTaskIn={{ name: 'vyotiq' }}
      {...handlers}
      {...over}
    />
  )
  return { handlers, input: screen.getByRole('textbox', { name: 'Search tasks, files and commands' }) }
}

describe('CommandPalette', () => {
  it('groups tasks, files and commands and highlights the match', async () => {
    vi.useFakeTimers()
    const searchFiles = vi.fn(async (): Promise<PaletteFile[]> => [{ workspacePath: WS, path: 'src/main/updater/swap.ts' }])
    const { input } = renderPalette({ searchFiles })
    fireEvent.change(input, { target: { value: 'updater' } })
    await act(async () => {
      vi.advanceTimersByTime(120)
    })
    vi.useRealTimers()

    expect(screen.getByRole('group', { name: 'Tasks' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Files' })).toBeTruthy()
    expect(searchFiles).toHaveBeenCalledWith('updater', 6)
    const marks = [...document.querySelectorAll('mark')].map((m) => m.textContent)
    expect(marks).toContain('updater')
    expect(screen.queryByText('Regroup Settings')).toBeNull()
  })

  it('opens the highlighted task on Enter and beside the current one on Shift Enter', () => {
    const { handlers, input } = renderPalette()
    fireEvent.change(input, { target: { value: 'flaky' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(handlers.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1' }), true)
  })

  it('narrows to commands with ">"', () => {
    renderPalette()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks, files and commands' }), {
      target: { value: '>settings' }
    })
    expect(screen.queryByRole('group', { name: 'Tasks' })).toBeNull()
    expect(within(screen.getByRole('group', { name: 'Commands' })).getByText('Settings')).toBeTruthy()
  })

  it('turns the query into a new task with Ctrl Enter', () => {
    const { handlers, input } = renderPalette()
    fireEvent.change(input, { target: { value: 'bump electron' } })
    expect(screen.getByText('New task: “bump electron”')).toBeTruthy()
    expect(screen.getByText('in vyotiq')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(handlers.onNewTask).toHaveBeenCalledWith('bump electron')
  })

  it('offers no new task when no workspace is open', () => {
    const { input } = renderPalette({ newTaskIn: null })
    fireEvent.change(input, { target: { value: 'bump electron' } })
    expect(screen.queryByText(/New task:/)).toBeNull()
  })

  it('closes on Escape', () => {
    const { handlers, input } = renderPalette()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(handlers.onClose).toHaveBeenCalled()
  })
})

describe('paletteCommands', () => {
  it('closes on Escape when focus is outside it, closing once', () => {
    const { handlers, input } = renderPalette()
    // A mouse-opened palette in an unfocused window can leave focus on the page.
    input.blur()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(handlers.onClose).toHaveBeenCalledTimes(1)

    // From the input, its own handler answers and the window listener stands aside.
    handlers.onClose.mockClear()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(handlers.onClose).toHaveBeenCalledTimes(1)
  })

  it('lists one switch and one new-task command per open workspace, and never itself', () => {
    const titles = paletteCommands({ workspaces: [OTHER, WS], activePath: WS, canSendFeedback: false }).map((c) => c.title)
    expect(titles).toContain('Switch to alpha')
    expect(titles).toContain('Switch to vyotiq')
    expect(titles).toContain('New task in alpha')
    expect(titles).not.toContain('Search and commands')
    expect(titles.filter((t) => t.startsWith('Switch to '))).toHaveLength(2)
    expect(titles).not.toContain('Send feedback')
  })

  it('marks the current workspace', () => {
    const current = paletteCommands({ workspaces: [OTHER, WS], activePath: WS, canSendFeedback: false }).find(
      (c) => c.title === 'Switch to vyotiq'
    )
    expect(current?.hint).toBe('current')
  })

  it('splits a chord label into keycaps', () => {
    expect(labelToKeys('Ctrl+Shift+E')).toEqual(['Ctrl', 'Shift', 'E'])
    expect(labelToKeys('Ctrl+,')).toEqual(['Ctrl', ','])
    expect(labelToKeys('End')).toEqual(['End'])
  })

  it('handles app commands itself and hands the rest to the surface that owns them', () => {
    const h = {
      workspaces: [OTHER, WS],
      onOpenSettings: vi.fn(),
      onOpenHome: vi.fn(),
      onOpenUsage: vi.fn(),
      onNewTask: vi.fn(),
      onToggleNavigator: vi.fn(),
      onNextNeedsYou: vi.fn(),
      onSwitchWorkspaceByIndex: vi.fn(),
      onNewChatInWorkspace: vi.fn(),
      onFocusInstructionLine: vi.fn(),
      onOpenSettingsField: vi.fn()
    }
    runPaletteCommand('workspace2', h)
    expect(h.onSwitchWorkspaceByIndex).toHaveBeenCalledWith(1)
    runPaletteCommand('newchat1', h)
    expect(h.onNewChatInWorkspace).toHaveBeenCalledWith(OTHER)

    const seen: string[] = []
    const onCommand = (e: Event) => seen.push((e as CustomEvent<{ id: string }>).detail.id)
    window.addEventListener('vyotiq:command', onCommand)
    runPaletteCommand('panelChanges', h)
    window.removeEventListener('vyotiq:command', onCommand)
    expect(seen).toEqual(['panelChanges'])
  })
})

describe('palette update and settings commands', () => {
  const info = {
    version: '1.1.0',
    releaseDate: '2026-09-22T00:00:00Z',
    releaseName: 'v1.1.0',
    notesText: '',
    notesSections: []
  }

  afterEach(() => {
    resetUpdaterStoreForTests()
    Reflect.deleteProperty(window, 'vyotiq')
  })

  it('offers the update only while there is one to download or install', () => {
    expect(paletteUpdateCommands({ status: 'available', info }).map((c) => c.title)).toEqual(['Download update 1.1.0'])
    const [install] = paletteUpdateCommands({ status: 'downloaded', info })
    expect(install).toMatchObject({ id: 'installUpdate', title: 'Install update 1.1.0', hint: 'restarts Agent V' })
    expect(paletteUpdateCommands({ status: 'downloading', info })).toEqual([])
    expect(paletteUpdateCommands({ status: 'idle' })).toEqual([])
  })

  it('downloads and installs through the update store, never on its own', () => {
    const updater = {
      download: vi.fn(async () => ({ ok: true as const, data: true })),
      install: vi.fn(async () => ({ ok: true as const, data: true }))
    }
    Object.defineProperty(window, 'vyotiq', { value: { updater }, configurable: true, writable: true })
    const h = {
      workspaces: [],
      onOpenSettings: vi.fn(),
      onOpenHome: vi.fn(),
      onOpenUsage: vi.fn(),
      onNewTask: vi.fn(),
      onToggleNavigator: vi.fn(),
      onNextNeedsYou: vi.fn(),
      onSwitchWorkspaceByIndex: vi.fn(),
      onFocusInstructionLine: vi.fn(),
      onOpenSettingsField: vi.fn()
    }
    runPaletteCommand('downloadUpdate', h)
    expect(updater.download).toHaveBeenCalledTimes(1)
    expect(updater.install).not.toHaveBeenCalled()
    runPaletteCommand('installUpdate', h)
    expect(updater.install).toHaveBeenCalledTimes(1)
    runPaletteCommand('settings:about-auto-check', h)
    expect(h.onOpenSettingsField).toHaveBeenCalledWith('about-auto-check')
  })

  it('finds a setting by what it does and names its section', () => {
    const { handlers, input } = renderPalette({ settingsCommands: paletteSettingsCommands })
    fireEvent.change(input, { target: { value: 'check for updates' } })
    const commands = screen.getByRole('group', { name: 'Commands' })
    const option = within(commands).getByRole('option', { name: /Settings: Check automatically/ })
    expect(option.textContent).toContain('About')
    fireEvent.click(option)
    expect(handlers.onRunCommand).toHaveBeenCalledWith('settings:about-auto-check')
  })

  it('lists no settings until something is typed', () => {
    expect(paletteSettingsCommands('')).toEqual([])
    renderPalette({ settingsCommands: paletteSettingsCommands })
    expect(screen.queryByText(/^Settings: /)).toBeNull()
  })
})
