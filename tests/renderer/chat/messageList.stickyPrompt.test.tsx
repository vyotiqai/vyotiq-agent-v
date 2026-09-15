/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MessageList } from '@renderer/features/chat/components/MessageList'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'
import type { UiItem } from '@shared/transcript'

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
  vi.restoreAllMocks()
})

const items: UiItem[] = [
  { kind: 'message', id: 'u1', role: 'user', content: 'first ask' },
  { kind: 'message', id: 'a1', role: 'assistant', content: 'first reply' },
  { kind: 'message', id: 'u2', role: 'user', content: 'second ask\nwith detail' },
  { kind: 'message', id: 'a2', role: 'assistant', content: 'second reply' }
]

/** jsdom stubs that force the real hybrid render path: VITEST='' disables the
 * cold-mount flow fallback, GBC fakes the scrollport rect, and the
 * ResizeObserver stub feeds TanStack the virtual range. Returns a restore. */
function forceHybridPath(): () => void {
  class ResizeObserverStub {
    private readonly cb: ResizeObserverCallback
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb
    }
    observe(element: Element): void {
      // Fire the rect only for the transcript scrollport so row measurement
      // observers stay unpolluted; TanStack derives the virtual range from it.
      if (!(element instanceof HTMLElement) || !element.hasAttribute('data-transcript-scroll')) {
        return
      }
      this.cb(
        [
          {
            target: element,
            borderBoxSize: [{ inlineSize: 720, blockSize: 800 }]
          }
        ] as unknown as ResizeObserverEntry[],
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
  return () => {
    process.env.VITEST = prevVitest
    Element.prototype.getBoundingClientRect = originalGbc
    vi.unstubAllGlobals()
  }
}

describe('MessageList native turn prompt pinning', () => {
  it('marks the original user prompt bubble as the pinned element without complete row fills', () => {
    render(<MessageList items={items} />)
    const pinned = [...document.querySelectorAll('[data-sticky-turn-prompt]')]
    expect(pinned.length).toBe(2)
    for (const el of pinned) {
      // The prompt bubble pins inline (position: sticky) without full-row bg-bg fills
      expect(el.className).toContain('sticky')
      expect(el.className).not.toContain('bg-bg')
      const prompt = el.querySelector('[data-user-prompt]')
      expect(prompt).not.toBeNull()
      // Edge-to-edge floating bubble styling with surface shadow
      expect(prompt!.className).toContain('w-full')
      expect(prompt!.className).toContain('shadow-[var(--vy-shadow-chrome)]')
    }
  })

  it('wraps each turn so prompts release at turn boundaries', () => {
    render(<MessageList items={items} />)
    const groups = [...document.querySelectorAll('[data-turn-group]')]
    expect(groups.length).toBe(2)
    expect(groups[0]!.querySelector('[data-sticky-turn-prompt]')!.textContent).toContain(
      'first ask'
    )
    expect(groups[1]!.querySelector('[data-sticky-turn-prompt]')!.textContent).toContain(
      'second ask'
    )
  })

  it('renders each prompt exactly once — no duplicate floating header', () => {
    render(<MessageList items={items} />)
    const text = document.body.textContent ?? ''
    expect(text.split('first ask').length - 1).toBe(1)
    expect(text.split('second ask').length - 1).toBe(1)
    // The old external pin marker stays absent.
    expect(document.querySelector('[data-prompt-pin]')).toBeNull()
  })

  it('keeps the latest prompt pinned when an idle long transcript virtualizes (>= 160 rows)', () => {
    class ResizeObserverStub {
      private readonly cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb
      }
      observe(element: Element): void {
        // Fire the rect only for the transcript scrollport so row measurement
        // observers stay unpolluted; TanStack derives the virtual range from it.
        if (!(element instanceof HTMLElement) || !element.hasAttribute('data-transcript-scroll')) {
          return
        }
        this.cb(
          [
            {
              target: element,
              borderBoxSize: [{ inlineSize: 720, blockSize: 800 }]
            }
          ] as unknown as ResizeObserverEntry[],
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

    const long: UiItem[] = []
    for (let i = 0; i < 100; i++) {
      long.push({ kind: 'message', id: `lu-${i}`, role: 'user', content: `long ask ${i}` })
      long.push({ kind: 'message', id: `la-${i}`, role: 'assistant', content: `long reply ${i}` })
    }
    render(<MessageList items={long} />)

    // Idle virtualized transcripts render the hybrid layout: virtualized prefix
    // + flow suffix, so the latest turn's prompt keeps its sticky pin.
    expect(document.querySelector('[data-live-turn-flow]')).not.toBeNull()
    expect(document.querySelectorAll('[data-index]').length).toBeGreaterThan(0)
    const pinned = [...document.querySelectorAll('[data-sticky-turn-prompt]')]
    expect(pinned.length).toBeGreaterThan(0)
    expect(pinned[pinned.length - 1]!.textContent).toContain('long ask 99')

    process.env.VITEST = prevVitest
    Element.prototype.getBoundingClientRect = originalGbc
    vi.unstubAllGlobals()
  })

  it('pins the tasks band inside the sticky prompt wrapper', async () => {
    const readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        name: 'todos.json',
        exists: true,
        content: JSON.stringify({
          updatedAt: '2026-01-01T00:00:00.000Z',
          todos: [{ id: '1', content: 'Pin the band', status: 'in_progress' }]
        })
      }
    })
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: { readRunArtifact }
    })

    const bandItems: UiItem[] = []
    for (let i = 0; i < 100; i++) {
      bandItems.push({ kind: 'message', id: `bu-${i}`, role: 'user', content: `band ask ${i}` })
      bandItems.push({ kind: 'message', id: `ba-${i}`, role: 'assistant', content: `band reply ${i}` })
    }
    // A non-failed todo_write anchors the band on the preceding user message.
    bandItems.push({
      kind: 'tool',
      id: 'todos-1',
      tool: { id: 'todos-1', name: 'todo_write', summary: '1 task', status: 'done' }
    })

    render(
      <RunSessionProvider value={{ workspacePath: 'ws', runId: 'run-1' }}>
        <MessageList items={bandItems} />
      </RunSessionProvider>
    )

    await waitFor(() => {
      expect(document.querySelector('[data-tasks-ceiling]')).toBeTruthy()
    })
    // Every turn prompt in the suffix is sticky; the band must live inside one
    // of them (the anchor turn's wrapper) — never as a detached sibling.
    const pinned = [...document.querySelectorAll('[data-sticky-turn-prompt]')]
    expect(pinned.length).toBeGreaterThan(0)
    const band = document.querySelector('[data-tasks-ceiling]')
    expect(pinned.some((wrapper) => wrapper.contains(band))).toBe(true)
    // Exactly one band — no duplicate rendered outside the sticky unit.
    expect(document.querySelectorAll('[data-tasks-ceiling]').length).toBe(1)
  })

  it('pins the active turn prompt mid-run while the turn stays within the live mount bound', () => {
    const restore = forceHybridPath()

    // 60 prior turns + active turn (prompt + 45 live replies): hybrid
    // virtualization is active while running, and the active turn outgrew the
    // 40-row tail but stays within the live mount bound (LIVE_FLOW_TURN_MAX_ROWS).
    const liveItems: UiItem[] = []
    for (let i = 0; i < 60; i++) {
      liveItems.push({ kind: 'message', id: `pu-${i}`, role: 'user', content: `prior ask ${i}` })
      liveItems.push({ kind: 'message', id: `pa-${i}`, role: 'assistant', content: `prior reply ${i}` })
    }
    liveItems.push({ kind: 'message', id: 'live-u', role: 'user', content: 'live ask' })
    for (let i = 0; i < 45; i++) {
      liveItems.push({ kind: 'message', id: `la-${i}`, role: 'assistant', content: `live reply ${i}` })
    }

    render(<MessageList items={liveItems} running />)

    expect(document.querySelector('[data-live-turn-flow]')).not.toBeNull()
    // The active turn's prompt pins — without the fix it sits in the virtualized
    // prefix and no sticky wrapper renders at all.
    const pinned = [...document.querySelectorAll('[data-sticky-turn-prompt]')]
    expect(pinned.length).toBe(1)
    expect(pinned[0]!.textContent).toContain('live ask')

    restore()
  })

  it('falls back to the trailing window when the live turn outgrows the mount bound', () => {
    const restore = forceHybridPath()

    // Active turn emits 200 rows after its prompt — past the 120-row live mount
    // bound the suffix snaps back to the 40-row tail (renderer freeze guard).
    const megaItems: UiItem[] = []
    for (let i = 0; i < 60; i++) {
      megaItems.push({ kind: 'message', id: `mu-${i}`, role: 'user', content: `mega ask ${i}` })
      megaItems.push({ kind: 'message', id: `ma-${i}`, role: 'assistant', content: `mega reply ${i}` })
    }
    megaItems.push({ kind: 'message', id: 'mega-u', role: 'user', content: 'mega turn ask' })
    for (let i = 0; i < 200; i++) {
      megaItems.push({ kind: 'message', id: `mr-${i}`, role: 'assistant', content: `mega turn reply ${i}` })
    }

    render(<MessageList items={megaItems} running />)

    expect(document.querySelector('[data-live-turn-flow]')).not.toBeNull()
    const pinned = [...document.querySelectorAll('[data-sticky-turn-prompt]')]
    expect(pinned.length).toBe(0)

    restore()
  })
})
