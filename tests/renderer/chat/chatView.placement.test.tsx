/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ChatView } from '@renderer/features/chat/ChatView'
import { emptySecretStatus } from '@shared/ipc'
import { TitleBar } from '@renderer/app/TitleBar'
import { BreakpointProvider } from '@renderer/lib/context/BreakpointProvider'
import { TitleBarAccessoryProvider } from '@renderer/lib/context/TitleBarAccessory'
import { clampDockWidthPx, DOCK_WIDTH_DEFAULT_PX, readSidebarWidthPxForCapacity } from '@renderer/lib/utils/layout'
import { resetDockImmersiveStore } from '@renderer/lib/hooks/dockImmersiveStore'
import { minimalReadyPlanMarkdown } from '@renderer/features/chat/utils/planDraft'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  resetDockImmersiveStore()
  try {
    localStorage.removeItem('vyotiq.browserPanelOpen')
    localStorage.removeItem('vyotiq.rightPanel')
    localStorage.removeItem('vyotiq.browserRecents')
    localStorage.removeItem('vyotiq.dockExpanded')
    localStorage.removeItem('vyotiq.immersiveTab')
    localStorage.removeItem('vyotiq.dockWidth')
    localStorage.removeItem('vyotiq.sidebarWidth')
  } catch {
    /* ignore */
  }
  // The docked composer asks the main process about git as soon as it mounts.
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
  error: null,
  hasWorkspace: true,
  workspacePath: '/ws',
  provider: 'ollama' as const,
  model: 'qwen2.5',
  activeRunId: null,
  chatSettings: {
    provider: 'ollama' as const,
    model: 'qwen2.5',
    keepRecentTurns: 12,
    thinkingEnabled: true,
    thinkingEffort: 'medium' as const,
    showThinking: true
  },
  onChatSettingsChange: vi.fn(),
  onProviderModel: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  secrets: emptySecretStatus()
}

/** Heavy dock panels are React.lazy code-split — wait for the chunk. */
async function waitForPanel(selector: string): Promise<void> {
  await waitFor(() => expect(document.querySelector(selector)).toBeTruthy())
}

describe('ChatView composer placement', () => {
  it('shows a side rail that opens the browser panel', async () => {
    render(<ChatView {...baseProps} items={[]} />)

    expect(document.querySelector('[data-chat-side-rail]')).toBeTruthy()
    expect(document.querySelector('[data-agent-browser-panel]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Show browser panel/i }))
    await waitForPanel('[data-agent-browser-panel]')
    expect(document.querySelector('[data-agent-browser-viewport]')).toBeTruthy()
    // Dock open ? side rail hidden; dock tabs own navigation.
    expect(document.querySelector('[data-chat-side-rail]')).toBeNull()
    expect(screen.getByText('No page loaded')).toBeTruthy()
    expect(
      screen.getByText(/Enter a URL above, or ask the agent to open a page/i)
    ).toBeTruthy()
    const browserPanel = document.querySelector('[data-agent-browser-panel]')
    expect(
      browserPanel?.querySelector('[aria-label="Hide browser panel"]')
    ).toBeNull()
    expect(screen.getByRole('button', { name: /Close Browser/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Close panel/i })).toBeNull()
    expect(screen.getByPlaceholderText('Search or enter URL')).toBeTruthy()
  })

  it('shows the real Files panel from the Chat side rail', async () => {
    render(<ChatView {...baseProps} items={[]} />)

    fireEvent.click(screen.getByRole('button', { name: /Show files panel/i }))
    expect(screen.getByRole('tabpanel', { name: 'Files' })).toBeTruthy()
    expect(await screen.findByTitle('/ws', {}, { timeout: 5000 })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Show files panel/i })).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: /Show files panel/i }))
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

  it('closes one dock tab without clearing the remaining tabs', async () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    fireEvent.click(screen.getByRole('button', { name: /Show changes panel/i }))
    await waitFor(() => {
      expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    })
    await waitForPanel('[data-changes-panel]')
    expect(screen.getByRole('tab', { name: /^Terminal$/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Changes$/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Close Changes/i }))
    expect(document.querySelector('[data-right-dock]')).toBeTruthy()
    expect(document.querySelector('[data-changes-panel]')).toBeNull()
    expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Terminal$/i })).toBeTruthy()
  })

  it('switches docked panels from the side rail', async () => {
    render(<ChatView {...baseProps} items={[]} />)

    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    await waitFor(() => {
      expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    })
    expect(document.querySelector('[data-chat-side-rail]')).toBeNull()
    expect(await screen.findByText('No terminal')).toBeTruthy()
    // Session strip: New terminal only until a session exists; expand lives on DockTabBar.
    expect(screen.getByRole('button', { name: /New terminal/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /terminal list/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Maximize terminal/i })).toBeNull()
    expect(screen.queryByText(/Agent commands/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Split terminal/i })).toBeNull()
    expect(screen.getByRole('button', { name: /Expand panel/i })).toBeTruthy()
    expect(document.querySelector('[data-dock-quick-launch]')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Show changes panel/i }))
    await waitForPanel('[data-changes-panel]')
    // Keep-alive: prior panels stay mounted but hidden.
    expect(
      document.querySelector('[data-terminal-panel]')?.parentElement?.className
    ).toMatch(/\bhidden\b/)
    expect(
      document.querySelector('[data-changes-panel]')?.parentElement?.className
    ).toMatch(/\bflex\b/)
    expect(await screen.findByText('Not a git repository', {}, { timeout: 5000 })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Show files panel/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Close Changes/i }))
    // Closing Changes via the tab leaves Terminal mounted.
    expect(document.querySelector('[data-changes-panel]')).toBeNull()
    expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    expect(document.querySelector('[data-right-dock]')).toBeTruthy()
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
    expect(document.querySelector('[data-chat-side-rail]')).toBeTruthy()

    browserHandler?.({ open: true, url: 'https://example.com', title: 'Example' })
    await Promise.resolve()
    expect(document.querySelector('[data-agent-browser-panel]')).toBeNull()
    expect(document.querySelector('[data-chat-side-rail]')).toBeTruthy()
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

  it('restores the Plan panel from localStorage on mount', async () => {
    localStorage.setItem('vyotiq.rightPanel', 'plan')
    render(<ChatView {...baseProps} items={[]} />)

    await waitForPanel('[data-plan-panel]')
    expect(document.querySelector('[data-chat-side-rail]')).toBeNull()
    // Scope to the dock tablist: the PlanPanel subtab is also role=tab "Plan".
    const dockTablist = document.querySelector('[data-dock-panel-tablist]') as HTMLElement
    expect(within(dockTablist).getByRole('tab', { name: /^Plan$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Close Plan/i })).toBeTruthy()
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
    expect(document.querySelector('[data-chat-side-rail]')).toBeTruthy()
  })

  it('does not auto-open Changes for unresolved writes or dirty git', async () => {
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

    render(
      <ChatView
        {...baseProps}
        canUndoWrites
        writeResolvablePaths={new Set(['a.ts'])}
      />
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(document.querySelector('[data-changes-panel]')).toBeNull()
    expect(document.querySelector('[data-chat-side-rail]')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    fireEvent.click(screen.getByRole('button', { name: /Show changes panel/i }))
    await waitForPanel('[data-changes-panel]')
  })

  it('does not fetch git chrome until the Changes dock is visible', async () => {
    const gitStatus = vi.fn().mockResolvedValue({ ok: true, data: { kind: 'not_repo' } })
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        gitStatus
      }
    })
    render(<ChatView {...baseProps} items={[]} />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(gitStatus).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Show changes panel/i }))
    await waitForPanel('[data-changes-panel]')
    await waitFor(() => {
      expect(gitStatus).toHaveBeenCalled()
    })
  })

  it('auto-opens Plan when plan.md is ready in plan mode', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        readRunArtifact: vi.fn().mockResolvedValue({
          ok: true,
          data: {
            exists: true,
            content: minimalReadyPlanMarkdown(),
            path: '/ws/.vyotiq/runs/run-1/plan.md'
          }
        })
      }
    })

    render(
      <ChatView
        {...baseProps}
        agentMode="plan"
        activeRunId="run-1"
        running
        items={[]}
      />
    )

    await waitForPanel('[data-plan-panel]')
    // Scope to the dock tablist: the PlanPanel subtab is also role=tab "Plan".
    const autoOpenTablist = document.querySelector('[data-dock-panel-tablist]') as HTMLElement
    expect(within(autoOpenTablist).getByRole('tab', { name: /^Plan$/i })).toBeTruthy()
  })

  it('stops polling plan.md after the Plan panel is dismissed', async () => {
    vi.useFakeTimers()
    try {
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
        <ChatView {...baseProps} agentMode="plan" activeRunId="run-1" running items={[]} />
      )
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })
      // Scope to the dock tablist: the PlanPanel subtab is also role=tab "Plan".
      const dockTablist = document.querySelector('[data-dock-panel-tablist]') as HTMLElement
      expect(within(dockTablist).getByRole('tab', { name: /^Plan$/i })).toBeTruthy()

      // While mounted, plan.md polls continue (PlanPanel owns the cadence).
      const planCalls = () =>
        readRunArtifact.mock.calls.filter(
          (c) => (c[0] as { name?: string } | undefined)?.name === 'plan.md'
        ).length
      await act(async () => {
        vi.advanceTimersByTime(2500)
        await Promise.resolve()
      })
      expect(planCalls()).toBeGreaterThan(0)

      fireEvent.click(screen.getByRole('button', { name: /Close Plan/i }))

      // After dismissal the auto-open poll must stop entirely — no interval
      // may fire without any possible effect.
      readRunArtifact.mockClear()
      await act(async () => {
        vi.advanceTimersByTime(4500)
        await Promise.resolve()
      })
      expect(planCalls()).toBe(0)
      expect(screen.queryByRole('tab', { name: /^Plan$/i })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

    it('shows tasks under the owning user prompt in transcript order', async () => {
      Object.defineProperty(window, 'vyotiq', {
        configurable: true,
        writable: true,
        value: {
          ...(window.vyotiq as object),
          readRunArtifact: vi.fn().mockImplementation(async (req: { name?: string }) => {
            if (req.name === 'todos.json') {
              return {
                ok: true,
                data: {
                  exists: true,
                  content: JSON.stringify({
                    updatedAt: '2026-01-01T00:00:00.000Z',
                    todos: [{ id: '1', content: 'Ship it', status: 'in_progress' }]
                  }),
                  name: 'todos.json'
                }
              }
            }
            return { ok: false, error: 'none' }
          })
        }
      })

      render(
        <ChatView
          {...baseProps}
          agentMode="agent"
          activeRunId="run-1"
          running
          items={[
            {
              kind: 'message',
              id: 'user-0',
              role: 'user',
              content: 'audit the entire codebase end to end',
              at: '2024-01-01T00:00:00.000Z'
            },
            {
              kind: 'tool',
              id: 'todo1',
              tool: {
                id: 'todo1',
                name: 'todo_write',
                summary: '1 task',
                status: 'done'
              }
            },
            {
              kind: 'message',
              id: 'a1',
              role: 'assistant',
              content: 'Working on it.',
              at: '2024-01-01T00:00:01.000Z'
            },
            {
              kind: 'message',
              id: 'user-2',
              role: 'user',
              content: 'delete it',
              at: '2024-01-01T00:00:02.000Z'
            }
          ]}
        />
      )

      expect(await screen.findByText('Ship it')).toBeTruthy()
      expect(document.querySelector('[data-prompt-pin]')).toBeNull()
      const band = document.querySelector('[data-tasks-ceiling]')
      expect(band).toBeTruthy()
      expect(band?.closest('[data-transcript-scroll]')).toBeTruthy()

      const owningPrompt = screen.getByText('audit the entire codebase end to end')
      const followUp = screen.getByText('delete it')
      expect(owningPrompt.closest('[data-transcript-scroll]')).toBeTruthy()
      expect(followUp.closest('[data-transcript-scroll]')).toBeTruthy()
      expect(
        owningPrompt.compareDocumentPosition(band!) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      expect(band!.compareDocumentPosition(followUp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

      expect(screen.queryByRole('tab', { name: /^Tasks$/i })).toBeNull()
      expect(document.querySelector('[data-tasks-panel]')).toBeNull()
    })

    it('keeps prompts in normal scroll order when the turn has no tasks', async () => {
      render(
        <ChatView
          {...baseProps}
          agentMode="agent"
          activeRunId="run-1"
          running
          items={[
            {
              kind: 'message',
              id: 'user-0',
              role: 'user',
              content: 'just say hello',
              at: '2024-01-01T00:00:00.000Z'
            },
            {
              kind: 'message',
              id: 'a1',
              role: 'assistant',
              content: 'Hello.',
              at: '2024-01-01T00:00:01.000Z'
            }
          ]}
        />
      )

      const prompt = await screen.findByText('just say hello')
      expect(prompt.closest('[data-transcript-scroll]')).toBeTruthy()
      expect(document.querySelector('[data-prompt-pin]')).toBeNull()
      expect(document.querySelector('[data-tasks-ceiling]')).toBeNull()
      expect(screen.getByText('Hello.').closest('[data-transcript-scroll]')).toBeTruthy()
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
    fireEvent.click(screen.getByRole('button', { name: /Show browser panel/i }))
    expect(screen.getByText('Recents')).toBeTruthy()
    expect(screen.getByText('Example Domain')).toBeTruthy()
  })

  it('renders a single docked composer in empty state', () => {
    render(<ChatView {...baseProps} items={[]} />)

    const composers = screen.getAllByRole('combobox', { name: /^Message$/i })
    expect(composers).toHaveLength(1)

    expect(document.querySelector('[data-composer-hero]')).toBeNull()
    expect(document.querySelector('[data-composer-dock]')).toBeTruthy()
    expect(document.querySelector('[data-chat-hero]')).toBeNull()
    expect(screen.queryByText(/Type \/ for commands/i)).toBeNull()
  })

  it('renders a floating edge rail over the chat stage', () => {
    render(
      <ChatView
        {...baseProps}
        items={[
          {
            kind: 'message',
            id: 'm1',
            role: 'user',
            content: 'hello',
            at: '2024-01-01T00:00:00.000Z'
          }
        ]}
      />
    )

    const rail = document.querySelector('[data-chat-side-rail]')
    expect(rail?.className).toMatch(/absolute/)
    expect(rail?.className).toMatch(/right-0/)
    // Floating composer column aligns edge to edge with the transcript column.
    const dock = document.querySelector('[data-composer-dock]')
    expect(dock?.className).toMatch(/inset-x-0/)
    expect(dock?.className).toMatch(/pr-10/)
    expect(document.querySelector('[data-transcript-scroll]')?.className).toMatch(/pr-10/)
  })

  it('keeps open right panels without reserving side-rail padding', async () => {
    render(
      <ChatView
        {...baseProps}
        items={[
          {
            kind: 'message',
            id: 'm1',
            role: 'user',
            content: 'hello',
            at: '2024-01-01T00:00:00.000Z'
          }
        ]}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Show plan panel/i }))
    await waitForPanel('[data-plan-panel]')
    const dock = document.querySelector('[data-right-dock]')
    expect(dock?.className).not.toMatch(/pr-10/)
    expect(dock?.className).toMatch(/min-w-0/)
    expect(document.querySelector('[data-chat-side-rail]')).toBeNull()
    expect(document.querySelector('[data-dock-tab-bar]')).toBeTruthy()
    expect(document.querySelector('[data-plan-panel]')).toBeTruthy()
    // Agent column must drop rail inset once the floating rail is hidden.
    expect(document.querySelector('[data-composer-dock]')?.className).not.toMatch(/pr-10/)
    expect(document.querySelector('[data-transcript-scroll]')?.className).not.toMatch(/pr-10/)
  })

  it('floats the empty-chat composer over the transcript column', () => {
    render(<ChatView {...baseProps} items={[]} />)

    expect(document.querySelector('[data-chat-hero]')).toBeNull()
    const dock = document.querySelector('[data-composer-dock]')
    expect(dock?.className).toMatch(/absolute/)
    expect(dock?.className).toMatch(/bottom-2/)
    // Same gutters as the transcript so the column edges line up.
    expect(dock?.className).toMatch(/pl-4/)
    expect(dock?.className).toMatch(/pr-10/)

    const column = document.querySelector('[data-composer-column]')
    expect(column?.className).toMatch(/mx-auto/)
    expect(column?.className).toMatch(/max-w-\[840px\]/)
    expect(document.querySelector('[data-hero-brand]')).toBeNull()
    expect(document.querySelector('[data-brand-lockup]')).toBeNull()
  })

  it('top-aligns the side rail on empty chat', () => {
    render(<ChatView {...baseProps} items={[]} />)
    const rail = document.querySelector('[data-chat-side-rail]')
    expect(rail?.className).toMatch(/justify-start/)
    expect(rail?.className).toMatch(/pt-4/)
    expect(rail?.className).not.toMatch(/justify-center/)
  })

  it('top-aligns the side rail when transcript is visible', () => {
    render(
      <ChatView
        {...baseProps}
        items={[
          {
            kind: 'message',
            id: 'm1',
            role: 'user',
            content: 'hello',
            at: '2024-01-01T00:00:00.000Z'
          }
        ]}
      />
    )
    const rail = document.querySelector('[data-chat-side-rail]')
    expect(rail?.className).toMatch(/justify-start/)
    expect(rail?.className).toMatch(/pt-4/)
  })

  it('aligns the floating composer with the transcript column under the rail', () => {
    render(<ChatView {...baseProps} items={[]} />)
    const dock = document.querySelector('[data-composer-dock]')
    expect(dock?.className).toMatch(/inset-x-0/)
    expect(dock?.className).toMatch(/pr-10/)
    expect(document.querySelector('[data-chat-side-rail]')).toBeTruthy()
  })

  it('switches panels via dock tabs while keeping prior panels mounted', async () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    fireEvent.click(screen.getByRole('button', { name: /Show changes panel/i }))
    await waitFor(() => {
      expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    })
    await waitForPanel('[data-changes-panel]')
    expect(document.querySelector('[data-dock-tab-bar]')).toBeTruthy()
    // Multi-tab strip keeps both Terminal and Changes.
    expect(screen.getByRole('tab', { name: /^Terminal$/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Changes$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /^Terminal$/i }))
    expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    expect(
      document.querySelector('[data-terminal-panel]')?.parentElement?.className
    ).toMatch(/\bflex\b/)
    expect(
      document.querySelector('[data-changes-panel]')?.parentElement?.className
    ).toMatch(/\bhidden\b/)
  })

  it('opens a missing panel from the dock quick launch icons', async () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    fireEvent.click(screen.getByRole('button', { name: /Show browser panel/i }))
    await waitForPanel('[data-agent-browser-panel]')
    expect(screen.getByRole('tab', { name: /^Terminal$/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Browser$/i })).toBeTruthy()
  })

  it('enters immersive unified tabs from Expand panel (not a wider side dock)', async () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    await waitFor(() => {
      expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    })
    const dock = document.querySelector('[data-right-dock]') as HTMLElement | null
    expect(dock?.getAttribute('data-dock-expanded')).toBe('0')
    const dockWidthPx = Number.parseInt(dock?.style.width ?? '0', 10)
    expect(dockWidthPx).toBe(
      clampDockWidthPx(DOCK_WIDTH_DEFAULT_PX, window.innerWidth, {
        paneCount: 1,
        sidebarWidthPx: readSidebarWidthPxForCapacity(),
        dockOpen: true
      })
    )
    expect(document.querySelector('[data-dock-immersive]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Expand panel$/i }))
    expect(document.querySelector('[data-right-dock]')).toBeNull()
    const immersive = document.querySelector('[data-dock-immersive]')
    expect(immersive).toBeTruthy()
    expect(immersive?.getAttribute('data-dock-expanded')).toBe('1')
    expect(screen.getByRole('tab', { name: /^Agent$/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Terminal$/i })).toBeTruthy()
    expect(document.querySelector('[data-dock-tab-variant="immersive"]')).toBeTruthy()
    expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    // Collapse control must not reuse the window-minimize (minus) icon.
    expect(screen.getByRole('button', { name: /^Collapse panel$/i })).toBeTruthy()
    const tablist = document.querySelector('[data-dock-tab-bar] [role="tablist"]')
    expect(tablist?.className).toMatch(/\bflex-row\b/)
    fireEvent.click(screen.getByRole('button', { name: /^Collapse panel$/i }))
    expect(document.querySelector('[data-dock-immersive]')).toBeNull()
    const restored = document.querySelector('[data-right-dock]') as HTMLElement | null
    expect(restored).toBeTruthy()
    expect(restored?.getAttribute('data-dock-expanded')).toBe('0')
    expect(document.querySelector('[data-terminal-panel]')).toBeTruthy()
    // Re-expand and switch to Agent
    fireEvent.click(screen.getByRole('button', { name: /^Expand panel$/i }))
    fireEvent.click(screen.getByRole('tab', { name: /^Agent$/i }))
    expect(document.querySelector('[data-immersive-agent]')?.className).toMatch(/\bflex\b/)
    expect(
      document.querySelector('[data-terminal-panel]')?.parentElement?.className
    ).toMatch(/\bhidden\b/)
  })

  it('portals immersive dock tabs into the titlebar when the shell host is present', () => {
    render(
      <BreakpointProvider>
        <TitleBarAccessoryProvider>
          <TitleBar drawerOpen={false} onToggleSidebar={() => {}} />
          <ChatView {...baseProps} items={[]} />
        </TitleBarAccessoryProvider>
      </BreakpointProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Expand panel$/i }))

    const titlebar = document.querySelector('[data-titlebar]')
    const accessory = document.querySelector('[data-titlebar-accessory]')
    const immersiveBar = document.querySelector('[data-dock-tab-variant="immersive"]')
    expect(titlebar).toBeTruthy()
    expect(accessory).toBeTruthy()
    expect(immersiveBar).toBeTruthy()
    expect(accessory?.contains(immersiveBar)).toBe(true)
    expect(document.querySelector('[data-dock-immersive] [data-dock-tab-bar]')).toBeNull()
    expect(screen.getByRole('tab', { name: /^Agent$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Collapse panel$/i })).toBeTruthy()

    // Accessory host stays draggable; only tab/action clusters are no-drag.
    expect(accessory?.className).not.toMatch(/app-region-no-drag/)
    const tablist = immersiveBar?.querySelector('[role="tablist"]')
    expect(tablist?.className).toMatch(/app-region-no-drag/)
    expect(tablist?.className).toMatch(/\bflex-1\b/)
    expect(immersiveBar?.querySelector('[data-titlebar-drag-spacer]')).toBeTruthy()

    // Agent tab matches other tabs: icon then label.
    const agentTab = screen.getByRole('tab', { name: /^Agent$/i })
    const agentChildren = Array.from(agentTab.childNodes).filter(
      (n) => n.nodeType === Node.ELEMENT_NODE
    ) as Element[]
    expect(agentChildren[0]?.tagName.toLowerCase()).toBe('svg')
    expect(agentChildren[1]?.textContent).toMatch(/^Agent$/i)

    const quickLaunch = document.querySelector('[data-dock-quick-launch]')
    expect(quickLaunch).toBeTruthy()
    expect(quickLaunch?.closest('.app-region-no-drag')).toBeTruthy()
    const collapse = screen.getByRole('button', { name: /^Collapse panel$/i })
    expect(collapse.parentElement?.className).toMatch(/\bpr-2\b/)
    // Quick launch shares the right cluster with collapse (drag spacer sits between tabs and actions).
    expect(quickLaunch?.parentElement).toBe(collapse.parentElement)
    const spacer = immersiveBar?.querySelector('[data-titlebar-drag-spacer]')
    expect(spacer).toBeTruthy()
    expect(
      spacer!.compareDocumentPosition(quickLaunch!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('portals side-dock tabs into the titlebar aligned to the dock column', async () => {
    render(
      <BreakpointProvider>
        <TitleBarAccessoryProvider>
          <TitleBar drawerOpen={false} onToggleSidebar={() => {}} />
          <ChatView {...baseProps} items={[]} />
        </TitleBarAccessoryProvider>
      </BreakpointProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: /Show browser panel/i }))
    await waitForPanel('[data-agent-browser-panel]')

    const accessory = document.querySelector('[data-titlebar-accessory]')
    const portal = document.querySelector('[data-dock-titlebar-portal]')
    const tabsHost = document.querySelector('[data-dock-titlebar-tabs]')
    const dock = document.querySelector('[data-right-dock]')
    expect(accessory?.contains(portal)).toBe(true)
    expect(portal?.querySelector('[data-titlebar-drag-spacer]')).toBeTruthy()
    expect(tabsHost).toBeTruthy()
    expect(document.querySelector('[data-dock-embedded="1"]')).toBeTruthy()
    expect(document.querySelector('[data-dock-column-portal]')).toBeNull()
    expect(dock?.querySelector('[data-dock-tab-bar]')).toBeNull()
    expect(screen.getByRole('tab', { name: /^Browser$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Expand panel$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Expand panel$/i }).parentElement?.className).toMatch(
      /\bpr-2\b/
    )
    expect(screen.getByPlaceholderText('Search or enter URL')).toBeTruthy()

    // Tabs strip is dock width minus caption buttons so left edge matches the panel.
    const dockWidth = Number.parseFloat(
      (dock as HTMLElement | null)?.style.width?.replace('px', '') ?? ''
    )
    const tabsWidth = Number.parseFloat(
      (tabsHost as HTMLElement | null)?.style.width?.replace('px', '') ?? ''
    )
    expect(dockWidth).toBeGreaterThan(0)
    expect(tabsWidth).toBe(dockWidth - 132)
  })

  it('keeps side-dock tabs in the aside when the titlebar host is absent', async () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show browser panel/i }))
    await waitForPanel('[data-agent-browser-panel]')

    expect(document.querySelector('[data-dock-titlebar-portal]')).toBeNull()
    expect(document.querySelector('[data-right-dock] [data-dock-tab-bar]')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Browser$/i })).toBeTruthy()
  })

  it('collapsing immersive from Agent restores full chat without a side dock', () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Expand panel$/i }))
    fireEvent.click(screen.getByRole('tab', { name: /^Agent$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Collapse panel$/i }))
    expect(document.querySelector('[data-dock-immersive]')).toBeNull()
    expect(document.querySelector('[data-right-dock]')).toBeNull()
    expect(document.querySelector('[data-chat-side-rail]')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Expand panel$/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Expand panel$/i }))
    expect(document.querySelector('[data-dock-immersive]')).toBeTruthy()
    expect(document.querySelector('[data-immersive-agent]')?.className).toMatch(/\bflex\b/)
  })

  it('exposes a drag handle to resize the dock', () => {
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show terminal panel/i }))
    expect(screen.getByRole('separator', { name: /Resize panel/i })).toBeTruthy()
  })

  it('opens the pull request panel from the side rail', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        ...(window.vyotiq as object),
        prView: vi.fn().mockResolvedValue({ ok: true, data: null })
      }
    })
    render(<ChatView {...baseProps} items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /Show pull request panel/i }))
    await waitFor(() => {
      expect(document.querySelector('[data-pr-panel]')).toBeTruthy()
    })
  })

  it('renders the composer floating over the chat stage', () => {
    render(
      <ChatView
        {...baseProps}
        items={[
          {
            kind: 'message',
            id: 'm1',
            role: 'user',
            content: 'hello',
            at: '2024-01-01T00:00:00.000Z'
          }
        ]}
      />
    )

    const composerRoot = document.querySelector('[data-composer-dock]')
    expect(composerRoot?.className).toMatch(/absolute/)
    expect(composerRoot?.className).toMatch(/inset-x-0/)
    expect(composerRoot?.className).toMatch(/bottom-2/)
    expect(composerRoot?.className).toMatch(/z-20/)
    expect(composerRoot?.className).not.toMatch(/shrink-0/)
  })

  it('uses dock layout while loading transcript for an active run', () => {
    render(
      <ChatView
        {...baseProps}
        items={[]}
        activeRunId="run-1"
        transcriptLoading
      />
    )

    expect(document.querySelector('[data-composer-hero]')).toBeNull()
    expect(document.querySelector('[data-composer-dock]')).toBeTruthy()
    expect(document.querySelector('[data-empty-brand]')).toBeNull()
    expect(screen.getAllByText(/loading chat/i).length).toBeGreaterThan(0)
  })

  it('uses dock layout for an active run tab with no messages', () => {
    render(<ChatView {...baseProps} items={[]} activeRunId="run-1" />)

    expect(document.querySelector('[data-composer-hero]')).toBeNull()
    expect(document.querySelector('[data-chat-hero]')).toBeNull()
    expect(document.querySelector('[data-composer-dock]')).toBeTruthy()
    expect(document.querySelector('[data-empty-brand]')).toBeNull()
    expect(document.querySelector('[data-brand-lockup]')).toBeNull()
    expect(screen.queryByText(/\/create-rule/)).toBeNull()
  })

  it('hides the empty-chat lockup once the transcript has messages', () => {
    render(
      <ChatView
        {...baseProps}
        activeRunId="run-1"
        items={[
          {
            kind: 'message',
            id: 'm1',
            role: 'user',
            content: 'hello',
            at: '2024-01-01T00:00:00.000Z'
          }
        ]}
      />
    )

    expect(document.querySelector('[data-empty-brand]')).toBeNull()
    expect(document.querySelector('[data-composer-dock]')).toBeTruthy()
  })

  it('keeps transcript and composer in the same centered floating column', () => {
    render(
      <ChatView
        {...baseProps}
        items={[
          {
            kind: 'message',
            id: 'm1',
            role: 'user',
            content: 'hello',
            at: '2024-01-01T00:00:00.000Z'
          }
        ]}
      />
    )

    const transcriptColumn = document.querySelector('[data-chat-column]')
    expect(transcriptColumn?.className).toMatch(/mx-auto/)
    expect(transcriptColumn?.className).toMatch(/max-w-\[840px\]/)
    expect(transcriptColumn?.className).toMatch(/w-full/)

    const composerColumn = document.querySelector('[data-composer-column]')
    expect(composerColumn?.className).toMatch(/mx-auto/)
    expect(composerColumn?.className).toMatch(/max-w-\[840px\]/)
    expect(composerColumn?.className).toMatch(/w-full/)

    const composerRoot = document.querySelector('[data-composer-dock]')
    expect(composerRoot?.className).toMatch(/absolute/)
    expect(composerRoot?.className).toMatch(/inset-x-0/)
    expect(composerRoot?.className).toMatch(/pl-4/)
    expect(composerRoot?.className).toMatch(/pr-10/)
    expect(composerRoot?.className).not.toMatch(/\bbg-bg\b/)
  })

  it('reserves floating composer height on the transcript scrollport', () => {
    render(
      <ChatView
        {...baseProps}
        items={[
          {
            kind: 'message',
            id: 'm1',
            role: 'user',
            content: 'hello',
            at: '2024-01-01T00:00:00.000Z'
          }
        ]}
      />
    )

    const stage = document.querySelector('[data-chat-stage]') as HTMLElement | null
    const transcript = document.querySelector('[data-transcript-scroll]') as HTMLElement | null
    expect(stage).toBeTruthy()
    expect(transcript).toBeTruthy()
    // The floating dock publishes its measured height on the stage (jsdom: 0px)
    // and the transcript reserves it plus clearance.
    expect(stage!.style.getPropertyValue('--vy-composer-dock-height')).toMatch(/px$/)
    expect(transcript!.style.paddingBottom).toContain('var(--vy-composer-dock-height')
    expect(document.querySelector('[data-composer-dock]')).toBeTruthy()
  })

  it('remounts the transcript when chatSurfaceEpoch changes but not for draft alone', () => {
    const items = [
      {
        kind: 'message' as const,
        id: 'm1',
        role: 'user' as const,
        content: 'hello',
        at: '2024-01-01T00:00:00.000Z'
      }
    ]
    const { rerender } = render(
      <ChatView {...baseProps} items={items} chatSurfaceEpoch={0} activeRunId={null} />
    )
    const first = document.querySelector('[data-transcript-scroll]')
    expect(first).toBeTruthy()

    rerender(
      <ChatView {...baseProps} items={items} chatSurfaceEpoch={0} activeRunId="run-1" />
    )
    expect(document.querySelector('[data-transcript-scroll]')).toBe(first)

    rerender(
      <ChatView {...baseProps} items={items} chatSurfaceEpoch={1} activeRunId="run-1" />
    )
    expect(document.querySelector('[data-transcript-scroll]')).not.toBe(first)
  })

  it('attaches an active goal banner above the docked composer', async () => {
    const goalJson = JSON.stringify({
      objective: 'Ship the composer banner',
      status: 'active',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z'
    })
    ;(window.vyotiq as unknown as Record<string, unknown>).readRunArtifact = vi
      .fn()
      .mockImplementation(async (args: { name?: string }) =>
        args.name === 'goal.json'
          ? { ok: true, data: { content: goalJson } }
          : { ok: false, error: 'none' }
      )

    render(
      <ChatView
        {...baseProps}
        activeRunId="run-1"
        items={[
          {
            kind: 'message',
            id: 'm1',
            role: 'user',
            content: 'hello',
            at: '2024-01-01T00:00:00.000Z'
          }
        ]}
      />
    )

    const banner = await waitFor(() => {
      const el = document.querySelector('[data-goal-banner][data-goal-status="active"]')
      expect(el).toBeTruthy()
      return el as HTMLElement
    })

    // Lives inside the chat stage, below the transcript — no longer above the first bubble.
    expect(banner.closest('[data-chat-stage]')).toBeTruthy()
    const transcript = document.querySelector('[data-transcript-scroll]')
    expect(
      banner.compareDocumentPosition(transcript!) & Node.DOCUMENT_POSITION_PRECEDING
    ).toBeTruthy()

    // Sits immediately above the docked composer.
    const dock = document.querySelector('[data-composer-dock]')
    expect(dock).toBeTruthy()
    expect(
      banner.compareDocumentPosition(dock!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    const wrapper = banner.parentElement!.parentElement!
    expect(wrapper.nextElementSibling!.contains(dock!)).toBe(true)

    // Shares the centered chat column with the composer, with its own gap so the
    // banner and the input never read as one combined block.
    expect(banner.parentElement!.className).toMatch(/mx-auto/)
    expect(banner.parentElement!.className).toMatch(/max-w-\[840px\]/)
    expect(wrapper.className).toMatch(/pb-1\.5/)
  })
})

describe('ChatView review-changes request', () => {
  it('opens Changes once and acks the owner so a remount cannot replay the request', async () => {
    const onHandled = vi.fn()
    const view = (request: number) => (
      <ChatView
        {...baseProps}
        items={[]}
        openChangesRequest={request}
        onOpenChangesRequestHandled={onHandled}
      />
    )
    const { rerender, unmount } = render(view(1))
    await waitForPanel('[data-changes-panel]')
    expect(onHandled).toHaveBeenCalledTimes(1)

    // The same request value must not re-fire while mounted.
    rerender(view(1))
    expect(onHandled).toHaveBeenCalledTimes(1)

    // Owner consumes -> resets to 0; a later request may reuse the same value.
    rerender(view(0))
    rerender(view(1))
    await waitFor(() => expect(onHandled).toHaveBeenCalledTimes(2))

    // After the owner reset, a remount must not replay the consumed request and
    // force the Changes dock back open.
    unmount()
    localStorage.removeItem('vyotiq.rightPanel')
    render(view(0))
    await waitFor(() => expect(document.querySelector('[data-changes-panel]')).toBeNull())
    expect(onHandled).toHaveBeenCalledTimes(2)
  })
})
