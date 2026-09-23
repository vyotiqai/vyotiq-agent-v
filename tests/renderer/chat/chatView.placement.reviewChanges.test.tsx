/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ChatView } from '@renderer/features/chat/ChatView'
import { emptySecretStatus } from '@shared/ipc'
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
