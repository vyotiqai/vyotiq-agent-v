/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChatView } from '@renderer/features/chat/ChatView'
import { emptySecretStatus } from '@shared/ipc'
import type { UiItem } from '@shared/transcript'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
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
      readRunArtifact: vi.fn().mockResolvedValue({ ok: false, error: 'none' })
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const baseProps = {
  items: [] as UiItem[],
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

function toolItem(
  name: string,
  status: 'running' | 'done',
  extra: { summary?: string; argsPreview?: string } = {}
): UiItem {
  return {
    kind: 'tool',
    id: `${name}-${status}`,
    tool: {
      id: `call-${name}-${status}`,
      name,
      summary: extra.summary ?? '',
      status,
      argsPreview: extra.argsPreview
    }
  }
}

const activeRow = (panel: string): Element | null =>
  document.querySelector(`[data-rail-row="${panel}"][data-rail-active]`)

describe('ChatSideRail live state from the run', () => {
  it('pulses Files with the file the run is writing, relative to the workspace', () => {
    render(
      <ChatView
        {...baseProps}
        running
        items={[toolItem('edit', 'running', { argsPreview: '{"path":"/ws/src/app.ts"}' })]}
      />
    )
    expect(activeRow('files')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /Show files panel · Editing src\/app\.ts/i })
    ).toBeTruthy()
  })

  it('pulses Terminal with the command the run is executing', () => {
    render(
      <ChatView
        {...baseProps}
        running
        items={[toolItem('terminal', 'running', { summary: 'pnpm test' })]}
      />
    )
    expect(activeRow('terminal')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /Show terminal panel · Running pnpm test/i })
    ).toBeTruthy()
  })

  it('marks both panels when the run has an edit and a command in flight', () => {
    render(
      <ChatView
        {...baseProps}
        running
        items={[
          toolItem('terminal', 'running', { summary: 'pnpm test' }),
          toolItem('edit', 'running', { argsPreview: '{"path":"src/app.ts"}' })
        ]}
      />
    )
    expect(activeRow('files')).toBeTruthy()
    expect(activeRow('terminal')).toBeTruthy()
  })

  it('marks a call that has not named its target yet', () => {
    render(<ChatView {...baseProps} running items={[toolItem('edit', 'running')]} />)
    expect(activeRow('files')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /Show files panel · Editing a file/i })
    ).toBeTruthy()
  })

  it('drops the marker once the call settles — only in-flight work pulses', () => {
    render(
      <ChatView
        {...baseProps}
        running
        items={[toolItem('edit', 'done', { argsPreview: '{"path":"src/app.ts"}' })]}
      />
    )
    expect(activeRow('files')).toBeNull()
  })

  it('shows no marker for a finished run', () => {
    render(
      <ChatView
        {...baseProps}
        items={[toolItem('edit', 'running', { argsPreview: '{"path":"src/app.ts"}' })]}
      />
    )
    expect(activeRow('files')).toBeNull()
  })

  it('counts unresolved agent writes on Changes', () => {
    render(
      <ChatView
        {...baseProps}
        writeCheckpointFiles={[
          { path: 'src/app.ts', action: 'modified' },
          { path: 'src/new.ts', action: 'created' }
        ]}
      />
    )
    expect(
      document.querySelector('[data-rail-row="changes"] [data-rail-count]')?.textContent
    ).toBe('2')
    expect(
      screen.getByRole('button', { name: /Show changes panel · 2 files to review/i })
    ).toBeTruthy()
  })

  it('leaves Changes unmarked when nothing is pending', () => {
    render(<ChatView {...baseProps} />)
    expect(document.querySelector('[data-rail-row="changes"] [data-rail-count]')).toBeNull()
  })
})
