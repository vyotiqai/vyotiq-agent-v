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

  it('bumps content revision when a non-trailing row changes size', () => {
    const base = [
      { kind: 'message', id: 'u1', role: 'user', content: 'hi' },
      {
        kind: 'message',
        id: 'a1',
        role: 'assistant',
        content: 'Reading the directory…',
        streaming: true
      }
    ] as UiItem[]
    const before = buildTranscriptRows([
      ...base,
      {
        kind: 'tool',
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'dir', status: 'running', content: '' }
      }
    ])
    const after = buildTranscriptRows([
      ...base,
      {
        kind: 'tool',
        id: 't1',
        tool: {
          id: 't1',
          name: 'read',
          summary: 'dir',
          status: 'done',
          content: 'file list\n'.repeat(60)
        }
      }
    ])

    // Mid-transcript tool body grows while the trailing text row is stable.
    // The remasure effect deps on this revision, so it must change or the
    // virtualizer keeps stale offsets and rows overlap.
    expect(transcriptRowsContentRevision(after)).not.toBe(
      transcriptRowsContentRevision(before)
    )
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
})
