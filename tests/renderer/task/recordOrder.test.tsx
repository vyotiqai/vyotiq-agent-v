/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { buildRecordModel, type BuildOptions } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'

afterEach(cleanup)

const T0 = Date.parse('2026-09-24T10:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()
let seq = 0
const id = (p: string): string => `${p}-${++seq}`

const user = (text: string, s: number): UiItem => ({ kind: 'message', id: 'user-0', role: 'user', content: text, at: at(s) })
function tool(name: string, args: Record<string, unknown>, content: string, s: number): UiItem {
  return { kind: 'tool', id: id('t'), at: at(s), tool: { id: id('c'), name, summary: String(args.path ?? ''), status: 'done', content, argsPreview: JSON.stringify(args) } }
}
function todos(list: Array<[string, ' ' | '~' | 'x', string]>, s: number): UiItem {
  const done = list.filter(([, m]) => m === 'x').length
  return tool('todo_write', {}, [`${done}/${list.length} complete`, ...list.map(([i, m, t]) => `[${m}] (${i}) ${t}`)].join('\n'), s)
}
const read = (path: string, s: number): UiItem => tool('read', { path }, 'contents', s)

function show(items: UiItem[], options: BuildOptions, activity: string | null = null) {
  const model = buildRecordModel(items, options)
  return render(<TaskRecord model={model} options={options} activity={activity} messageCount={1} />)
}

/** Document order of two nodes: negative when `a` comes first. */
function before(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
}

describe('the record draws work where it happened', () => {
  it('puts work done between two steps after the first, outside it, with the live line there', () => {
    const items = [
      user('Go', 0),
      todos([['a', '~', 'Find it'], ['b', ' ', 'Fix it']], 1),
      read('a.ts', 2),
      todos([['a', 'x', 'Find it'], ['b', ' ', 'Fix it']], 3),
      read('between.ts', 4)
    ]
    const { container } = show(items, { running: true }, 'Working')
    const between = container.querySelector('[data-step-between="1"]')!
    expect(between).not.toBeNull()
    // Outside step 1's own (folded) body, and before step 2's row.
    const step2 = container.querySelector('[data-step="2"]')!
    expect(before(between, step2)).toBe(true)
    expect(between.textContent).toContain('Now')
    expect(between.textContent).toContain('Working')
    // One live line in the record, not a second one after the steps.
    expect(screen.getAllByText('Now')).toHaveLength(1)
  })

  it('keeps a step a later plan replaced, marked, with its work', () => {
    const items = [user('Go', 0), todos([['a', '~', 'Old step']], 1), read('a.ts', 2), todos([['n', '~', 'New step']], 3)]
    const { container } = show(items, { running: false })
    const old = container.querySelector('[data-step-superseded]')!
    expect(old).not.toBeNull()
    expect(old.textContent).toContain('Old step')
    expect(old.textContent).toContain('replaced')
  })

  it('draws the live line in the setup list while the plan waits to start', () => {
    const plan = tool('create_plan', { title: 'P', plan: '# P', todos: [{ id: '1', content: 'Step', status: 'pending' }] }, 'Wrote plan.md', 1)
    const items = [user('Go', 0), plan, read('context.ts', 2)]
    const { container } = show(items, { running: true }, 'Working')
    const steps = container.querySelector('ol[aria-label="Steps"]')!
    const now = screen.getByText('Now')
    expect(before(now, steps)).toBe(true)
  })

  it('draws the live line after the steps once every step is settled', () => {
    // Step a is marked done, yet the model keeps working: that is the run's loose work.
    const items = [
      user('Go', 0),
      todos([['a', '~', 'Only step']], 1),
      read('first.ts', 2),
      todos([['a', 'x', 'Only step']], 3),
      said('Done — one more look.', 4)
    ]
    const { container } = show(items, { running: true }, 'Working')
    // All steps settled: the tail is the run's loose work, after the steps.
    const steps = container.querySelector('ol[aria-label="Steps"]')!
    expect(before(steps, screen.getByText('Now'))).toBe(true)
    expect(container.textContent).toContain('Done — one more look.')
  })
})

function said(text: string, s: number): UiItem {
  return { kind: 'message', id: id('a'), role: 'assistant', content: text, at: at(s) }
}
