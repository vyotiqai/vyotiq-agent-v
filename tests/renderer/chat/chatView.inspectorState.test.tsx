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
      readRunArtifact: vi.fn().mockResolvedValue({ ok: false, error: 'none' }),
      runFeedbackGet: vi.fn().mockResolvedValue({ ok: true, data: { entry: null } })
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

const tab = (label: string): HTMLElement =>
  screen.getByRole('tab', { name: new RegExp(`^${label}`) })
const live = (label: string): boolean => tab(label).textContent?.includes('working now') ?? false

describe('Inspector tabs: live state from the run', () => {
  it('lists all six tabs in strip order, on Changes by default', () => {
    render(<ChatView {...baseProps} />)
    const strip = screen.getByRole('tablist', { name: 'Inspector' })
    const labels = Array.from(strip.querySelectorAll('[role="tab"]')).map((t) => t.firstChild?.textContent)
    expect(labels).toEqual(['Changes', 'Files', 'Terminal', 'Browser', 'PR', 'Plan'])
    expect(tab('Changes').getAttribute('aria-selected')).toBe('true')
    // Each tab says its chord.
    expect(tab('Plan').getAttribute('title')).toBe('Alt+6')
  })

  it('marks Files live with the file the run is writing, relative to the workspace', () => {
    render(
      <ChatView
        {...baseProps}
        running
        items={[toolItem('edit', 'running', { argsPreview: '{"path":"/ws/src/app.ts"}' })]}
      />
    )
    expect(live('Files')).toBe(true)
    expect(tab('Files').getAttribute('title')).toBe('Editing src/app.ts · Alt+2')
  })

  it('marks Terminal live with the command the run is executing', () => {
    render(
      <ChatView
        {...baseProps}
        running
        items={[toolItem('terminal', 'running', { summary: 'pnpm test' })]}
      />
    )
    expect(live('Terminal')).toBe(true)
    expect(tab('Terminal').getAttribute('title')).toBe('Running pnpm test · Alt+3')
  })

  it('marks both tabs when the run has an edit and a command in flight', () => {
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
    expect(live('Files')).toBe(true)
    expect(live('Terminal')).toBe(true)
  })

  it('marks a call that has not named its target yet', () => {
    render(<ChatView {...baseProps} running items={[toolItem('edit', 'running')]} />)
    expect(live('Files')).toBe(true)
    expect(tab('Files').getAttribute('title')).toBe('Editing a file · Alt+2')
  })

  it('marks Plan live while create_plan writes the plan', () => {
    render(<ChatView {...baseProps} running items={[toolItem('create_plan', 'running')]} />)
    expect(live('Plan')).toBe(true)
    expect(tab('Plan').getAttribute('title')).toBe('Writing the plan · Alt+6')
  })

  it('drops the dot once the call settles — only in-flight work is live', () => {
    render(
      <ChatView
        {...baseProps}
        running
        items={[toolItem('edit', 'done', { argsPreview: '{"path":"src/app.ts"}' })]}
      />
    )
    expect(live('Files')).toBe(false)
    expect(tab('Files').getAttribute('title')).toBe('Alt+2')
  })

  it('shows no dot for a finished run', () => {
    render(
      <ChatView
        {...baseProps}
        items={[toolItem('edit', 'running', { argsPreview: '{"path":"src/app.ts"}' })]}
      />
    )
    expect(live('Files')).toBe(false)
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
    expect(tab('Changes').textContent).toBe('Changes2')
    expect(tab('Changes').getAttribute('title')).toBe('2 files to review · Alt+1')
  })

  it('leaves Changes without a count when nothing is pending', () => {
    render(<ChatView {...baseProps} />)
    expect(tab('Changes').textContent).toBe('Changes')
    expect(tab('Changes').getAttribute('title')).toBe('Alt+1')
  })
})
