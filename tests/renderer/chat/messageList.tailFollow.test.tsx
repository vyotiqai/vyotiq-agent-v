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
})
