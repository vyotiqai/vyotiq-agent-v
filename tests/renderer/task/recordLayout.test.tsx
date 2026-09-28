/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { buildRecordModel, type BuildOptions } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { workSummary } from '@renderer/features/task/record/WorkItems'
import { RecordOpenContext, foldsToOpen, looseOpenKey } from '@renderer/features/task/recordFind'

/**
 * The record reads in the order the work happened — brief, work, result —
 * and a settled run with an answer folds its loose work to one line, so the
 * answer sits a few rows under the brief.
 */

afterEach(cleanup)

const T0 = Date.parse('2026-09-28T09:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()
let seq = 0
const id = (p: string): string => `${p}-${++seq}`

const user = (text: string, s: number): UiItem => ({ kind: 'message', id: 'user-0', role: 'user', content: text, at: at(s) })
const said = (text: string, s: number): UiItem => ({ kind: 'message', id: id('a'), role: 'assistant', content: text, at: at(s) })
function tool(name: string, args: Record<string, unknown>, content: string, s: number, status: 'done' | 'fail' = 'done'): UiItem {
  return {
    kind: 'tool',
    id: id('t'),
    at: at(s),
    endedAt: at(s + 1),
    tool: { id: id('c'), name, summary: String(args.path ?? args.command ?? ''), status, content, argsPreview: JSON.stringify(args) }
  }
}
const edit = (path: string, s: number): UiItem =>
  tool('edit', { path, diff: '@@ -1 +1 @@\n-a\n+b' }, `Updated ${path}`, s)

/** A run with no plan: lookups, a note, a command, two edits, then its answer. */
function noPlanRun(answer = true): UiItem[] {
  return [
    user('Fix the flaky login test', 0),
    tool('read', { path: 'src/login.ts' }, 'contents', 1),
    tool('grep', { pattern: 'retry' }, 'src/login.ts:4', 3),
    said('WORK_NOTE the retry loop never awaits.', 5),
    tool('terminal', { command: 'pnpm vitest run login' }, 'ok\nexit_code: 0', 6),
    edit('src/login.ts', 9),
    edit('tests/login.test.ts', 11),
    ...(answer ? [said('ANSWER_TEXT The retry loop now awaits each attempt.', 14)] : [])
  ]
}

function show(items: UiItem[], options: BuildOptions, open: ReadonlySet<string> = new Set()) {
  const model = buildRecordModel(items, options)
  const view = render(
    <RecordOpenContext.Provider value={open}>
      <TaskRecord model={model} options={options} messageCount={items.length} />
    </RecordOpenContext.Provider>
  )
  return { model, ...view }
}

/** Document order of two nodes: negative when `a` comes first. */
function before(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
}

describe('the record’s reading order', () => {
  it('reads brief, then work, then the result, then the receipt', () => {
    const { container } = show(noPlanRun(), { running: false })
    const brief = container.querySelector('[data-brief="1"]')!
    const work = container.querySelector('[data-loose-work]')!
    const result = container.querySelector('section[aria-label="Result"]')!
    expect(brief).not.toBeNull()
    expect(result.textContent).toContain('ANSWER_TEXT')
    expect(before(brief, work)).toBe(true)
    expect(before(work, result)).toBe(true)
  })
})

describe('a settled run’s loose work', () => {
  it('folds to one line saying what it amounts to', () => {
    const { container, getByRole } = show(noPlanRun(), { running: false })
    const row = getByRole('button', { name: /2 lookups · 1 command · 2 edits/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toContain('WORK_NOTE')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('WORK_NOTE')
  })

  it('shows every row while the run is live', () => {
    const { container } = show(noPlanRun(false), { running: true })
    expect(container.querySelector('[data-loose-work]')).toBeNull()
    expect(container.textContent).toContain('WORK_NOTE')
  })

  it('shows every row when the run ended without an answer', () => {
    const { container } = show(noPlanRun(false), { running: false, stopped: true })
    expect(container.querySelector('[data-loose-work]')).toBeNull()
    expect(container.textContent).toContain('WORK_NOTE')
  })

  it('opens for a find match inside it', () => {
    const items = noPlanRun()
    const model = buildRecordModel(items, { running: false })
    const open = foldsToOpen(model.runs, 'work_note')
    expect([...open]).toContain(looseOpenKey(1, 'after'))
    const { container } = show(items, { running: false }, open)
    expect(container.textContent).toContain('WORK_NOTE')
  })

  it('keeps an error in view under the folded line', () => {
    const items = noPlanRun()
    items.splice(7, 0, { kind: 'run_error', id: 'err-1', message: 'ERROR_TEXT provider hiccup', at: at(12) } as UiItem)
    const { container, getByRole } = show(items, { running: false })
    expect(getByRole('button', { name: /1 error/ }).getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).toContain('ERROR_TEXT')
    expect(container.textContent).not.toContain('WORK_NOTE')
  })
})

describe('workSummary', () => {
  it('counts by kind, singular and plural', () => {
    const model = buildRecordModel(noPlanRun(), { running: false })
    expect(workSummary(model.runs[0]!.after)).toBe('2 lookups · 1 command · 2 edits')
  })

  it('falls back to notes when nothing was called', () => {
    const model = buildRecordModel([user('Hi', 0), said('one', 1), said('two', 2), said('three', 3)], { running: true })
    expect(workSummary(model.runs[0]!.after)).toBe('3 notes')
  })
})

const todos = (rows: Array<[string, 'x' | '~' | ' ', string]>, s: number): UiItem => {
  const mark = { x: '[x]', '~': '[~]', ' ': '[ ]' }
  const list = rows.map(([id, st, text]) => ({
    id,
    content: text,
    status: st === 'x' ? 'completed' : st === '~' ? 'in_progress' : 'pending'
  }))
  return tool(
    'todo_write',
    { todos: list },
    `${rows.filter((r) => r[1] === 'x').length}/${rows.length} complete\n${rows.map(([id, st, text]) => `${mark[st]} (${id}) ${text}`).join('\n')}`,
    s
  )
}

describe('a failed run', () => {
  it('keeps the error that ended it in view under its folded step', () => {
    const items: UiItem[] = [
      user('Fix it', 0),
      todos([['a', '~', 'Run the suite']], 1),
      tool('read', { path: 'a.ts' }, 'contents', 2),
      { kind: 'run_error', id: 'err-step', message: 'STEP_ERROR connection reset', code: 'PROVIDER_NETWORK', at: at(4) } as UiItem
    ]
    const { container } = show(items, { running: false, failed: true })
    const step = container.querySelector('[data-step="1"]')!
    expect(step.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false')
    expect(step.querySelector('[data-step-errors="1"]')?.textContent).toContain('STEP_ERROR')
    expect(step.textContent).not.toContain('a.ts')
  })
})

describe('a call refused at approval', () => {
  const denied = (name: string, args: Record<string, unknown>): UiItem =>
    tool(name, args, `The user denied permission to run ${name}. Do not retry it; ask what to do instead or continue without it.`, 3, 'fail')

  it('reads Denied on a command, with no exit code and no failure colour', () => {
    const { container } = show([user('Run it', 0), denied('terminal', { command: 'rm -rf dist' })], { running: false })
    const card = container.querySelector('[data-record-command]')!
    expect(card.textContent).toContain('Denied')
    expect(card.textContent).not.toContain('exit')
    expect(card.querySelector('.text-danger')).toBeNull()
  })

  it('reads Denied on an edit, without the failure colour', () => {
    const { container } = show([user('Edit it', 0), denied('edit', { path: 'a.ts', diff: '@@\n-a\n+b' })], { running: false })
    const card = container.querySelector('[data-record-edit]')!
    expect(card.textContent).toContain('Denied')
    expect(card.querySelector('.text-danger')).toBeNull()
  })
})
