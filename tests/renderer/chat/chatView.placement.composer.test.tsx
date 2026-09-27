/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ChatView } from '@renderer/features/chat/ChatView'
import { clampDockWidthPx, DOCK_WIDTH_DEFAULT_PX, readSidebarWidthPxForCapacity } from '@renderer/lib/utils/layout'
import { minimalReadyPlanMarkdown } from '@renderer/features/chat/utils/planDraft'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  try {
    localStorage.removeItem('vyotiq.browserPanelOpen')
    localStorage.removeItem('vyotiq.rightPanel')
    localStorage.removeItem('vyotiq.browserRecents')
    localStorage.removeItem('vyotiq.inspectorOpen')
    localStorage.removeItem('vyotiq.inspectorExpanded')
    localStorage.removeItem('vyotiq.dockWidth')
    localStorage.removeItem('vyotiq.sidebarWidth')
  } catch {
    /* ignore */
  }
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: {
      gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { kind: 'not_repo' } }),
      gitDiff: vi.fn().mockResolvedValue({ ok: true, data: { path: '', hunks: [] } }),
      gitCommit: vi.fn().mockResolvedValue({ ok: true, data: { pushed: false, detail: 'ok' } }),
      gitLog: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      gitCommitFiles: vi.fn().mockResolvedValue({ ok: true, data: { files: [] } }),
      prView: vi.fn().mockResolvedValue({ ok: true, data: null }),
      prMerge: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'merged' } }),
      prDiff: vi.fn().mockResolvedValue({ ok: true, data: { content: '' } }),
      prClose: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'closed' } }),
      prEditTitle: vi.fn().mockResolvedValue({ ok: true, data: { title: 't' } }),
      githubAuthStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          ghAvailable: true,
          hasAppToken: false,
          pending: false,
          userCode: null,
          verificationUri: null,
          error: null
        }
      }),
      shellOpenExternal: vi.fn().mockResolvedValue({ ok: true, data: true }),
      gitStageAll: vi.fn().mockResolvedValue({ ok: true, data: { staged: true, detail: 'ok' } }),
      gitStagePaths: vi.fn().mockResolvedValue({ ok: true, data: { staged: true, detail: 'ok' } }),
      gitUnstagePaths: vi.fn().mockResolvedValue({
        ok: true,
        data: { unstaged: true, detail: 'ok' }
      }),
      gitBranches: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      gitCheckout: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'ok' } }),
      getSettings: vi.fn().mockResolvedValue({ ok: true, data: { terminalScreenReader: 'off' } }),
      getAccessibilitySupportState: vi.fn().mockResolvedValue({
        ok: true,
        data: { enabled: false }
      }),
      onAccessibilitySupportChanged: vi.fn().mockReturnValue(() => undefined),
      ptyList: vi.fn().mockImplementation((_workspacePath?: string) =>
        Promise.resolve({ ok: true, data: [] })
      ),
      ptyCreate: vi.fn().mockResolvedValue({ ok: false, error: 'pty unavailable in tests' }),
      ptyKill: vi.fn().mockResolvedValue({ ok: true, data: true }),
      ptyWrite: vi.fn().mockResolvedValue({ ok: true, data: true }),
      ptyResize: vi.fn().mockResolvedValue({ ok: true, data: true }),
      onPtyData: vi.fn().mockReturnValue(() => undefined),
      onPtyExit: vi.fn().mockReturnValue(() => undefined),
      readRunArtifact: vi.fn().mockResolvedValue({ ok: false, error: 'none' }),
      runFeedbackGet: vi.fn().mockResolvedValue({ ok: true, data: { entry: null } }),
      browserGetState: vi.fn().mockResolvedValue({
        ok: true,
        data: { open: false, url: '', title: '' }
      }),
      onBrowserState: vi.fn().mockReturnValue(() => undefined),
      browserSetBounds: vi.fn().mockResolvedValue({ ok: true, data: true }),
      browserNavigate: vi.fn().mockResolvedValue({ ok: true, data: true }),
      browserReload: vi.fn().mockResolvedValue({ ok: true, data: true }),
      browserTakeScreenshot: vi.fn().mockResolvedValue({
        ok: true,
        data: { path: '/tmp/snapshot.jpg' }
      }),
      browserClearBrowsingData: vi.fn().mockResolvedValue({
        ok: true,
        data: { cleared: 'history' }
      })
    }
  })
  class ResizeObserverStub {
    private readonly cb: ResizeObserverCallback
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb
    }
    observe(): void {
      this.cb([], this as unknown as ResizeObserver)
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const baseProps = {
  items: [],
  running: false,
  workspacePath: '/ws',
  // A task is on screen: a new task keeps the inspector out of the way until asked.
  activeRunId: 'run-1',
  onSend: vi.fn(),
  onStop: vi.fn()
}

/** Heavy dock panels are React.lazy code-split — wait for the chunk. */
async function waitForPanel(selector: string): Promise<void> {
  await waitFor(() => expect(document.querySelector(selector)).toBeTruthy())
}

/** A tab in the inspector's strip — scoped, since panels have tabs of their own. */
function inspectorTab(name: RegExp): HTMLElement {
  return within(screen.getByRole('tablist', { name: 'Inspector' })).getByRole('tab', { name })
}

/** The inspector is up by default; some cases start with it hidden. */
function startHidden(): void {
  localStorage.setItem('vyotiq.inspectorOpen', '0')
}

const agentColumn = (): HTMLElement => document.querySelector('[data-agent-column]') as HTMLElement

describe('ChatView inspector placement', () => {
  it('opens the browser panel from the inspector tab strip', async () => {
    render(<ChatView {...baseProps} items={[]} />)

    // Up by default, on Changes; nothing else mounts until it is asked for.
    expect(document.querySelector('[data-inspector]')).toBeTruthy()
    expect(inspectorTab(/^Changes/).getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('[data-agent-browser-panel]')).toBeNull()

    fireEvent.click(inspectorTab(/^Browser/))
    await waitForPanel('[data-agent-browser-panel]')
    expect(document.querySelector('[data-agent-browser-viewport]')).toBeTruthy()
    expect(screen.getByText('No page loaded')).toBeTruthy()
    expect(
      screen.getByText(/Enter a URL above, or ask the agent to open a page/i)
    ).toBeTruthy()
    // No floating rail and no per-tab close: the strip is fixed.
    expect(document.querySelector('[data-chat-side-rail]')).toBeNull()
    expect(screen.queryByRole('button', { name: /Close Browser/i })).toBeNull()
    expect(screen.getByPlaceholderText('Search or enter URL')).toBeTruthy()
  })

  it('shows the real Files panel from its tab', async () => {
    render(<ChatView {...baseProps} items={[]} />)

    fireEvent.click(inspectorTab(/^Files/))
    expect(screen.getByRole('tabpanel', { name: 'Files' })).toBeTruthy()
    expect(await screen.findByTitle('/ws', {}, { timeout: 5000 })).toBeTruthy()
    expect(inspectorTab(/^Files/).getAttribute('aria-selected')).toBe('true')
  })

  it('hands prefetched recovery to FilesPanel without loading recovery twice', async () => {
    const workspaceEditorRecoveryLoad = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        source: 'app',
        sessionToken: 'session-token-for-chat-view',
        generation: 3,
        snapshot: {
          version: 1,
          activeTabId: 'recovered-tab',
          selectedPath: 'README.md',
          expandedPaths: [''],
          treeSort: 'name',
          wordWrap: false,
          savedAt: new Date().toISOString(),
          tabs: [
            {
              id: 'recovered-tab',
              path: 'README.md',
              kind: 'text',
              content: 'hello',
              encoding: 'utf8',
              eol: 'lf',
              bom: false,
              version: null,
              dirty: true,
              cursor: 0,
              selections: [{ from: 0, to: 0 }],
              bookmarks: [],
              template: null
            }
          ]
        }
      }
    })
    const workspaceFileList = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        path: '',
        entries: [
          {
            name: 'README.md',
            path: 'README.md',
            kind: 'file',
            size: 5,
            mtimeMs: 1,
            hidden: false,
            symlinkTargetInsideWorkspace: null
          }
        ],
        total: 1,
        nextOffset: null,
        truncated: false
      }
    })
    const workspaceFileRead = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        path: 'README.md',
        kind: 'text',
        content: 'hello',
        encoding: 'utf8',
        eol: 'lf',
        bom: false,
        size: 5,
        version: {
          size: 5,
          mtimeMs: 1,
          sha256: 'a'.repeat(64)
        },
        truncated: false
      }
    })
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        workspaceEditorRecoveryLoad,
        workspaceFileList,
        workspaceFileRead,
        workspaceEditorRecoverySave: vi.fn().mockResolvedValue({ ok: true, data: true }),
        workspaceEditorRecoveryClear: vi.fn().mockResolvedValue({ ok: true, data: true })
      }
    })
    vi.useFakeTimers()
    render(<ChatView {...baseProps} items={[]} />)

    await act(async () => {
      vi.advanceTimersByTime(900)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(workspaceEditorRecoveryLoad).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    fireEvent.click(inspectorTab(/^Files/))
    expect(await screen.findByRole('tab', { name: /README\.md/i })).toBeTruthy()
    expect(workspaceFileList).toHaveBeenCalledTimes(1)
    expect(workspaceEditorRecoveryLoad).toHaveBeenCalledTimes(1)
  })

  it('opens the terminal panel with Ctrl+`', async () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.keyDown(window, { key: '`', ctrlKey: true })
    await waitFor(() => {
      expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    })
  })

  // Files / Plan / Pull request shipped bindings that the Shortcuts settings
  // page and the command palette both advertised while nothing listened for
  // them. Every panel answers its own chord: it shows the inspector on that
  // tab, and the same chord again hides the inspector.
  it.each([
    ['files', { key: 'e', ctrlKey: true, shiftKey: true }],
    ['plan', { key: 'd', ctrlKey: true, shiftKey: true }],
    ['pr', { key: 'g', ctrlKey: true, shiftKey: true }],
    ['changes', { key: 'e', ctrlKey: true }],
    ['browser', { key: 'b', ctrlKey: true, shiftKey: true }]
  ] as const)('toggles the %s panel with its advertised chord', async (panel, chord) => {
    startHidden()
    render(<ChatView {...baseProps} items={[]} />)
    expect(document.querySelector('[data-inspector]')).toBeNull()
    fireEvent.keyDown(window, chord)
    await waitFor(() => {
      expect(document.getElementById(`dock-panel-${panel}`)).toBeTruthy()
    })
    fireEvent.keyDown(window, chord)
    await waitFor(() => {
      expect(document.querySelector('[data-inspector]')).toBeNull()
    })
  })

  it('switches tabs with Alt 1–6, by the physical key too (Option+digit types a symbol on macOS)', async () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.keyDown(window, { key: '3', code: 'Digit3', altKey: true })
    expect(inspectorTab(/^Terminal/).getAttribute('aria-selected')).toBe('true')
    await waitForPanel('[data-terminal-panel]')
    fireEvent.keyDown(window, { key: '¢', code: 'Digit4', altKey: true })
    expect(inspectorTab(/^Browser/).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(window, { key: '6', code: 'Digit6', altKey: true })
    expect(inspectorTab(/^Plan/).getAttribute('aria-selected')).toBe('true')
    // Ctrl or Shift with the digit is someone else's chord.
    fireEvent.keyDown(window, { key: '1', code: 'Digit1', altKey: true, ctrlKey: true })
    expect(inspectorTab(/^Plan/).getAttribute('aria-selected')).toBe('true')
  })

  it('hides and shows the inspector with Ctrl I, on the tab it had', async () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(inspectorTab(/^Terminal/))
    await waitForPanel('[data-terminal-panel]')

    fireEvent.keyDown(window, { key: 'i', ctrlKey: true })
    expect(document.querySelector('[data-inspector]')).toBeNull()
    expect(localStorage.getItem('vyotiq.inspectorOpen')).toBe('0')

    fireEvent.keyDown(window, { key: 'i', ctrlKey: true })
    expect(inspectorTab(/^Terminal/).getAttribute('aria-selected')).toBe('true')
    await waitForPanel('[data-terminal-panel]')
  })

  it('leaves a new task the work area until the inspector is asked for', () => {
    const { rerender } = render(<ChatView {...baseProps} items={[]} activeRunId={null} />)
    // No run and no record yet: the brief has the work area to itself.
    expect(document.querySelector('[data-inspector]')).toBeNull()

    fireEvent.keyDown(window, { key: 'i', ctrlKey: true })
    expect(inspectorTab(/^Changes/).getAttribute('aria-selected')).toBe('true')
    expect(localStorage.getItem('vyotiq.inspectorOpen')).not.toBe('0')

    // The task starts: the inspector stays up.
    rerender(<ChatView {...baseProps} items={[]} activeRunId="run-1" />)
    expect(document.querySelector('[data-inspector]')).toBeTruthy()

    // The next new task starts unasked; a tab chord asks for its tab.
    rerender(<ChatView {...baseProps} items={[]} activeRunId={null} />)
    expect(document.querySelector('[data-inspector]')).toBeNull()
    fireEvent.keyDown(window, { key: '2', altKey: true })
    expect(inspectorTab(/^Files/).getAttribute('aria-selected')).toBe('true')
  })

  it('answers the palette for hide / show and expand', () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent(window, new CustomEvent('vyotiq:command', { detail: { id: 'inspectorExpand' } }))
    expect(document.querySelector('[data-right-dock]')?.getAttribute('data-dock-expanded')).toBe('1')
    fireEvent(window, new CustomEvent('vyotiq:command', { detail: { id: 'inspector' } }))
    expect(document.querySelector('[data-inspector]')).toBeNull()
  })

  it('opens a panel from a command palette entry', async () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent(
      window,
      new CustomEvent('vyotiq:command', { detail: { id: 'panelFiles' } })
    )
    await waitFor(() => {
      expect(document.getElementById('dock-panel-files')).toBeTruthy()
    })
  })

  it('hides from its own button and comes back on the same tab', async () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(inspectorTab(/^Terminal/))
    await waitFor(() => {
      expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Hide inspector (Ctrl+I)' }))
    expect(document.querySelector('[data-inspector]')).toBeNull()
    // The record keeps the whole width; nothing is left floating over it.
    expect(agentColumn().className).toMatch(/\bflex-1\b/)
    expect(document.querySelector('[data-chat-side-rail]')).toBeNull()

    fireEvent.keyDown(window, { key: 'i', ctrlKey: true })
    expect(inspectorTab(/^Terminal/).getAttribute('aria-selected')).toBe('true')
  })

  it('switches tabs while keeping visited panels mounted', async () => {
    render(<ChatView {...baseProps} items={[]} />)

    fireEvent.click(inspectorTab(/^Terminal/))
    await waitFor(() => {
      expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    })
    expect(await screen.findByText('No terminal')).toBeTruthy()
    // Session strip: New terminal only until a session exists.
    expect(screen.getByRole('button', { name: /New terminal/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /terminal list/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Maximize terminal/i })).toBeNull()
    expect(screen.queryByText(/Agent commands/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Split terminal/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Expand to full width (Ctrl+Shift+I)' })).toBeTruthy()

    fireEvent.click(inspectorTab(/^Changes/))
    await waitForPanel('[data-changes-panel]')
    // Keep-alive: prior panels stay mounted but hidden.
    expect(
      document.querySelector('[data-terminal-panel]')?.parentElement?.className
    ).toMatch(/\bhidden\b/)
    expect(
      document.querySelector('[data-changes-panel]')?.parentElement?.className
    ).toMatch(/\bflex\b/)
    // Nothing changed by this task, and no git to review with: it says which.
    expect(await screen.findByText('Not a git repository', {}, { timeout: 5000 })).toBeTruthy()

    fireEvent.click(inspectorTab(/^Terminal/))
    expect(
      document.querySelector('[data-terminal-panel]')?.parentElement?.className
    ).toMatch(/\bflex\b/)
    expect(
      document.querySelector('[data-changes-panel]')?.parentElement?.className
    ).toMatch(/\bhidden\b/)
  })

  it('does not auto-open Browser on IPC rising edge', async () => {
    let browserHandler: ((state: { open: boolean; url: string; title: string }) => void) | null =
      null
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        browserGetState: vi.fn().mockResolvedValue({
          ok: true,
          data: { open: false, url: '', title: '' }
        }),
        onBrowserState: vi.fn((handler: typeof browserHandler) => {
          browserHandler = handler
          return () => {
            browserHandler = null
          }
        })
      }
    })

    render(<ChatView {...baseProps} items={[]} />)
    expect(document.querySelector('[data-agent-browser-panel]')).toBeNull()

    browserHandler?.({ open: true, url: 'https://example.com', title: 'Example' })
    await Promise.resolve()
    expect(document.querySelector('[data-agent-browser-panel]')).toBeNull()
    expect(inspectorTab(/^Changes/).getAttribute('aria-selected')).toBe('true')
  })

  it('does not auto-open Browser when Terminal is already open', async () => {
    let browserHandler: ((state: { open: boolean; url: string; title: string }) => void) | null =
      null
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        browserGetState: vi.fn().mockResolvedValue({
          ok: true,
          data: { open: true, url: 'https://example.com', title: 'Example' }
        }),
        onBrowserState: vi.fn((handler: typeof browserHandler) => {
          browserHandler = handler
          return () => {
            browserHandler = null
          }
        })
      }
    })

    localStorage.setItem('vyotiq.rightPanel', 'terminal')
    render(<ChatView {...baseProps} items={[]} />)

    await waitFor(() => {
      expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    })
    expect(document.querySelector('[data-agent-browser-panel]')).toBeNull()

    browserHandler?.({ open: true, url: 'https://example.com/x', title: 'Example' })
    expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    expect(document.querySelector('[data-agent-browser-panel]')).toBeNull()
  })
  it('restores the Plan tab from localStorage on mount', async () => {
    localStorage.setItem('vyotiq.rightPanel', 'plan')
    render(<ChatView {...baseProps} items={[]} />)

    await waitForPanel('[data-plan-panel]')
    expect(inspectorTab(/^Plan/).getAttribute('aria-selected')).toBe('true')
  })

  it('never lands on Files at startup — it opens only when asked for', () => {
    localStorage.setItem('vyotiq.rightPanel', 'files')
    render(<ChatView {...baseProps} items={[]} />)
    expect(inspectorTab(/^Changes/).getAttribute('aria-selected')).toBe('true')
    expect(document.getElementById('dock-panel-files')).toBeNull()
  })

  it('remembers a hidden inspector across a remount', () => {
    const first = render(<ChatView {...baseProps} items={[]} />)
    fireEvent.keyDown(window, { key: 'i', ctrlKey: true })
    first.unmount()
    render(<ChatView {...baseProps} items={[]} />)
    expect(document.querySelector('[data-inspector]')).toBeNull()
  })

  it('does not auto-open Browser over a restored Plan panel', async () => {
    let browserHandler: ((state: { open: boolean; url: string; title: string }) => void) | null =
      null
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        browserGetState: vi.fn().mockResolvedValue({
          ok: true,
          data: { open: false, url: '', title: '' }
        }),
        onBrowserState: vi.fn((handler: typeof browserHandler) => {
          browserHandler = handler
          return () => {
            browserHandler = null
          }
        })
      }
    })

    localStorage.setItem('vyotiq.rightPanel', 'plan')
    render(<ChatView {...baseProps} items={[]} />)

    await waitForPanel('[data-plan-panel]')
    expect(document.querySelector('[data-agent-browser-panel]')).toBeNull()

    browserHandler?.({ open: true, url: 'https://example.com', title: 'Example' })
    expect(document.querySelector('[data-plan-panel]')).toBeTruthy()
    expect(document.querySelector('[data-agent-browser-panel]')).toBeNull()
  })

  it('does not auto-open Terminal when an agent terminal tool is running', () => {
    render(
      <ChatView
        {...baseProps}
        running
        items={[
          {
            kind: 'tool',
            id: 't1',
            tool: {
              id: 't1',
              name: 'terminal',
              summary: 'echo hi',
              status: 'running',
              argsPreview: '{"command":"echo hi"}'
            }
          }
        ]}
      />
    )
    expect(document.querySelector('[data-terminal-panel]')).toBeNull()
    // The Terminal tab says the command is running; the reader chooses to look.
    expect(inspectorTab(/^Terminal/).textContent).toContain('working now')
    expect(inspectorTab(/^Changes/).getAttribute('aria-selected')).toBe('true')
  })

  it('does not switch to Changes for unresolved writes or dirty git', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        gitStatus: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            kind: 'ok',
            status: {
              branch: 'main',
              files: [
                {
                  path: 'a.ts',
                  status: 'modified',
                  added: 1,
                  removed: 0,
                  addedStaged: 0,
                  removedStaged: 0,
                  addedUnstaged: 1,
                  removedUnstaged: 0,
                  binary: false,
                  staged: false,
                  unstaged: true
                }
              ],
              truncated: false,
              fileCount: 1,
              added: 1,
              removed: 0,
              hasRemote: true,
              hasCommits: true
            }
          }
        })
      }
    })

    localStorage.setItem('vyotiq.rightPanel', 'terminal')
    render(
      <ChatView
        {...baseProps}
        canUndoWrites
        writeResolvablePaths={new Set(['a.ts'])}
        writeCheckpointFiles={[{ path: 'a.ts', action: 'modified' }]}
      />
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(document.querySelector('[data-changes-panel]')).toBeNull()
    expect(inspectorTab(/^Terminal/).getAttribute('aria-selected')).toBe('true')
    // The count says something waits there.
    expect(inspectorTab(/^Changes/).textContent).toBe('Changes1')

    fireEvent.click(inspectorTab(/^Changes/))
    await waitForPanel('[data-changes-panel]')
  })

  it('does not fetch git chrome until the Changes tab is on screen', async () => {
    const gitStatus = vi.fn().mockResolvedValue({ ok: true, data: { kind: 'not_repo' } })
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        gitStatus
      }
    })
    localStorage.setItem('vyotiq.rightPanel', 'terminal')
    render(<ChatView {...baseProps} items={[]} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(gitStatus).not.toHaveBeenCalled()
    fireEvent.click(inspectorTab(/^Changes/))
    await waitForPanel('[data-changes-panel]')
    await waitFor(() => {
      expect(gitStatus).toHaveBeenCalled()
    })
  })

  it('never switches tabs on its own when a plan is ready — and never polls plan.md for it', async () => {
    const readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        exists: true,
        content: minimalReadyPlanMarkdown(),
        path: '/ws/.vyotiq/runs/run-1/plan.md'
      }
    })
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        readRunArtifact
      }
    })

    render(
      <ChatView
        {...baseProps}
        activeRunId="run-1"
        running
        items={[
          {
            kind: 'tool',
            id: 'cp1',
            tool: { id: 'cp1', name: 'create_plan', summary: 'Ship it', status: 'done' }
          }
        ]}
      />
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(inspectorTab(/^Changes/).getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('[data-plan-panel]')).toBeNull()
    expect(
      readRunArtifact.mock.calls.filter((c) => (c[0] as { name?: string } | undefined)?.name === 'plan.md')
    ).toHaveLength(0)
  })

  it('shows Recents in the empty browser panel when history exists', () => {
    localStorage.setItem(
      'vyotiq.browserRecents',
      JSON.stringify([
        {
          url: 'https://example.com',
          title: 'Example Domain',
          visitedAt: Date.now()
        }
      ])
    )
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(inspectorTab(/^Browser/))
    expect(screen.getByText('Recents')).toBeTruthy()
    expect(screen.getByText('Example Domain')).toBeTruthy()
  })

  it('sizes the inspector beside the record', async () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(inspectorTab(/^Plan/))
    await waitForPanel('[data-plan-panel]')
    const dock = document.querySelector('[data-right-dock]') as HTMLElement
    expect(dock.className).toMatch(/min-w-0/)
    expect(dock.className).toMatch(/shrink-0/)
    expect(Number.parseInt(dock.style.width, 10)).toBe(
      clampDockWidthPx(DOCK_WIDTH_DEFAULT_PX, window.innerWidth, {
        paneCount: 1,
        sidebarWidthPx: readSidebarWidthPxForCapacity()
      })
    )
  })

  it('expands the inspector to the whole work area and back', () => {
    render(<ChatView {...baseProps} items={[]} />)
    const dock = document.querySelector('[data-right-dock]') as HTMLElement
    expect(dock.getAttribute('data-dock-expanded')).toBe('0')
    expect(screen.getByRole('separator', { name: 'Resize inspector' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Expand to full width (Ctrl+Shift+I)' }))
    const expanded = document.querySelector('[data-right-dock]') as HTMLElement
    expect(expanded.getAttribute('data-dock-expanded')).toBe('1')
    expect(expanded.style.width).toBe('')
    // The record steps aside — still mounted, out of reach.
    expect(agentColumn().classList.contains('hidden')).toBe(true)
    expect(agentColumn().hasAttribute('inert')).toBe(true)
    expect(screen.queryByRole('separator', { name: 'Resize inspector' })).toBeNull()

    // Changes taken to the whole area is the review: its own header, no tab strip.
    expect(screen.getByRole('region', { name: 'Review' })).toBeTruthy()
    expect(screen.queryByRole('tablist', { name: 'Inspector' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to the record' }))
    expect(document.querySelector('[data-right-dock]')?.getAttribute('data-dock-expanded')).toBe('0')
    expect(agentColumn().classList.contains('hidden')).toBe(false)
    expect(agentColumn().hasAttribute('inert')).toBe(false)
  })

  it('keeps the tab strip when another tab is expanded', () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(within(screen.getByRole('tablist', { name: 'Inspector' })).getByRole('tab', { name: /^Plan/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand to full width (Ctrl+Shift+I)' }))
    expect(document.querySelector('[data-right-dock]')?.getAttribute('data-dock-expanded')).toBe('1')
    expect(screen.getByRole('tablist', { name: 'Inspector' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to the record (Ctrl+Shift+I)' }))
    expect(document.querySelector('[data-right-dock]')?.getAttribute('data-dock-expanded')).toBe('0')
  })

  it('expands and collapses with Ctrl Shift I, showing a hidden inspector first', () => {
    startHidden()
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.keyDown(window, { key: 'I', ctrlKey: true, shiftKey: true })
    expect(document.querySelector('[data-right-dock]')?.getAttribute('data-dock-expanded')).toBe('1')
    // Focus left the record for the review's way back, not for <body>.
    expect(document.activeElement?.hasAttribute('data-review-back')).toBe(true)
    fireEvent.keyDown(window, { key: 'I', ctrlKey: true, shiftKey: true })
    expect(document.querySelector('[data-right-dock]')?.getAttribute('data-dock-expanded')).toBe('0')
  })

  it('hiding an expanded inspector brings the record back, and it returns docked', () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand to full width (Ctrl+Shift+I)' }))
    // The review has no close button of its own; Ctrl I still hides it.
    fireEvent.keyDown(window, { key: 'i', ctrlKey: true })
    expect(document.querySelector('[data-inspector]')).toBeNull()
    expect(agentColumn().classList.contains('hidden')).toBe(false)
    fireEvent.keyDown(window, { key: 'i', ctrlKey: true })
    expect(document.querySelector('[data-right-dock]')?.getAttribute('data-dock-expanded')).toBe('0')
  })

  it('keeps the inspector tabs in the inspector, never in the title band', async () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(inspectorTab(/^Browser/))
    await waitForPanel('[data-agent-browser-panel]')

    expect(document.querySelector('[data-dock-titlebar-portal]')).toBeNull()
    expect(document.querySelector('[data-right-dock] [data-inspector-tabs] [role="tablist"]')).toBeTruthy()
    expect(inspectorTab(/^Browser/).getAttribute('aria-selected')).toBe('true')
  })

  it('opens the pull request panel from its tab', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        prView: vi.fn().mockResolvedValue({ ok: true, data: null })
      }
    })
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(inspectorTab(/^PR/))
    await waitFor(() => {
      expect(document.querySelector('[data-pr-panel]')).toBeTruthy()
    })
  })

  it('holds a pane-shaped placeholder until the pane layout arrives — no chat column', () => {
    render(<ChatView {...baseProps} items={[]} />)
    const placeholder = document.querySelector('[data-chat-pane-placeholder]') as HTMLElement
    expect(placeholder).toBeTruthy()
    expect(placeholder.getAttribute('aria-busy')).toBe('true')
    const header = placeholder.firstElementChild as HTMLElement
    expect(header.classList.contains('h-10')).toBe(true)
    expect(header.classList.contains('border-b')).toBe(true)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(document.querySelector('[data-composer-dock]')).toBeNull()
    expect(document.querySelector('[data-transcript-scroll]')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says why when the workspace list failed to load', () => {
    render(<ChatView {...baseProps} items={[]} loadError="Workspaces file is unreadable." />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Couldn’t load workspaces')
    expect(alert.textContent).toContain('Workspaces file is unreadable.')
    expect(document.querySelector('[data-chat-pane-placeholder]')?.hasAttribute('aria-busy')).toBe(false)
  })
})
