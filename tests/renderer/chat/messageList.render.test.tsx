/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import {
  estimateTranscriptRowSize,
  MessageList,
  transcriptRowsContentRevision
} from '@renderer/features/chat/components/MessageList'
import { buildTranscriptRows } from '@renderer/features/chat/utils/transcriptRows'
import {
  TOOL_BODY_CLAMP_PX,
  TOOL_GROUP_LIST_ESTIMATE_MIN_PX,
  TOOL_TERMINAL_VIEWPORT_MAX_PX
} from '@renderer/lib/utils/layout'
import type { UiItem } from '@shared/transcript'
import { toolGroup } from './helpers/testGroups'
import { emptyStepUsageTotals } from '@shared/utils/runTelemetry'

function visibleTextMatches(pattern: RegExp): HTMLElement[] {
  return screen
    .getAllByText(pattern)
    .filter((element) => !element.closest('[data-live-receipt-announcement]'))
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  })
  Element.prototype.scrollIntoView = () => {}
})

afterEach(() => {
  cleanup()
})

describe('MessageList', () => {
  it('shows the workspace-scoped empty state for a fresh chat', () => {
    render(<MessageList items={[]} emptyLabel="New chat in demo" />)

    expect(screen.getByText('New chat in demo')).toBeTruthy()
    expect(document.querySelector('[data-chat-empty-state]')).not.toBeNull()
  })

  it('hides the empty state while a send is pending or the run is live', () => {
    const { rerender } = render(
      <MessageList items={[]} pendingRun emptyLabel="New chat in demo" />
    )
    expect(document.querySelector('[data-chat-empty-state]')).toBeNull()

    rerender(<MessageList items={[]} running emptyLabel="New chat in demo" />)
    expect(document.querySelector('[data-chat-empty-state]')).toBeNull()
  })

  it('keeps the transcript bare when no empty label is provided', () => {
    render(<MessageList items={[]} />)

    expect(document.querySelector('[data-chat-empty-state]')).toBeNull()
  })

  it('offers Retry on run_error rows only for retryable failure codes', () => {
    const onRetryNetwork = vi.fn()
    const retryable: UiItem[] = [
      {
        kind: 'run_error',
        id: 're1',
        message: 'Connection dropped mid-stream',
        code: 'PROVIDER_NETWORK'
      }
    ]
    const { rerender } = render(<MessageList items={retryable} onRetryNetwork={onRetryNetwork} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetryNetwork).toHaveBeenCalledTimes(1)

    // Permanent failures (bad key / plan gating) must not offer a doomed Retry.
    const permanent: UiItem[] = [
      { kind: 'run_error', id: 're2', message: 'Plan required', code: 'PROVIDER_AUTH' }
    ]
    rerender(<MessageList items={permanent} onRetryNetwork={onRetryNetwork} />)
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('keeps the narration between tool batches on the page', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'a1', role: 'assistant', content: 'First look.' },
      ...toolGroup('alpha', ['alpha-one.ts', 'alpha-two.ts']),
      { kind: 'message', id: 'a2', role: 'assistant', content: 'Next batch.' },
      ...toolGroup('beta', ['beta-only.ts'])
    ]

    render(<MessageList items={items} />)

    expect(screen.getByText('First look.')).toBeTruthy()
    expect(screen.getByText('Next batch.')).toBeTruthy()
    // Narration separates the two batches, so each keeps its own header.
    expect(screen.getAllByText('Read')).toHaveLength(2)
    expect(screen.getByText('2 files')).toBeTruthy()
    expect(screen.getByText('beta-only.ts')).toBeTruthy()

    const body = document.querySelector('[data-transcript-scroll]')?.textContent ?? ''
    expect(body.indexOf('First look.')).toBeLessThan(body.indexOf('Next batch.'))
  })

  it('streams assistant text and reasoning inline, mid tool loop', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'audit it' },
      ...toolGroup('alpha', ['alpha-one.ts']),
      {
        kind: 'message',
        id: 'a2',
        role: 'assistant',
        content: 'Now checking how the router is wired.',
        thinking: 'The table is built up front.',
        thinkingStreaming: true,
        streaming: true
      }
    ]

    render(<MessageList items={items} />)

    expect(screen.getByText('Now checking how the router is wired.')).toBeTruthy()
    expect(screen.getByText('The table is built up front.')).toBeTruthy()
  })

  it('holds the closing-answer copy hidden while streaming, then shows it', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'summarize', at: '2026-08-16T10:00:00Z' },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'Here is the summary you asked for.',
        at: '2026-08-16T10:00:05Z',
        streaming: true
      }
    ]

    const { rerender } = render(<MessageList items={items} />)
    expect(document.querySelector('[aria-label="Copy message"]')).toBeNull()
    expect(screen.getByText('5s')).toBeTruthy()

    rerender(
      <MessageList
        items={items.map((item) =>
          item.kind === 'message' && item.id === 'a1' ? { ...item, streaming: false } : item
        )}
      />
    )
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy()
  })

  it('puts turn duration on the closing answer instead of the turn summary', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'read it', at: '2026-08-18T10:00:00.000Z' },
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'file.ts', status: 'done' },
        groupTiming: {
          startedAt: Date.parse('2026-08-18T10:00:01.000Z'),
          endedAt: Date.parse('2026-08-18T10:00:09.000Z')
        }
      },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'Done reading.',
        at: '2026-08-18T10:00:09.000Z'
      }
    ]

    render(<MessageList items={items} />)
    expect(screen.getByText('Completed')).toBeTruthy()
    expect(screen.queryByText(/Completed for/)).toBeNull()
    expect(screen.getAllByText('9s')).toHaveLength(1)
  })

  it('shows live receipt on the turn summary instead of the streaming footer', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'read it', at: '2026-08-18T10:00:00.000Z' },
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'file.ts', status: 'running' },
        groupTiming: { startedAt: Date.parse('2026-08-18T10:00:01.000Z') }
      },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'Looking now.',
        at: '2026-08-18T10:00:09.000Z',
        streaming: true
      }
    ]
    const usage = {
      ...emptyStepUsageTotals(),
      steps: 1,
      billedInputTokens: 200,
      outputTokens: 40,
      generationMs: 2500
    }

    render(<MessageList items={items} running turnUsage={[usage]} />)
    expect(visibleTextMatches(/tok/)).toHaveLength(1)
    expect(visibleTextMatches(/16 output tok\/s/)).toHaveLength(1)
    expect(screen.queryByText(/\$/)).toBeNull()
  })

  it('keeps the receipt on Completed when the turn has tools but no closing answer', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'read it', at: '2026-08-18T10:00:00.000Z' },
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'file.ts', status: 'done' },
        groupTiming: {
          startedAt: Date.parse('2026-08-18T10:00:01.000Z'),
          endedAt: Date.parse('2026-08-18T10:00:09.000Z')
        }
      }
    ]
    const usage = {
      ...emptyStepUsageTotals(),
      steps: 1,
      billedInputTokens: 200,
      outputTokens: 40,
      generationMs: 2500
    }

    render(<MessageList items={items} turnUsage={[usage]} />)
    expect(screen.getByText(/Completed/)).toBeTruthy()
    expect(visibleTextMatches(/tok/)).toHaveLength(1)
    expect(screen.getByText(/9s/)).toBeTruthy()
  })

  it('labels a cancelled partial answer and does not offer copy', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'stop it', at: '2026-08-18T10:00:00.000Z' },
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'file.ts', status: 'fail', content: 'Cancelled' },
        groupTiming: {
          startedAt: Date.parse('2026-08-18T10:00:01.000Z'),
          endedAt: Date.parse('2026-08-18T10:00:04.000Z')
        }
      },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'Partial answer before stopping.',
        at: '2026-08-18T10:00:04.000Z'
      }
    ]

    render(<MessageList items={items} turnStatus="cancelled" />)
    expect(screen.getByText('Cancelled')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull()
  })

  it('reads live turn usage from the meta store without a parent re-render of items', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'go', at: '2026-08-18T10:00:00.000Z' },
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'file.ts', status: 'running' }
      }
    ]
    let slots = [emptyStepUsageTotals()]
    let revision = 0
    const listeners = new Set<() => void>()
    const metaStore = {
      subscribeMeta: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      getMetaRevision: () => revision,
      getContextUsage: () => null,
      getTurnUsage: () => slots
    }

    render(<MessageList items={items} running metaStore={metaStore} />)
    expect(screen.queryByText(/tok/)).toBeNull()

    slots = [
      {
        ...emptyStepUsageTotals(),
        steps: 1,
        billedInputTokens: 200,
        outputTokens: 40,
        generationMs: 2500
      }
    ]
    revision += 1
    act(() => {
      for (const listener of listeners) listener()
    })
    expect(visibleTextMatches(/tok/)).toHaveLength(1)
    expect(visibleTextMatches(/16 output tok\/s/)).toHaveLength(1)
  })
})
