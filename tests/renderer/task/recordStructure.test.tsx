/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { buildRecordModel, type BuildOptions } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { WorkList } from '@renderer/features/task/record/WorkItems'
import { TaskPane, type TaskPaneProps } from '@renderer/features/task/TaskPane'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'

/**
 * The record's shape where it is read at a glance: the steps bleed into the
 * gutter and keep a gap between them, the live fill stops before the work done
 * between two steps, every record row keeps the same chevron slot, and a pane
 * that has nothing to draw yet says what it is loading or doing.
 */

const RENDERER_SRC = join(__dirname, '../../../src/renderer/src')
const TASK_SRC = join(RENDERER_SRC, 'features/task')

beforeEach(() => {
  window.vyotiq = {
    readRunArtifact: vi.fn().mockResolvedValue({ ok: true, data: { exists: false, content: '' } })
  } as unknown as typeof window.vyotiq
})
afterEach(cleanup)

const T0 = Date.parse('2026-10-03T09:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()
let seq = 0
const id = (p: string): string => `${p}-${++seq}`

const user = (text: string, s: number): UiItem => ({
  kind: 'message',
  id: 'user-0',
  role: 'user',
  content: text,
  at: at(s)
})
function tool(name: string, args: Record<string, unknown>, content: string, s: number): UiItem {
  return {
    kind: 'tool',
    id: id('t'),
    at: at(s),
    endedAt: at(s + 1),
    tool: {
      id: id('c'),
      name,
      summary: String(args.path ?? ''),
      status: 'done',
      content,
      argsPreview: JSON.stringify(args)
    }
  }
}
function todos(list: Array<[string, ' ' | '~' | 'x', string]>, s: number): UiItem {
  const done = list.filter(([, m]) => m === 'x').length
  return tool('todo_write', {}, [`${done}/${list.length} complete`, ...list.map(([i, m, t]) => `[${m}] (${i}) ${t}`)].join('\n'), s)
}
const read = (path: string, s: number): UiItem => tool('read', { path }, 'contents', s)

/**
 * A live run whose first step is running again: it settled once, did one lookup
 * between steps, and was put back in progress — so the step is live (it has
 * the fill) and still holds work that belongs to no step.
 */
function liveStepWithBetweenWork(): UiItem[] {
  return [
    user('Go', 0),
    todos([['a', '~', 'Find it'], ['b', ' ', 'Fix it']], 1),
    read('a.ts', 2),
    todos([['a', 'x', 'Find it'], ['b', ' ', 'Fix it']], 3),
    read('between.ts', 4),
    todos([['a', '~', 'Find it'], ['b', ' ', 'Fix it']], 5),
    read('a2.ts', 6)
  ]
}

function showRecord(items: UiItem[], options: BuildOptions): HTMLElement {
  return render(
    <RunSessionProvider value={{ workspacePath: '/ws', runId: 'r1' }}>
      <TaskRecord model={buildRecordModel(items, options)} options={options} messageCount={items.length} />
    </RunSessionProvider>
  ).container
}

describe('the steps list', () => {
  it('bleeds each row into the gutter and keeps a gap between them', () => {
    const steps = showRecord(liveStepWithBetweenWork(), { running: true }).querySelector('ol[aria-label="Steps"]')
    expect(steps).not.toBeNull()
    expect(steps!.classList.contains('-mx-2')).toBe(true)
    expect(steps!.classList.contains('space-y-1')).toBe(true)
  })
})

describe('a live step’s fill', () => {
  it('stops before the work done between this step and the next', () => {
    const container = showRecord(liveStepWithBetweenWork(), { running: true })
    const row = container.querySelector('[data-step="1"]') as HTMLElement
    expect(row).not.toBeNull()
    const fill = row.querySelector('.bg-card')
    expect(fill).not.toBeNull()
    // The fill wraps the title and the body only: work that belongs to no step
    // paints on no step’s card.
    expect(fill!.querySelector('[data-step-between]')).toBeNull()
    // …and it is still drawn, as the step’s own sibling below it.
    const between = row.querySelector('[data-step-between="1"]')
    expect(between).not.toBeNull()
    expect(between!.parentElement).toBe(row)
    expect(between!.textContent).toContain('between.ts')
  })
})

describe('a work line’s chevron', () => {
  it('is pulled in like the step row’s, so trailing facts share one right edge', () => {
    const container = render(
      <RunSessionProvider value={{ workspacePath: '/ws', runId: 'r1' }}>
        <WorkList
          items={[{ kind: 'explore', id: 'e1', tools: [{ ...read('a.ts', 1), id: 'r1' }] } as never]}
        />
      </RunSessionProvider>
    ).container
    const line = container.querySelector('button[aria-expanded]') as HTMLElement
    const chevron = line.lastElementChild as SVGElement
    expect(chevron.tagName.toLowerCase()).toBe('svg')
    expect(chevron.classList.contains('-ml-0.5')).toBe(true)
    expect(chevron.classList.contains('shrink-0')).toBe(true)
  })

  it('keeps the same slot on a nested lookup’s row', () => {
    const first = { ...read('a.ts', 1), id: 'r1' }
    const second = { ...read('b.ts', 2), id: 'r2' }
    const container = render(
      <RunSessionProvider value={{ workspacePath: '/ws', runId: 'r1' }}>
        <WorkList items={[{ kind: 'explore', id: 'e1', tools: [first, second] } as never]} />
      </RunSessionProvider>
    ).container
    fireEvent.click(container.querySelector('button[aria-expanded]') as HTMLElement)
    const rows = container.querySelectorAll('[data-explore-list] li > div')
    expect(rows.length).toBe(2)
    for (const row of rows) {
      const slot = row.lastElementChild as HTMLElement
      // The chevron’s slot, as the parent WorkLine keeps it, so a nested
      // lookup’s time ends on the same right edge.
      expect(slot.tagName.toLowerCase()).toBe('span')
      expect(slot.classList.contains('-ml-0.5')).toBe(true)
      expect(slot.classList.contains('w-[11px]')).toBe(true)
      expect(slot.getAttribute('aria-hidden')).toBe('true')
    }
  })
})

describe('Find in record', () => {
  it('opens no step wrapper of its own, and neither does the steps list', () => {
    expect(readFileSync(join(TASK_SRC, 'recordFind.ts'), 'utf8')).not.toMatch(/StepReveal/)
    expect(readFileSync(join(TASK_SRC, 'record/Steps.tsx'), 'utf8')).not.toMatch(/StepReveal/)
  })
})

const brief: UiItem = { kind: 'message', id: 'user-0', role: 'user', content: 'Fix the parser', at: at(0) }
const lookup: UiItem = {
  kind: 'tool',
  id: 't-1',
  at: at(1),
  endedAt: at(2),
  tool: { id: 'c-1', name: 'read', summary: 'src/parse.ts', status: 'done', content: 'contents', argsPreview: '{"path":"src/parse.ts"}' }
}

function pane(over: Partial<TaskPaneProps>): HTMLElement {
  const props: TaskPaneProps = {
    workspacePath: '/ws',
    runId: 'r1',
    items: [],
    running: false,
    pendingRun: false,
    turnFailed: false,
    turnStatus: null,
    compacting: false,
    showThinking: false,
    run: null,
    onStop: vi.fn(),
    actions: {},
    messageCount: 0,
    composer: null,
    ...over
  }
  return render(<TaskPane {...props} />).container
}

/** The one "Loading the record…" row: a status region, busy, said once. */
function loadingRows(): HTMLElement[] {
  return screen.queryAllByText('Loading the record…')
}

describe('a pane with nothing to draw yet', () => {
  it('says what a run that has started is doing, not an empty column', () => {
    const container = pane({ pendingRun: true })
    expect(screen.getByText('Now')).toBeTruthy()
    expect(container.textContent).toContain('Starting')
    expect(container.querySelector('[data-chat-empty-state]')).toBeNull()
    expect(loadingRows()).toHaveLength(0)
  })
})

describe('a loading record', () => {
  it('says so once when the record itself is still loading', () => {
    pane({ transcriptLoading: true, items: [] })
    const rows = loadingRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.getAttribute('role')).toBe('status')
    expect(rows[0]!.getAttribute('aria-busy')).toBe('true')
  })

  it('says so once under the work already on screen, not twice', () => {
    const container = pane({ transcriptLoading: true, items: [brief, lookup], running: true })
    expect(screen.getByText('Fix the parser')).toBeTruthy()
    expect(container.textContent).toContain('parse.ts')
    const rows = loadingRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.getAttribute('role')).toBe('status')
    expect(rows[0]!.getAttribute('aria-busy')).toBe('true')
  })
})