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
})
