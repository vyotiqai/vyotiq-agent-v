/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatView } from '@renderer/features/chat/ChatView'
import { emptySecretStatus } from '@shared/ipc'
import type { AgentBrowserState } from '@shared/ipc'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  // jsdom localStorage persists across tests in a file — a prior case seeding
  // vyotiq.rightPanel would silently re-open the dock for later cases.
  localStorage.clear()
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: {
      gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { kind: 'not_repo' } }),
      browserGetState: vi.fn().mockResolvedValue({
        ok: true,
        data: { open: false, url: '', title: '' }
      }),
      onBrowserState: vi.fn().mockReturnValue(() => undefined),
      readRunArtifact: vi.fn().mockResolvedValue({ ok: true, data: '' }),
      runFeedbackGet: vi.fn().mockResolvedValue({ ok: true, data: { entry: null } })
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const baseProps = {
  items: [],
  running: false,
  error: null,
  hasWorkspace: true,
  workspacePath: '/ws',
  provider: 'ollama' as const,
  model: 'qwen2.5',
  // A task is on screen: a new task keeps the inspector out of the way until asked.
  activeRunId: 'run-1',
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

function busyBrowserState(): AgentBrowserState {
  return {
    open: true,
    url: 'https://github.com/vyotiq/agent-v',
    title: 'GitHub',
    navigating: false,
    agentBusy: true,
    userControl: false,
    tabs: [{ id: 't1', title: 'GitHub', url: 'https://github.com/vyotiq/agent-v', active: true }],
    canGoBack: false,
    canGoForward: false
  }
}

const q = (selector: string): Element | null => document.querySelector(selector)
const browserTab = (): HTMLElement => screen.getByRole('tab', { name: /^Browser/ })
/** The inspector is up by default; these cases start with it hidden. */
const hideInspector = (): void => localStorage.setItem('vyotiq.inspectorOpen', '0')

describe('ChatView browser watch affordance', () => {
  it('shows no banner and no live dot while the agent is not browsing', () => {
    render(<ChatView {...baseProps} />)
    expect(q('[data-browser-watch-banner]')).toBeNull()
    expect(browserTab().textContent).not.toContain('working now')
  })

  it('marks the Browser tab live while the agent browses — the strip says it, no banner', async () => {
    vi.mocked(window.vyotiq.browserGetState!).mockResolvedValue({
      ok: true,
      data: busyBrowserState()
    })
    render(<ChatView {...baseProps} />)

    await vi.waitFor(() => {
      expect(browserTab().textContent).toContain('working now')
    })
    expect(browserTab().getAttribute('title')).toBe('Browsing github.com · Alt+4')
    expect(q('[data-browser-watch-banner]')).toBeNull()
  })

  it('shows the watch banner while the agent browses with the inspector hidden', async () => {
    hideInspector()
    vi.mocked(window.vyotiq.browserGetState!).mockResolvedValue({
      ok: true,
      data: busyBrowserState()
    })
    render(<ChatView {...baseProps} />)

    await vi.waitFor(() => {
      expect(q('[data-browser-watch-banner]')).toBeTruthy()
    })
    const banner = q('[data-browser-watch-banner]')!
    expect(banner.textContent).toContain('Agent is browsing')
    expect(banner.textContent).toContain('github.com')
    expect(screen.getByRole('button', { name: /watch live/i })).toBeTruthy()
    expect(q('[data-inspector]')).toBeNull()
  })

  it('hides the banner when the browser panel is already on screen', async () => {
    // ChatView restores the last tab from localStorage on init.
    localStorage.setItem('vyotiq.rightPanel', 'browser')
    vi.mocked(window.vyotiq.browserGetState!).mockResolvedValue({
      ok: true,
      data: busyBrowserState()
    })
    render(<ChatView {...baseProps} />)
    await vi.waitFor(() => {
      expect(q('[data-agent-browser-panel]')).toBeTruthy()
    })
    expect(q('[data-browser-watch-banner]')).toBeNull()
  })

  it('shows the inspector on the live browser when Watch live is clicked', async () => {
    hideInspector()
    vi.mocked(window.vyotiq.browserGetState!).mockResolvedValue({
      ok: true,
      data: busyBrowserState()
    })
    render(<ChatView {...baseProps} />)
    await vi.waitFor(() => {
      expect(q('[data-browser-watch-banner]')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: /watch live/i }))

    await vi.waitFor(() => {
      expect(q('[data-agent-browser-panel]')).toBeTruthy()
    })
    expect(browserTab().getAttribute('aria-selected')).toBe('true')
    // Inspector up → the banner is no longer needed.
    expect(q('[data-browser-watch-banner]')).toBeNull()
  })

  it('reacts to browser state pushes, not just the initial getState', async () => {
    hideInspector()
    let pushHandler: ((next: AgentBrowserState) => void) | undefined
    vi.mocked(window.vyotiq.onBrowserState!).mockImplementation((handler) => {
      pushHandler = handler
      return () => undefined
    })
    render(<ChatView {...baseProps} />)
    expect(q('[data-browser-watch-banner]')).toBeNull()

    pushHandler?.(busyBrowserState())
    await vi.waitFor(() => {
      expect(q('[data-browser-watch-banner]')).toBeTruthy()
    })

    pushHandler?.({ ...busyBrowserState(), agentBusy: false })
    await vi.waitFor(() => {
      expect(q('[data-browser-watch-banner]')).toBeNull()
    })
  })
})
