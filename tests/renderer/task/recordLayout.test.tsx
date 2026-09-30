/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { buildRecordModel, type BuildOptions } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { RecordActionsContext, workSummary, type RecordActions } from '@renderer/features/task/record/WorkItems'
import { RecordOpenContext, foldsToOpen, looseOpenKey } from '@renderer/features/task/recordFind'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'

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

describe('a command while it runs', () => {
  function runningCommand(startedSecondsAgo: number): UiItem {
    return {
      kind: 'tool',
      id: id('t'),
      at: new Date(Date.now() - startedSecondsAgo * 1000).toISOString(),
      tool: { id: id('c'), name: 'terminal', summary: 'pnpm test', status: 'running', argsPreview: JSON.stringify({ command: 'pnpm test' }) }
    }
  }
  function showWith(items: UiItem[], onOpenAgentTerminal?: () => void) {
    const options: BuildOptions = { running: true }
    return render(
      <RunSessionProvider value={{ workspacePath: '/ws', runId: 'r1', onOpenAgentTerminal }}>
        <TaskRecord model={buildRecordModel(items, options)} options={options} messageCount={items.length} />
      </RunSessionProvider>
    )
  }

  it('says Running and counts up in the column its final time takes', () => {
    const { container } = showWith([user('Test it', 0), runningCommand(12)])
    const card = container.querySelector('[data-record-command]')!
    expect(card.querySelector('.vy-text-live')?.textContent).toBe('Running')
    expect(card.querySelector('.w-12')?.textContent).toMatch(/^1[23]s$/)
  })

  it('offers the Terminal tab while it runs, when the inspector can show it', () => {
    const open = vi.fn()
    const { container, getByRole } = showWith([user('Test it', 0), runningCommand(3)], open)
    fireEvent.click(getByRole('button', { name: 'Open in Terminal' }))
    expect(open).toHaveBeenCalledTimes(1)
    // Its own button, beside the header's toggle, not inside it.
    expect(container.querySelector('button[aria-expanded] button')).toBeNull()
  })

  it('reads a command stopped with the run as stopped, not as a failed exit', () => {
    const cut = tool('terminal', { command: 'pnpm test' }, 'Cancelled', 3, 'fail')
    const { container } = show([user('Test it', 0), cut], { running: false, stopped: true })
    const card = container.querySelector('[data-record-command]')!
    expect(card.textContent).toContain('Cancelled')
    expect(card.textContent).not.toContain('exit')
    expect(card.querySelector('.text-danger')).toBeNull()
  })

  it('does not offer it once the command is done, or with nowhere to open it', () => {
    const done = showWith(noPlanRun(false), vi.fn())
    expect(done.queryByRole('button', { name: 'Open in Terminal' })).toBeNull()
    done.unmount()
    const orphan = showWith([user('Test it', 0), runningCommand(3)])
    expect(orphan.queryByRole('button', { name: 'Open in Terminal' })).toBeNull()
  })
})

describe('what the record offers for the run’s open edits', () => {
  function showEnd(items: UiItem[], options: BuildOptions, actions: RecordActions, count = 0) {
    const onUndo = vi.fn()
    const view = render(
      <RunSessionProvider
        value={{ workspacePath: '/ws', runId: 'r1', pendingWrites: count > 0 ? { runId: 'r1', count, onUndo } : undefined }}
      >
        <RecordActionsContext.Provider value={actions}>
          <TaskRecord model={buildRecordModel(items, options)} options={options} messageCount={items.length} />
        </RecordActionsContext.Provider>
      </RunSessionProvider>
    )
    return { ...view, onUndo }
  }

  it('leads from the result to Review while its edits are not kept', () => {
    const onOpenChanges = vi.fn()
    const { container, getByRole } = showEnd(noPlanRun(), { running: false }, { onOpenChanges }, 2)
    expect(container.querySelector('[data-result-review]')?.textContent).toContain('2 files changed, not kept yet')
    fireEvent.click(getByRole('button', { name: 'Review changes' }))
    expect(onOpenChanges).toHaveBeenCalledWith()
  })

  it('lists what the run changed under the result, each opening in Changes', () => {
    const onOpenChanges = vi.fn()
    const { container, getByRole } = showEnd(noPlanRun(), { running: false }, { onOpenChanges })
    const list = getByRole('list', { name: 'Files changed' })
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'src/login.ts+1−1',
      'tests/login.test.ts+1−1'
    ])
    // Under the answer, not above it.
    const result = container.querySelector('[data-result-files]')!
    expect(result.previousElementSibling?.textContent).toContain('ANSWER_TEXT')
    fireEvent.click(getByRole('button', { name: /login\.test\.ts/ }))
    expect(onOpenChanges).toHaveBeenCalledWith('tests/login.test.ts')
  })

  it('folds a long list into one line into Changes, and lists nothing with nowhere to open it', () => {
    const many = [user('Rename it', 0), ...Array.from({ length: 11 }, (_, i) => edit(`src/f${i}.ts`, i + 1)), said('Renamed.', 20)]
    const onOpenChanges = vi.fn()
    const { getByRole, unmount } = showEnd(many, { running: false }, { onOpenChanges })
    expect(getByRole('list', { name: 'Files changed' }).querySelectorAll('li')).toHaveLength(9)
    fireEvent.click(getByRole('button', { name: '3 more in Changes' }))
    expect(onOpenChanges).toHaveBeenCalledWith()
    unmount()
    const bare = showEnd(noPlanRun(), { running: false }, {})
    expect(bare.queryByRole('list', { name: 'Files changed' })).toBeNull()
  })

  it('says nothing more once the edits are kept or undone', () => {
    const { container } = showEnd(noPlanRun(), { running: false }, { onOpenChanges: vi.fn() }, 0)
    expect(container.querySelector('[data-result-review]')).toBeNull()
  })

  it('ends a stopped run with Undo its changes and Resume', () => {
    const onRetry = vi.fn()
    const { getByRole, onUndo, container } = showEnd(noPlanRun(false), { running: false, stopped: true }, { onRetry }, 3)
    const line = container.querySelector('[data-receipt]')!
    expect(line.querySelector('[data-receipt-outcome="stopped"]')).not.toBeNull()
    fireEvent.click(getByRole('button', { name: 'Undo its changes' }))
    expect(onUndo).toHaveBeenCalledTimes(1)
    fireEvent.click(getByRole('button', { name: 'Resume' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('offers only Resume when nothing it changed is open, and neither while it runs', () => {
    const stopped = showEnd(noPlanRun(false), { running: false, stopped: true }, { onRetry: vi.fn() })
    expect(stopped.queryByRole('button', { name: 'Undo its changes' })).toBeNull()
    expect(stopped.getByRole('button', { name: 'Resume' })).toBeTruthy()
    stopped.unmount()
    const live = showEnd(noPlanRun(false), { running: true }, { onRetry: vi.fn() }, 3)
    expect(live.queryByRole('button', { name: 'Resume' })).toBeNull()
    expect(live.queryByRole('button', { name: 'Undo its changes' })).toBeNull()
  })

  it('leaves carrying on to the error row when it already offers Retry', () => {
    const { queryByRole } = showEnd(noPlanRun(false), { running: false, stopped: true }, { onRetry: vi.fn(), retryableErrorId: 'e1' })
    expect(queryByRole('button', { name: 'Resume' })).toBeNull()
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
