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

function toolGroup(groupKey: string, summaries: string[]): UiItem[] {
  return summaries.map((summary, i) => ({
    kind: 'tool' as const,
    id: `${groupKey}-${i}`,
    tool: {
      id: `${groupKey}-${i}`,
      name: 'read',
      summary,
      status: 'done' as const
    },
    groupTiming: i === 0 ? { startedAt: 1_000, endedAt: 2_000 } : undefined
  }))
}

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

  it('does not re-apply scroll restore when restoreScrollTop updates without a new token', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'msg-1', role: 'assistant', content: 'Hello', streaming: true }
    ]

    const scrollTopSpy = vi.fn()
    const { rerender } = render(
      <MessageList
        items={items}
        restoreScrollTop={100}
        scrollRestoreToken={1}
        onScrollTopChange={scrollTopSpy}
      />
    )

    const container = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    expect(container).toBeTruthy()

    const initialScrollTop = container.scrollTop
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => initialScrollTop,
      set: vi.fn()
    })

    rerender(
      <MessageList
        items={[
          { kind: 'message', id: 'msg-1', role: 'assistant', content: 'Hello world', streaming: true }
        ]}
        restoreScrollTop={250}
        scrollRestoreToken={1}
        onScrollTopChange={scrollTopSpy}
      />
    )

    expect(container.scrollTop).toBe(initialScrollTop)
  })

  it('restores scrollTop 0 instead of treating it as unset', async () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'msg-1', role: 'assistant', content: 'Top of thread' },
      { kind: 'message', id: 'msg-2', role: 'assistant', content: 'Later message' }
    ]

    const setSpy = vi.fn()
    const { rerender } = render(
      <MessageList items={items} restoreScrollTop={0} scrollRestoreToken={1} />
    )

    const container = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    expect(container).toBeTruthy()
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: setSpy
    })

    rerender(<MessageList items={items} restoreScrollTop={0} scrollRestoreToken={2} />)
    await vi.waitFor(() => {
      expect(setSpy.mock.calls.some((call) => call[0] === 0)).toBe(true)
    })
  })

  it('pins a live restore to the tail instead of the stale saved top', async () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'msg-1', role: 'assistant', content: 'Streaming', streaming: true }
    ]

    const { rerender } = render(
      <MessageList items={items} running restoreScrollTop={100} scrollRestoreToken={1} />
    )

    const container = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    expect(container).toBeTruthy()

    let scrollTop = 0
    const scrollTopSet = vi.fn((value: number) => {
      scrollTop = value
    })
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 4000 })
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: scrollTopSet
    })

    // Tail grew past the saved top while the pane was away: land on the tail.
    await vi.waitFor(() => {
      expect(scrollTopSet).toHaveBeenCalledWith(4000)
    })
    expect(scrollTop).toBe(4000)

    // Follow stays engaged: later stream growth follows without manual scroll.
    rerender(
      <MessageList
        items={[
          {
            kind: 'message',
            id: 'msg-1',
            role: 'assistant',
            content: 'Streaming more',
            streaming: true
          }
        ]}
        running
        restoreScrollTop={100}
        scrollRestoreToken={1}
      />
    )
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 4800 })
    await vi.waitFor(() => {
      expect(scrollTop).toBe(4800)
    })
  })

  it('keeps non-live restore on the saved top instead of pinning to the tail', async () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'msg-1', role: 'assistant', content: 'Earlier reply' },
      { kind: 'message', id: 'msg-2', role: 'assistant', content: 'Later reply' }
    ]

    render(<MessageList items={items} restoreScrollTop={250} scrollRestoreToken={1} />)

    const container = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    expect(container).toBeTruthy()

    let scrollTop = 0
    const scrollTopSet = vi.fn((value: number) => {
      scrollTop = value
    })
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 4000 })
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: scrollTopSet
    })

    await vi.waitFor(() => {
      expect(scrollTopSet).toHaveBeenCalledWith(250)
    })
    expect(scrollTop).toBe(250)
    expect(scrollTopSet).not.toHaveBeenCalledWith(4000)
  })

  it('keeps a pinned reader at the tail across the hybrid layout flip', async () => {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const mountItems: UiItem[] = Array.from({ length: 10 }, (_, i) => ({
      kind: 'message' as const,
      id: `m-${i}`,
      role: 'assistant' as const,
      content: `Line ${i}`
    }))

    const { rerender } = render(<MessageList items={mountItems} />)
    const container = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    expect(container).toBeTruthy()

    let height = 4000
    let scrollTop = 0
    const scrollTopSet = vi.fn((value: number) => {
      scrollTop = value
    })
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(container, 'scrollHeight', { configurable: true, get: () => height })
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: scrollTopSet
    })

    // User scroll to the tail: pins and records the layout-change anchor.
    scrollTop = 3600
    fireEvent.scroll(container)

    // Stream grows below the fold without any scroll event.
    height = 6000

    const liveItems: UiItem[] = [
      { kind: 'message', id: 'u-live', role: 'user', content: 'keep going' },
      ...Array.from({ length: 170 }, (_, i) => ({
        kind: 'message' as const,
        id: `live-${i}`,
        role: 'assistant' as const,
        content: `Live line ${i}`,
        streaming: i === 169
      }))
    ]
    rerender(<MessageList items={liveItems} running />)

    // The flow→hybrid flip must keep the tail, not yank to the stale anchor.
    await vi.waitFor(() => {
      expect(scrollTopSet).toHaveBeenCalledWith(6000)
    })
    expect(scrollTop).toBe(6000)

    vi.unstubAllGlobals()
  })

  it('renders every row in a long transcript', () => {
    const items: UiItem[] = Array.from({ length: 45 }, (_, i) => ({
      kind: 'message' as const,
      id: `m-${i}`,
      role: 'assistant' as const,
      content: `Line ${i}`
    }))

    render(<MessageList items={items} />)

    expect(screen.getByText('Line 0')).toBeTruthy()
    expect(screen.getByText('Line 44')).toBeTruthy()
    expect(document.querySelectorAll('[data-index]')).toHaveLength(0)
  })

  it('groups consecutive tool rows in long threads', () => {
    const pad = Array.from({ length: 40 }, (_, i) => ({
      kind: 'message' as const,
      id: `pad-${i}`,
      role: 'assistant' as const,
      content: `pad ${i}`
    }))
    const tools = toolGroup('tail', ['one.ts', 'two.ts', 'three.ts'])
    const items: UiItem[] = [...pad, ...tools]

    render(<MessageList items={items} />)

    expect(screen.getByText('3 files')).toBeTruthy()
    expect(screen.getByText('pad 0')).toBeTruthy()
  })

  it('uses instant tail follow while streaming', () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    const items: UiItem[] = [
      { kind: 'message', id: 'msg-1', role: 'assistant', content: 'Streaming', streaming: true }
    ]

    render(<MessageList items={items} />)

    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('follows the tail via scrollHeight so dock padding stays clear', async () => {
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

    const items: UiItem[] = Array.from({ length: 12 }, (_, i) => ({
      kind: 'message' as const,
      id: `m-${i}`,
      role: 'assistant' as const,
      content: `Line ${i}`
    }))

    const { rerender } = render(
      <MessageList items={items} />
    )
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    expect(scroll).toBeTruthy()

    let scrollTop = 0
    const scrollTopSet = vi.fn((value: number) => {
      scrollTop = value
    })
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 4000 })
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: scrollTopSet
    })

    // Far enough from the end that pin slack (dockReserve) does not early-return.
    scrollTop = 3300

    const next = [
      ...items,
      {
        kind: 'message' as const,
        id: 'm-tail',
        role: 'assistant' as const,
        content: 'new line'
      }
    ]
    rerender(<MessageList items={next} />)

    await vi.waitFor(() => {
      expect(scrollTopSet).toHaveBeenCalled()
    })
    expect(scrollTopSet).toHaveBeenCalledWith(4000)

    vi.unstubAllGlobals()
  })

  it('renders live tool chrome inline with a collapse-only turn summary', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'go' },
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'file.ts', status: 'running' }
      }
    ]
    render(<MessageList items={items} running pendingRun />)

    expect(document.querySelector('[data-turn-summary-chrome]')).toBeNull()
    const scroll = document.querySelector('[data-transcript-scroll]')
    expect(scroll).toBeTruthy()
    const working = screen.getByRole('button', { name: /^Collapse turn work$/i })
    expect(scroll!.contains(working)).toBe(true)
    expect(screen.getByText('file.ts')).toBeTruthy()

    const column = scroll!.querySelector('[data-chat-column]')
    const order = [...(column?.querySelectorAll('[data-transcript-row]') ?? [])]
    // Chronological in-scroll: user → tools → TurnSummary. No external pin.
    expect(document.querySelector('[data-prompt-pin]')).toBeNull()
    expect(order.length).toBe(3)
    expect(order[2]?.querySelector('button[aria-label="Collapse turn work"]')).toBeTruthy()
  })

  it('keeps user prompts in chronological scroll order with no pin', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'earlier prompt' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'earlier reply' },
      { kind: 'message', id: 'user-2', role: 'user', content: 'latest prompt' },
      { kind: 'message', id: 'a2', role: 'assistant', content: 'latest reply' }
    ]
    render(<MessageList items={items} />)

    const scroll = document.querySelector('[data-transcript-scroll]')
    expect(scroll).toBeTruthy()
    expect(document.querySelector('[data-prompt-pin]')).toBeNull()

    const latest = screen.getByText('latest prompt')
    const earlier = screen.getByText('earlier prompt')
    expect(latest.closest('[data-transcript-scroll]')).toBeTruthy()
    expect(earlier.closest('[data-transcript-scroll]')).toBeTruthy()
    expect(screen.getByText('latest reply').closest('[data-transcript-scroll]')).toBeTruthy()
    expect(screen.getByText('earlier reply').closest('[data-transcript-scroll]')).toBeTruthy()

    const text = scroll!.querySelector('[data-chat-column]')?.textContent ?? ''
    expect(text.indexOf('earlier prompt')).toBeLessThan(text.indexOf('earlier reply'))
    expect(text.indexOf('earlier reply')).toBeLessThan(text.indexOf('latest prompt'))
    expect(text.indexOf('latest prompt')).toBeLessThan(text.indexOf('latest reply'))
  })

  it('mounts tasks under the task-owning user prompt (not a later follow-up)', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'audit the entire codebase end to end' },
      {
        kind: 'tool',
        id: 'todo1',
        tool: { id: 'todo1', name: 'todo_write', summary: '1 task', status: 'done' }
      },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'Working on it.' },
      { kind: 'message', id: 'user-2', role: 'user', content: 'delete it' }
    ]
    render(<MessageList items={items} running />)

    const owning = screen.getByText('audit the entire codebase end to end')
    const followUp = screen.getByText('delete it')
    expect(owning.closest('[data-transcript-scroll]')).toBeTruthy()
    expect(followUp.closest('[data-transcript-scroll]')).toBeTruthy()
    expect(document.querySelector('[data-prompt-pin]')).toBeNull()
    // Band mount is under the owning prompt; content needs run artifacts (ChatView).
    const text = document.querySelector('[data-chat-column]')?.textContent ?? ''
    expect(text.indexOf('audit the entire codebase end to end')).toBeLessThan(
      text.indexOf('Working on it.')
    )
    expect(text.indexOf('Working on it.')).toBeLessThan(text.indexOf('delete it'))
  })

  it('follows content growth on the same message id while streaming and pinned', async () => {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const { rerender } = render(
      <MessageList
        items={[
          {
            kind: 'message',
            id: 'msg-stream',
            role: 'assistant',
            content: 'Hello',
            streaming: true
          }
        ]}
        running
      />
    )
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    let scrollTop = 0
    const scrollTopSet = vi.fn((value: number) => {
      scrollTop = value
    })
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: scrollTopSet
    })
    // Within former dock slack — must still follow so tokens do not sit under the composer.
    scrollTop = 2000 - 400 - 50
    scrollTopSet.mockClear()

    rerender(
      <MessageList
        items={[
          {
            kind: 'message',
            id: 'msg-stream',
            role: 'assistant',
            content: 'Hello world, still streaming more tokens here',
            streaming: true
          }
        ]}
        running
      />
    )

    await vi.waitFor(() => {
      expect(scrollTopSet).toHaveBeenCalledWith(2000)
    })

    vi.unstubAllGlobals()
  })

  it('does not follow content growth when the user has scrolled away', async () => {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const { rerender } = render(
      <MessageList
        items={[
          {
            kind: 'message',
            id: 'msg-stream',
            role: 'assistant',
            content: 'Hello',
            streaming: true
          }
        ]}
        running
      />
    )
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    let scrollTop = 0
    const scrollTopSet = vi.fn((value: number) => {
      scrollTop = value
    })
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: scrollTopSet
    })
    scrollTop = 200
    fireEvent.scroll(scroll)
    scrollTopSet.mockClear()

    rerender(
      <MessageList
        items={[
          {
            kind: 'message',
            id: 'msg-stream',
            role: 'assistant',
            content: 'Hello world grew a lot without pin',
            streaming: true
          }
        ]}
        running
      />
    )

    await new Promise((r) => setTimeout(r, 40))
    expect(scrollTopSet).not.toHaveBeenCalled()

    vi.unstubAllGlobals()
  })

  it('follows the tail when content grows while pinned', async () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'msg-1', role: 'assistant', content: 'Hello' }
    ]
    const { rerender } = render(<MessageList items={items} />)
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    let scrollTop = 0
    const scrollTopSet = vi.fn((value: number) => {
      scrollTop = value
    })
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 900 })
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: scrollTopSet
    })
    scrollTop = 500

    const next: UiItem[] = [
      { kind: 'message', id: 'msg-1', role: 'assistant', content: 'Hello with more content' }
    ]
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1200 })
    rerender(<MessageList items={next} />)

    await vi.waitFor(() => {
      expect(scrollTopSet).toHaveBeenCalledWith(1200)
    })
  })

  it('keeps chat column as a direct child of the scrollport', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'hello' }
    ]
    render(<MessageList items={items} />)
    const scroll = document.querySelector('[data-transcript-scroll]')
    const column = document.querySelector('[data-chat-column]')
    expect(scroll).toBeTruthy()
    expect(column).toBeTruthy()
    expect(column?.parentElement).toBe(scroll)
    expect(scroll?.className.includes('flex-col')).toBe(false)
  })

  it('grows total size estimates when streaming text content grows', () => {
    const short = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'Hello',
        streaming: true,
        thinking: 'plan',
        thinkingStreaming: true
      }
    ])
    const tall = buildTranscriptRows([
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'Hello\n\n'.repeat(40) + 'more',
        streaming: true,
        thinking: 'plan that grew a lot with more reasoning tokens',
        thinkingStreaming: true
      },
      {
        kind: 'tool',
        id: 't1',
        tool: {
          id: 't1',
          name: 'read',
          summary: 'dir',
          status: 'done',
          content: 'file list\n'.repeat(20)
        }
      }
    ])

    const shortRev = transcriptRowsContentRevision(short)
    const tallRev = transcriptRowsContentRevision(tall)
    expect(shortRev).not.toBe(tallRev)

    const shortEstimate = short.reduce((sum, row) => sum + estimateTranscriptRowSize(row), 0)
    const tallEstimate = tall.reduce((sum, row) => sum + estimateTranscriptRowSize(row), 0)
    expect(tallEstimate).toBeGreaterThan(shortEstimate)

    // Simulated measured layout: starts must be non-overlapping.
    let cursor = 0
    for (const row of tall) {
      const size = estimateTranscriptRowSize(row)
      const start = cursor
      cursor += size
      expect(cursor).toBeGreaterThan(start)
    }
  })

  it('uses document flow for short transcripts so rows cannot absolute-overlap', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'Hello! I am Agent V. Welcome to the workspace.'
      },
      {
        kind: 'message',
        id: 'u2',
        role: 'user',
        content: 'Launch multiple parallel agents for:- audit everything'
      }
    ]
    render(<MessageList items={items} />)
    expect(document.querySelectorAll('[data-index]')).toHaveLength(0)
    const column = document.querySelector('[data-chat-column]')
    expect(column?.className.includes('relative')).toBe(false)
    expect(screen.getByText(/Hello! I am Agent V/)).toBeTruthy()
    expect(screen.getByText(/Launch multiple parallel agents/)).toBeTruthy()
  })

  it('keeps document flow while the agent is running even for long transcripts', () => {
    const items: UiItem[] = Array.from({ length: 180 }, (_, i) => ({
      kind: 'message' as const,
      id: `m-${i}`,
      role: 'assistant' as const,
      content: `Line ${i}`
    }))
    render(<MessageList items={items} running />)
    expect(document.querySelectorAll('[data-index]')).toHaveLength(0)
    expect(screen.getByText('Line 0')).toBeTruthy()
    expect(screen.getByText('Line 179')).toBeTruthy()
  })

  it('virtualizes older rows within a single long live turn', () => {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const originalGbc = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
      if (this.hasAttribute?.('data-transcript-scroll')) {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: 800,
          right: 720,
          width: 720,
          height: 800,
          toJSON() {
            return {}
          }
        } as DOMRect
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 40,
        right: 720,
        width: 720,
        height: 40,
        toJSON() {
          return {}
        }
      } as DOMRect
    }

    const prevVitest = process.env.VITEST
    process.env.VITEST = ''

    const items: UiItem[] = [
      { kind: 'message', id: 'u0', role: 'user', content: 'start' },
      ...Array.from({ length: 179 }, (_, i) => ({
        kind: 'message' as const,
        id: `m-${i}`,
        role: 'assistant' as const,
        content: `Line ${i}`
      }))
    ]
    render(<MessageList items={items} running />)
    const flow = document.querySelector('[data-live-turn-flow]')
    expect(flow).toBeTruthy()
    expect(screen.queryByText('Line 0')).toBeNull()
    expect(screen.queryByText('Line 50')).toBeNull()
    // Suffix rows sit inside turn-group wrappers; count the rows themselves.
    const flowRows = flow?.querySelectorAll('[data-transcript-row]').length ?? 0
    expect(flowRows).toBeGreaterThan(30)
    expect(flowRows).toBeLessThanOrEqual(45)

    process.env.VITEST = prevVitest
    Element.prototype.getBoundingClientRect = originalGbc
    vi.unstubAllGlobals()
  })

  it('stays in document flow after a live run ends (no cold virtualizer gaps)', () => {
    const items: UiItem[] = Array.from({ length: 180 }, (_, i) => ({
      kind: 'message' as const,
      id: `m-${i}`,
      role: 'assistant' as const,
      content: `Line ${i}`
    }))
    const { rerender } = render(<MessageList items={items} running />)
    expect(document.querySelectorAll('[data-index]')).toHaveLength(0)
    rerender(<MessageList items={items} running={false} />)
    expect(document.querySelectorAll('[data-index]')).toHaveLength(0)
    expect(screen.getByText('Line 179')).toBeTruthy()
  })

  it('preserves scroll position when a long live run ends', async () => {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const originalGbc = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
      if (this.hasAttribute?.('data-transcript-scroll')) {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: 800,
          right: 720,
          width: 720,
          height: 800,
          toJSON() {
            return {}
          }
        } as DOMRect
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 40,
        right: 720,
        width: 720,
        height: 40,
        toJSON() {
          return {}
        }
      } as DOMRect
    }

    const prevVitest = process.env.VITEST
    process.env.VITEST = ''

    const items: UiItem[] = [
      { kind: 'message', id: 'u0', role: 'user', content: 'start' },
      ...Array.from({ length: 179 }, (_, i) => ({
        kind: 'message' as const,
        id: `m-${i}`,
        role: 'assistant' as const,
        content: `Line ${i}`
      }))
    ]
    const onScrollTopChange = vi.fn()
    const { rerender } = render(
      <MessageList items={items} running onScrollTopChange={onScrollTopChange} />
    )
    expect(document.querySelector('[data-live-turn-flow]')).toBeTruthy()

    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    let scrollTop = 12_000
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 800 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 40_000 })
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      }
    })
    // Let the mount-time tail-follow's rAF reset programmaticScrollRef settle.
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
    })
    scrollTop = 12_000
    fireEvent.scroll(scroll)
    onScrollTopChange.mockClear()
    act(() => {
      rerender(<MessageList items={items} running onScrollTopChange={onScrollTopChange} />)
    })

    rerender(<MessageList items={items} running={false} onScrollTopChange={onScrollTopChange} />)
    expect(scrollTop).toBe(12_000)
    expect(onScrollTopChange).not.toHaveBeenCalledWith(0)

    process.env.VITEST = prevVitest
    Element.prototype.getBoundingClientRect = originalGbc
    vi.unstubAllGlobals()
  })

  it('keeps scroll stable after the post-live hold enables full virtualization', async () => {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const originalGbc = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
      if (this.hasAttribute?.('data-transcript-scroll')) {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: 800,
          right: 720,
          width: 720,
          height: 800,
          toJSON() {
            return {}
          }
        } as DOMRect
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 40,
        right: 720,
        width: 720,
        height: 40,
        toJSON() {
          return {}
        }
      } as DOMRect
    }

    const prevVitest = process.env.VITEST
    process.env.VITEST = ''

    const items: UiItem[] = [
      { kind: 'message', id: 'u0', role: 'user', content: 'start' },
      ...Array.from({ length: 179 }, (_, i) => ({
        kind: 'message' as const,
        id: `m-${i}`,
        role: 'assistant' as const,
        content: `Line ${i}`
      }))
    ]
    const { rerender } = render(<MessageList items={items} running />)
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    let scrollTop = 9_500
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 800 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 40_000 })
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      }
    })
    // Let the mount-time tail-follow's rAF reset programmaticScrollRef settle.
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
    })
    scrollTop = 9_500
    fireEvent.scroll(scroll)
    act(() => {
      rerender(<MessageList items={items} running />)
    })

    rerender(<MessageList items={items} running={false} />)
    expect(scrollTop).toBe(9_500)

    vi.useFakeTimers()
    act(() => {
      vi.advanceTimersByTime(800)
    })
    expect(scrollTop).toBe(9_500)

    vi.useRealTimers()

    process.env.VITEST = prevVitest
    Element.prototype.getBoundingClientRect = originalGbc
    vi.unstubAllGlobals()
  })

  it('stays pinned at the bottom when a run ends with no user scroll during the stream', async () => {
    class ResizeObserverStub {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const originalGbc = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
      if (this.hasAttribute?.('data-transcript-scroll')) {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: 800,
          right: 720,
          width: 720,
          height: 800,
          toJSON() {
            return {}
          }
        } as DOMRect
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 40,
        right: 720,
        width: 720,
        height: 40,
        toJSON() {
          return {}
        }
      } as DOMRect
    }

    const prevVitest = process.env.VITEST
    process.env.VITEST = ''

    const items: UiItem[] = [
      { kind: 'message', id: 'u0', role: 'user', content: 'start' },
      ...Array.from({ length: 179 }, (_, i) => ({
        kind: 'message' as const,
        id: `m-${i}`,
        role: 'assistant' as const,
        content: `Line ${i}`
      }))
    ]
    const { rerender } = render(<MessageList items={items} running />)
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    let scrollTop = 0
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 800 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 40_000 })
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      }
    })

    // Let the mount-time tail-follow's rAF reset programmaticScrollRef settle.
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
    })

    // Stale pre-run reading position: recorded before the stream re-pins the
    // tail, never touched again by a user scroll during the run.
    scrollTop = 12_000
    fireEvent.scroll(scroll)
    expect(scrollTop).toBe(12_000)

    // Reader sends a new prompt: MessageList re-pins to the live tail and the
    // stream grows from there with no further user scroll events.
    const streamingItems: UiItem[] = [
      ...items,
      { kind: 'message', id: 'u1', role: 'user', content: 'go' },
      { kind: 'message', id: 'm-live', role: 'assistant', content: 'Streaming answer…' }
    ]
    act(() => {
      rerender(<MessageList items={streamingItems} running />)
    })
    expect(scrollTop).toBe(40_000)

    rerender(<MessageList items={streamingItems} running={false} />)
    // Run-end layout flip must not restore the stale pre-run offset.
    expect(scrollTop).toBe(40_000)

    vi.useFakeTimers()
    act(() => {
      vi.advanceTimersByTime(800)
    })
    // Post-live hold expires and full virtualization kicks in: still pinned.
    expect(scrollTop).toBe(40_000)

    vi.useRealTimers()

    process.env.VITEST = prevVitest
    Element.prototype.getBoundingClientRect = originalGbc
    vi.unstubAllGlobals()
  })

  it('estimates collapsed activity/thinking near disclosure height, not inflated slots', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: '',
        thinking: 'enough thinking characters here',
        thinkingStreaming: false
      },
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'a.ts', status: 'done' }
      }
    ])
    const thinking = rows.find((r) => r.kind === 'thinking')
    const activity = rows.find((r) => r.kind === 'activity')
    expect(estimateTranscriptRowSize(thinking)).toBeLessThanOrEqual(52)
    expect(estimateTranscriptRowSize(activity)).toBeLessThanOrEqual(56)
  })

  it('estimates settled todo_write as compact (checklist lives in Tasks dock)', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'tool',
        id: 'todo1',
        tool: {
          id: 'todo1',
          name: 'todo_write',
          summary: 'Plan',
          status: 'done',
          argsPreview: JSON.stringify({
            todos: [{ id: '1', content: 'Ship', status: 'completed' }]
          })
        }
      }
    ])
    // Successful todo_write is omitted from transcript rows entirely.
    expect(rows.find((r) => r.kind === 'activity')).toBeUndefined()
  })

  it('estimates live multi-tool activity from its in-flow row count', () => {
    const multi = buildTranscriptRows([
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'a.ts', status: 'done' }
      },
      {
        kind: 'tool',
        id: 't2',
        tool: { id: 't2', name: 'read', summary: 'b.ts', status: 'running' }
      }
    ])
    const activity = multi.find((r) => r.kind === 'activity')
    expect(estimateTranscriptRowSize(activity)).toBe(48 + TOOL_GROUP_LIST_ESTIMATE_MIN_PX)

    const many = buildTranscriptRows(
      Array.from({ length: 8 }, (_, index) => ({
        kind: 'tool' as const,
        id: `t${index + 1}`,
        tool: { id: `t${index + 1}`, name: 'read', summary: `file-${index}.ts`, status: 'running' as const }
      }))
    )
    const manyActivity = many.find((r) => r.kind === 'activity')
    expect(estimateTranscriptRowSize(manyActivity)).toBe(48 + 8 * 32)

    const collapsedStale = buildTranscriptRows([
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'a.ts', status: 'done' },
        toolExpanded: true
      },
      {
        kind: 'tool',
        id: 't2',
        tool: { id: 't2', name: 'read', summary: 'b.ts', status: 'done' }
      }
    ])
    const stale = collapsedStale.find((r) => r.kind === 'activity')
    expect(estimateTranscriptRowSize(stale)).toBe(48)

    const loneLive = buildTranscriptRows([
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'a.ts', status: 'running' }
      }
    ])
    const single = loneLive.find((r) => r.kind === 'activity')
    // Running file reads stay compact (path row only) — no body height.
    expect(estimateTranscriptRowSize(single)).toBe(48)
  })

  it('estimates running terminal cards as fixed-height viewports', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'tool',
        id: 't1',
        tool: {
          id: 't1',
          name: 'terminal',
          summary: 'pnpm test',
          status: 'running',
          argsPreview: '{"command":"pnpm test"}',
          presentation: 'prominent'
        }
      }
    ])
    const card = rows.find((r) => r.kind === 'card')
    expect(card?.kind).toBe('card')
    expect(estimateTranscriptRowSize(card)).toBe(56 + TOOL_TERMINAL_VIEWPORT_MAX_PX)
  })

  it('estimates collapsed terminal cards as header-only (panel fold)', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'tool',
        id: 't1',
        tool: {
          id: 't1',
          name: 'terminal',
          summary: 'pnpm test',
          status: 'done',
          argsPreview: '{"command":"pnpm test"}',
          content: 'cwd: /ws\n\nok\nexit_code: 0',
          presentation: 'prominent'
        },
        toolExpanded: false
      }
    ])
    const card = rows.find((r) => r.kind === 'card')
    expect(estimateTranscriptRowSize(card)).toBe(56)
  })

  it('estimates long assistant text tall enough to avoid virtual overlap', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'paragraph\n'.repeat(80)
      }
    ])
    const text = rows.find((r) => r.kind === 'text')
    expect(estimateTranscriptRowSize(text)).toBeGreaterThan(280)
  })

  it('estimates multi-option ask_question gates taller than the old 160px floor', () => {
    const rows = buildTranscriptRows([
      {
        kind: 'question',
        id: 'question:req-q',
        question: {
          requestId: 'req-q',
          toolCallId: 't1',
          questions: [
            {
              id: 'q1',
              prompt: 'Language?',
              type: 'single',
              options: ['Node', 'Python', 'Go', 'Rust']
            },
            {
              id: 'q2',
              prompt: 'Provider?',
              type: 'single',
              options: ['OpenAI', 'Anthropic', 'Local', 'Other', 'Agnostic']
            }
          ]
        }
      }
    ])
    const question = rows.find((r) => r.kind === 'question')
    expect(estimateTranscriptRowSize(question)).toBeGreaterThanOrEqual(320)
    expect(estimateTranscriptRowSize(question)).toBeGreaterThan(160)
  })

  it('lays out virtual rows without overlapping translateY slots when measured', () => {
    class ResizeObserverStub {
      private readonly cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb
      }
      observe(target: Element): void {
        const height = target.hasAttribute('data-transcript-scroll') ? 800 : 120
        const width = 720
        this.cb(
          [
            {
              target,
              contentRect: {
                x: 0,
                y: 0,
                top: 0,
                left: 0,
                bottom: height,
                right: width,
                width,
                height,
                toJSON() {
                  return {}
                }
              },
              borderBoxSize: [{ blockSize: height, inlineSize: width }],
              contentBoxSize: [{ blockSize: height, inlineSize: width }],
              devicePixelContentBoxSize: [{ blockSize: height, inlineSize: width }]
            } as ResizeObserverEntry
          ],
          this as unknown as ResizeObserver
        )
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)

    const originalGbc = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
      if (this.hasAttribute?.('data-transcript-scroll')) {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: 800,
          right: 720,
          width: 720,
          height: 800,
          toJSON() {
            return {}
          }
        } as DOMRect
      }
      const indexAttr = this.getAttribute?.('data-index')
      if (indexAttr != null) {
        const h = 90 + Number(indexAttr) * 55
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: h,
          right: 720,
          width: 720,
          height: h,
          toJSON() {
            return {}
          }
        } as DOMRect
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 40,
        right: 720,
        width: 720,
        height: 40,
        toJSON() {
          return {}
        }
      } as DOMRect
    }

    // Force the virtualizer path (not Vitest full-DOM fallback) with enough idle rows.
    const prevVitest = process.env.VITEST
    process.env.VITEST = ''

    const items: UiItem[] = Array.from({ length: 180 }, (_, i) => ({
      kind: 'message' as const,
      id: `pad-${i}`,
      role: 'assistant' as const,
      content: `Pad line ${i}`
    }))

    render(<MessageList items={items} />)

    const indexed = [...document.querySelectorAll('[data-index]')] as HTMLElement[]
    expect(indexed.length).toBeGreaterThanOrEqual(2)

    const starts = indexed
      .map((el) => Number.parseFloat(el.style.top))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
    expect(starts.length).toBe(indexed.length)
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]!).toBeGreaterThan(starts[i - 1]!)
    }

    const column = document.querySelector('[data-chat-column]') as HTMLElement
    const totalSize = Number.parseFloat(column.style.height)
    expect(totalSize).toBeGreaterThan(starts[starts.length - 1]!)

    process.env.VITEST = prevVitest
    Element.prototype.getBoundingClientRect = originalGbc
    vi.unstubAllGlobals()
  })

  it('clicking a user prompt calls onBeginEditUserMessage with its message index', () => {
    const onBegin = vi.fn()
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'first prompt' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'ok' },
      { kind: 'message', id: 'user-2', role: 'user', content: 'second prompt' }
    ]

    render(<MessageList items={items} onBeginEditUserMessage={onBegin} />)

    const editable = screen.getAllByLabelText('Edit message')
    expect(editable).toHaveLength(2)
    expect(document.querySelector('[data-prompt-pin]')).toBeNull()
    fireEvent.click(screen.getByText('first prompt'))
    expect(onBegin).toHaveBeenCalledWith(0)
    onBegin.mockClear()
    fireEvent.click(screen.getByText('second prompt'))
    expect(onBegin).toHaveBeenCalledWith(2)
    onBegin.mockClear()
    fireEvent.keyDown(screen.getAllByRole('button', { name: 'Edit user message' })[0]!, {
      key: 'Enter'
    })
    expect(onBegin).toHaveBeenCalledWith(0)
  })

  it('shows revert-to-prompt control only when later transcript content exists', () => {
    const onRevert = vi.fn()
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'first prompt' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'ok' },
      { kind: 'message', id: 'user-2', role: 'user', content: 'second prompt' },
      { kind: 'message', id: 'a2', role: 'assistant', content: 'ok2' }
    ]

    const { rerender } = render(
      <MessageList
        items={items}
        messageCount={4}
        onRevertUserMessage={onRevert}
      />
    )

    expect(screen.getAllByLabelText('Revert to before this prompt')).toHaveLength(2)

    rerender(
      <MessageList
        items={[{ kind: 'message', id: 'user-0', role: 'user', content: 'solo prompt' }]}
        messageCount={1}
        onRevertUserMessage={onRevert}
      />
    )
    expect(screen.queryByLabelText('Revert to before this prompt')).toBeNull()

    rerender(
      <MessageList
        items={items}
        messageCount={4}
        running
        onRevertUserMessage={onRevert}
      />
    )
    expect(screen.queryByLabelText('Revert to before this prompt')).toBeNull()
  })

  it('clicking revert calls onRevertUserMessage with its message index', () => {
    const onRevert = vi.fn()
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'first prompt' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'ok' }
    ]

    render(
      <MessageList items={items} messageCount={2} onRevertUserMessage={onRevert} />
    )

    fireEvent.click(screen.getByLabelText('Revert to before this prompt'))
    expect(onRevert).toHaveBeenCalledWith(0)
  })

  it('replaces the user bubble with editComposer while editing', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'original prompt' }
    ]

    render(
      <MessageList
        items={items}
        editingUserMessageIndex={0}
        editComposer={<div data-testid="inline-composer">editing…</div>}
        onBeginEditUserMessage={() => {}}
      />
    )

    expect(screen.getByTestId('inline-composer')).toBeTruthy()
    expect(screen.queryByText('original prompt')).toBeNull()
    expect(screen.queryByLabelText('Edit message')).toBeNull()
  })

  it('marks editable user prompts with a click-to-edit title', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'hover me' }
    ]

    render(<MessageList items={items} onBeginEditUserMessage={() => {}} />)

    const editBtn = screen.getByLabelText('Edit message')
    const bubble = editBtn.closest('[aria-label="Edit user message"]')
    expect(bubble).toBeTruthy()
    expect(bubble?.className).toContain('group/prompt')
  })

  it('shows live TurnSummary Compacting… while the run is compacting', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'working' }
    ]

    render(<MessageList items={items} running compacting />)

    expect(screen.getByText('Compacting…')).toBeTruthy()
    expect(document.querySelector('[data-compact-status]')).toBeNull()
    expect(screen.queryByText(/Context summarized/)).toBeNull()
  })

  it('keeps Compacting… on the live TurnSummary when tool chrome is visible', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'src/auth.ts', status: 'running' }
      }
    ]

    render(<MessageList items={items} running compacting />)

    expect(screen.getByText('Compacting…')).toBeTruthy()
  })

  it('shows idle Compacting… inline in the transcript (not under the composer)', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'done' }
    ]

    render(<MessageList items={items} compacting />)

    const status = document.querySelector('[data-compact-status]')
    expect(status?.textContent).toContain('Compacting…')
  })

  it('shows the compaction summary in the transcript after compact completes', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'compaction',
        id: 'c1',
        summary: 'Earlier turns set up auth and the session store.',
        tokenEstimate: 1200,
        verifyStatus: 'verified',
        verifyCoverage: 1
      }
    ]

    render(<MessageList items={items} />)

    expect(document.querySelector('[data-compact-status]')).toBeNull()
    expect(screen.getByText('Context summarized')).toBeTruthy()
    expect(screen.getByText('Verified 100%')).toBeTruthy()
    expect(screen.getByText('~1.2k')).toBeTruthy()
    expect(screen.getByText('Earlier turns set up auth and the session store.')).toBeTruthy()
  })

  it('shows a failed compact card with the verify reason', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'compaction',
        id: 'c1',
        summary: 'Forgot the decision.',
        verifyStatus: 'failed',
        verifyFailures: ['Missing decision: Use JWT']
      }
    ]

    render(<MessageList items={items} />)

    expect(screen.getByText('Summary not applied')).toBeTruthy()
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(screen.getByText('Missing decision: Use JWT')).toBeTruthy()
  })

  it('jumps to the latest messages on End', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'Hello there from the user' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'A reply from the assistant' }
    ]
    render(<MessageList items={items} />)
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    const scrollTopSet = vi.fn()
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 4000 })
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => 200,
      set: scrollTopSet
    })
    Object.defineProperty(scroll, 'scrollTo', {
      configurable: true,
      value: ({ top }: { top: number }) => {
        scrollTopSet(top)
      }
    })

    fireEvent.keyDown(window, { key: 'End' })
    expect(scrollTopSet).toHaveBeenCalledWith(4000)
  })

  it('jumps to the top on Home', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'Hello there from the user' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'A reply from the assistant' }
    ]
    render(<MessageList items={items} />)
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    const scrollTopSet = vi.fn()
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 4000 })
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => 200,
      set: scrollTopSet
    })
    Object.defineProperty(scroll, 'scrollTo', {
      configurable: true,
      value: ({ top }: { top: number }) => {
        scrollTopSet(top)
      }
    })

    fireEvent.keyDown(window, { key: 'Home' })
    expect(scrollTopSet).toHaveBeenCalledWith(0)
  })

  it('does not jump on End from a text field', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'Hello there from the user' }
    ]
    render(
      <>
        <input aria-label="Other field" />
        <MessageList items={items} />
      </>
    )
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    const scrollTopSet = vi.fn()
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => 200,
      set: scrollTopSet
    })
    Object.defineProperty(scroll, 'scrollTo', {
      configurable: true,
      value: ({ top }: { top: number }) => {
        scrollTopSet(top)
      }
    })
    fireEvent.keyDown(screen.getByLabelText('Other field'), { key: 'End' })
    expect(scrollTopSet).not.toHaveBeenCalled()
  })

  it('does not jump on Home from a text field', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'Hello there from the user' }
    ]
    render(
      <>
        <input aria-label="Other field" />
        <MessageList items={items} />
      </>
    )
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    const scrollTopSet = vi.fn()
    Object.defineProperty(scroll, 'scrollTop', {
      configurable: true,
      get: () => 200,
      set: scrollTopSet
    })
    Object.defineProperty(scroll, 'scrollTo', {
      configurable: true,
      value: ({ top }: { top: number }) => {
        scrollTopSet(top)
      }
    })
    fireEvent.keyDown(screen.getByLabelText('Other field'), { key: 'Home' })
    expect(scrollTopSet).not.toHaveBeenCalled()
  })

  it('opens transcript find with Ctrl+F, counts matches, and closes on Esc', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'Hello there from the user' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'A reply about JWT tokens' },
      { kind: 'message', id: 'a2', role: 'assistant', content: 'JWT refresh still pending' }
    ]
    render(<MessageList items={items} />)
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const find = screen.getByRole('searchbox', { name: 'Find in transcript' })
    fireEvent.change(find, { target: { value: 'jwt' } })
    expect(screen.getByText('1 of 2')).toBeTruthy()
    fireEvent.keyDown(find, { key: 'Enter', shiftKey: true })
    expect(screen.getByText('2 of 2')).toBeTruthy()
    fireEvent.keyDown(find, { key: 'Enter' })
    expect(screen.getByText('1 of 2')).toBeTruthy()
    fireEvent.keyDown(find, { key: 'Enter' })
    expect(screen.getByText('2 of 2')).toBeTruthy()
    fireEvent.keyDown(find, { key: 'Escape' })
    expect(screen.queryByRole('searchbox', { name: 'Find in transcript' })).toBeNull()
  })

  it('opens transcript find from the composer and ignores other inputs', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'Hello there from the user' }
    ]
    render(
      <>
        <input aria-label="Other field" />
        <div role="textbox" aria-label="Message" contentEditable tabIndex={0} />
        <MessageList items={items} />
      </>
    )
    fireEvent.keyDown(screen.getByLabelText('Other field'), { key: 'f', ctrlKey: true })
    expect(screen.queryByRole('searchbox', { name: 'Find in transcript' })).toBeNull()

    fireEvent.keyDown(screen.getByRole('textbox', { name: /^message$/i }), {
      key: 'f',
      ctrlKey: true
    })
    expect(screen.getByRole('searchbox', { name: 'Find in transcript' })).toBeTruthy()
  })

  it('counts new messages on the Latest chip while unpinned', () => {
    const items: UiItem[] = [
      { kind: 'message', id: 'u1', role: 'user', content: 'Hello there from the user' },
      { kind: 'message', id: 'a1', role: 'assistant', content: 'A reply from the assistant' }
    ]
    const { rerender } = render(<MessageList items={items} />)
    const scroll = document.querySelector('[data-transcript-scroll]') as HTMLDivElement
    Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 400 })
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 4000 })
    Object.defineProperty(scroll, 'scrollTop', { configurable: true, value: 200 })
    fireEvent.scroll(scroll)
    expect(screen.getByRole('button', { name: 'Jump to latest messages' })).toBeTruthy()

    rerender(
      <MessageList
        items={[
          ...items,
          {
            kind: 'message',
            id: 'a2',
            role: 'assistant',
            content: 'A later reply from the assistant'
          }
        ]}
      />
    )
    expect(screen.getByRole('button', { name: 'Jump to latest messages, 1 new' })).toBeTruthy()
    expect(screen.getByText('Latest · 1')).toBeTruthy()
  })
})
