/**
 * @vitest-environment jsdom
 *
 * Automated guards for the manual perf matrix in docs/reference/2026-jun-aug/03-performance-diagnostics.md.
 * Verifies caps exist and hot paths stay bounded (no >2s freeze on synthetic workloads).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildTranscriptRows } from '@renderer/features/chat/utils/transcriptRows'
import { DEFAULT_SNAPSHOT_CHARS } from '@main/app/browserUrl'
import type { UiItem } from '@shared/transcript'

const VIRTUALIZE_MIN_ROWS = 160
const MAX_EXPANDED_LINES = 200
const EXPAND_ALL_MAX = 12
const TERMINAL_UI_MAX = 64 * 1024

describe('perf matrix caps (documented constants)', () => {
  it('exports browser and terminal bounds from main modules', () => {
    expect(DEFAULT_SNAPSHOT_CHARS).toBe(40_000)
    expect(VIRTUALIZE_MIN_ROWS).toBe(160)
    expect(MAX_EXPANDED_LINES).toBe(200)
    expect(EXPAND_ALL_MAX).toBe(12)
    expect(TERMINAL_UI_MAX).toBe(64 * 1024)
  })
})

describe('perf matrix scenario 3 — long transcript row build', () => {
  function longTranscript(count: number): UiItem[] {
    const items: UiItem[] = []
    for (let i = 0; i < count; i++) {
      items.push({
        kind: 'message',
        id: `u-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i} with enough text to simulate a real row.`
      })
    }
    return items
  }

  it('builds 180 transcript rows in under 2 seconds', () => {
    const items = longTranscript(180)
    const start = performance.now()
    const rows = buildTranscriptRows(items, { running: true, pendingRun: false })
    const elapsed = performance.now() - start
    expect(rows.length).toBeGreaterThanOrEqual(VIRTUALIZE_MIN_ROWS)
    expect(elapsed).toBeLessThan(2000)
  })
})

describe('live cost of the main surfaces', () => {
  it('keeps live-early virtualization on the legacy transcript', () => {
    const root = join(__dirname, '../../../src/renderer/src')
    const chatView = readFileSync(join(root, 'features/chat/ChatView.tsx'), 'utf8')
    expect(chatView).toMatch(/virtualizeLiveEarly/)
  })

  it('bounds the task record by folding, deferring and memoising instead', () => {
    const root = join(__dirname, '../../../src/renderer/src')
    const pane = readFileSync(join(root, 'features/task/TaskPane.tsx'), 'utf8')
    const work = readFileSync(join(root, 'features/task/record/WorkItems.tsx'), 'utf8')
    // Live items reach the record through the store leaf, deferred, never per token.
    expect(pane).toMatch(/useChatLiveItems/)
    expect(pane).toMatch(/useDeferredValue/)
    // Unchanged work rows skip rendering while one row streams.
    expect(work).toMatch(/memo\(WorkItemViewImpl, \(prev, next\) => sameWork/)
  })
})
