/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatView } from '@renderer/features/chat/ChatView'
import { emptySecretStatus } from '@shared/ipc'
import type { ChatItemsStore } from '@renderer/features/chat/chatStores'
import type { UiItem } from '@shared/transcript'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
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

describe('ChatView operational errors', () => {
  it('surfaces operational and chat errors together when both are set', () => {
    const onDismissError = vi.fn()
    render(
      <ChatView
        {...baseProps}
        error="Chat stream failed"
        operationalError="Failed to rename run"
        onDismissError={onDismissError}
      />
    )

    expect(screen.getByText('Failed to rename run')).toBeTruthy()
    expect(screen.getByText('Chat stream failed')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(onDismissError).toHaveBeenCalled()
  })

  it('shows the chat error when no operational error is set', () => {
    render(<ChatView {...baseProps} error="Could not list sessions" onDismissError={vi.fn()} />)
    expect(screen.getByRole('alert').textContent).toContain('Could not list sessions')
  })

  it('shows operational errors on the hero composer when workspace is unset', () => {
    render(
      <ChatView
        {...baseProps}
        hasWorkspace={false}
        workspacePath={null}
        operationalError="Pick workspace failed"
      />
    )

    expect(screen.getByRole('alert').textContent).toContain('Pick workspace failed')
    expect(document.querySelector('[data-composer-column], [data-composer-hero]')).toBeTruthy()
    expect(screen.queryByText(/No recent workspaces yet/i)).toBeNull()
  })

  it('suppresses the chat error banner when itemsStore has a run_error but items prop is stale', () => {
    const runErrorItem = {
      kind: 'run_error',
      id: 'err-1',
      message: 'Run failed in transcript'
    } as UiItem
    // getItems() is a snapshot getter: real stores return one stable identity
    // per revision (chatStoresFor wraps controller.items). A fresh array per
    // call re-rendered every identity-sensitive consumer forever — this suite
    // hung CI until the heap OOM'd on all three OSes.
    const snapshot: UiItem[] = [runErrorItem]
    const itemsStore: ChatItemsStore = {
      subscribeItems: () => () => {},
      getItemsRevision: () => 1,
      getItems: () => snapshot
    }

    render(
      <ChatView
        {...baseProps}
        items={[]}
        itemsStore={itemsStore}
        error="Stale chat error banner"
        activeRunId="run-1"
        onDismissError={vi.fn()}
      />
    )

    expect(screen.queryByText('Stale chat error banner')).toBeNull()
    expect(screen.getByText('Run failed in transcript')).toBeTruthy()
  })
})
