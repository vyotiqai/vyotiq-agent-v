/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { buildRecordModel } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { RecordOpenContext, WORK_PAGE, earlierOpenKey, foldsToOpen, workOpenKey } from '@renderer/features/task/recordFind'

/**
 * A long run's work opens on its latest rows. Measured on a 5,000-call run:
 * loading every page and unfolding it all was 11 s to draw, 61.7k nodes and
 * a second per keypress. The rest is a "Show more" line away, and find in
 * record opens it when a match is up there.
 */

afterEach(cleanup)

const T0 = Date.parse('2026-10-09T05:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

/** A run with no plan: `calls` calls on distinct files (one row each, unlike reads), then an answer. */
function longRun(calls: number): UiItem[] {
  const items: UiItem[] = [{ kind: 'message', id: 'user-0', role: 'user', content: 'Read everything', at: at(0) }]
  for (let i = 1; i <= calls; i++) {
    items.push({
      kind: 'tool',
      id: `t${i}`,
      at: at(i),
      endedAt: at(i),
      tool: { id: `c${i}`, name: 'mcp__fs__stat', summary: `src/file${i}.ts`, status: 'done', content: 'x', argsPreview: JSON.stringify({ path: `src/file${i}.ts` }) }
    })
  }
  items.push({ kind: 'message', id: 'answer', role: 'assistant', content: 'Read them all.', at: at(calls + 1) })
  return items
}

function show(items: UiItem[], open: ReadonlySet<string>) {
  const options = { running: false }
  const model = buildRecordModel(items, options)
  return {
    model,
    ...render(
      <RecordOpenContext.Provider value={open}>
        <TaskRecord model={model} options={options} messageCount={items.length} />
      </RecordOpenContext.Provider>
    )
  }
}

const shownFiles = (root: HTMLElement): number => (root.textContent?.match(/file\d+\.ts/g) ?? []).length

describe('a long run’s work', () => {
  it('opens on its latest rows and shows a page more at a time', () => {
    const items = longRun(450)
    const { container } = show(items, new Set([workOpenKey(1)]))
    const earlier = () => container.querySelector<HTMLButtonElement>('[data-record-earlier]')
    expect(WORK_PAGE).toBe(200)
    expect(earlier()?.textContent).toBe('250 earlierShow 200 more')
    expect(container.textContent).toContain('file450.ts')
    expect(container.textContent).not.toContain('file250.ts')
    expect(shownFiles(container)).toBe(200)

    fireEvent.click(earlier()!)
    expect(earlier()?.textContent).toBe('50 earlierShow 50 more')
    expect(shownFiles(container)).toBe(400)

    fireEvent.click(earlier()!)
    expect(earlier()).toBeNull()
    expect(container.textContent).toContain('file1.ts')
  })

  it('shows a short run in full', () => {
    const { container } = show(longRun(WORK_PAGE), new Set([workOpenKey(1)]))
    expect(container.querySelector('[data-record-earlier]')).toBeNull()
    expect(shownFiles(container)).toBe(WORK_PAGE)
  })

  it('opens the earlier rows for a find match up there, and not for one below', () => {
    const items = longRun(450)
    const model = buildRecordModel(items, { running: false })
    // The list's key is its first row's: the first call's.
    const firstId = 't1'
    const up = foldsToOpen(model.runs, 'file7.ts')
    expect([...up]).toContain(workOpenKey(1))
    expect([...up]).toContain(earlierOpenKey(firstId))
    expect([...foldsToOpen(model.runs, 'file449.ts')]).not.toContain(earlierOpenKey(firstId))

    const { container } = show(items, up)
    expect(container.querySelector('[data-record-earlier]')).toBeNull()
    expect(container.textContent).toContain('file7.ts')
  })
})
