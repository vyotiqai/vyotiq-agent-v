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
})
