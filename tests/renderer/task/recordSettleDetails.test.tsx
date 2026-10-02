/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor, within } from '@testing-library/react'
import type { TaskOutcome } from '@shared/ipc'
import type { UiItem } from '@shared/transcript'
import { buildRecordModel, type BuildOptions } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { RecordActionsContext } from '@renderer/features/task/record/WorkItems'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'
import { bumpTaskOutcome } from '@renderer/features/task/taskOutcomeStore'

/**
 * What the record says once a run has ended: where a failed one broke, how
 * far a stopped one got, what became of each edit, and what Rerun will do.
 */

afterEach(cleanup)

const T0 = Date.parse('2026-10-01T09:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()
let seq = 0
const id = (p: string): string => `${p}-${++seq}`

const user = (text: string, s: number): UiItem => ({ kind: 'message', id: 'user-0', role: 'user', content: text, at: at(s) })
const said = (text: string, s: number): UiItem => ({ kind: 'message', id: id('a'), role: 'assistant', content: text, at: at(s) })
function terminal(command: string, content: string, s: number, status: 'done' | 'fail' = 'done'): UiItem {
  return {
    kind: 'tool',
    id: id('t'),
    at: at(s),
    endedAt: at(s + 1),
    tool: { id: id('c'), name: 'terminal', summary: command, status, content, argsPreview: JSON.stringify({ command }) }
  }
}
function edit(path: string, s: number): UiItem {
  return {
    kind: 'tool',
    id: id('t'),
    at: at(s),
    endedAt: at(s + 1),
    tool: {
      id: id('c'),
      name: 'edit',
      summary: path,
      status: 'done',
      content: `Updated ${path}`,
      argsPreview: JSON.stringify({ path, diff: '@@ -1 +1 @@\n-a\n+b' })
    }
  }
}

function show(items: UiItem[], options: BuildOptions, extra: Partial<Parameters<typeof TaskRecord>[0]> = {}) {
  return render(
    <RunSessionProvider value={{ workspacePath: '/ws', runId: 'r1' }}>
      <RecordActionsContext.Provider value={{ onOpenChanges: vi.fn() }}>
        <TaskRecord model={buildRecordModel(items, options)} options={options} messageCount={items.length} {...extra} />
      </RecordActionsContext.Provider>
    </RunSessionProvider>
  )
}

const commandButton = (container: HTMLElement, command: string): HTMLElement =>
  [...container.querySelectorAll<HTMLElement>('[data-record-command] button[aria-expanded]')].find((b) =>
    b.textContent?.includes(command)
  )!

describe('a failed run', () => {
  it('opens the command it broke on, and leaves an earlier failure folded', () => {
    const items = [
      user('Fix the tests', 0),
      terminal('pnpm test --filter first', 'FAIL first.test.ts', 2, 'fail'),
      said('Trying again.', 4),
      terminal('pnpm test --filter api', 'FAIL api.test.ts › parses the body', 6, 'fail')
    ]
    const { container } = show(items, { running: false, failed: true })
    expect(commandButton(container, 'pnpm test --filter api').getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('parses the body')
    expect(commandButton(container, 'pnpm test --filter first').getAttribute('aria-expanded')).toBe('false')
  })

  it('opens nothing when its last command passed', () => {
    const items = [user('Fix the tests', 0), terminal('pnpm lint', 'ok', 2, 'done')]
    const { container } = show(items, { running: false, failed: true })
    expect(commandButton(container, 'pnpm lint').getAttribute('aria-expanded')).toBe('false')
  })

  it('opens nothing in a run that did not fail', () => {
    const items = [user('Fix the tests', 0), terminal('pnpm test', 'FAIL x.test.ts', 2, 'fail'), said('Done anyway.', 4)]
    const { container } = show(items, { running: false })
    expect(commandButton(container, 'pnpm test').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('a stopped run', () => {
  it('says how much it changed beside Stopped', () => {
    const items = [user('Fix it', 0), edit('src/a.ts', 2), edit('src/b.ts', 4)]
    const { container } = show(items, { running: false, stopped: true })
    const detail = container.querySelector('[data-receipt-outcome-detail]')
    expect(detail?.textContent?.trim()).toBe('2 files changed')
    expect(container.querySelector('[data-receipt-outcome="stopped"]')?.textContent).toContain('Stopped 2 files changed')
  })

  it('says which step of the plan it stopped at', () => {
    const plan = (marks: Array<[string, ' ' | '~' | 'x', string]>, s: number): UiItem => {
      const done = marks.filter(([, m]) => m === 'x').length
      const body = [`${done}/${marks.length} complete`, ...marks.map(([i, m, t]) => `[${m}] (${i}) ${t}`)].join('\n')
      return { kind: 'tool', id: id('t'), at: at(s), tool: { id: id('c'), name: 'todo_write', summary: '', status: 'done', content: body, argsPreview: '{}' } }
    }
    const items = [
      user('Fix it', 0),
      plan([['s1', '~', 'Read the code'], ['s2', ' ', 'Change it'], ['s3', ' ', 'Test it']], 1),
      terminal('ls', 'src', 2),
      plan([['s1', 'x', 'Read the code'], ['s2', '~', 'Change it'], ['s3', ' ', 'Test it']], 3),
      edit('src/a.ts', 4)
    ]
    const { container } = show(items, { running: false, stopped: true })
    expect(container.querySelector('[data-receipt-outcome-detail]')?.textContent?.trim()).toBe('at step 2 of 3 · 1 file changed')
  })

  it('says nothing more when it stopped before any change or step', () => {
    const items = [user('Fix it', 0), terminal('ls', 'src', 2)]
    const { container } = show(items, { running: false, stopped: true })
    expect(container.querySelector('[data-receipt-outcome="stopped"]')).not.toBeNull()
    expect(container.querySelector('[data-receipt-outcome-detail]')).toBeNull()
  })
})

describe('edits in the work, once settled', () => {
  beforeEach(() => bumpTaskOutcome())

  it('carry Kept or Undone, and an undone one is struck through', async () => {
    const outcome: TaskOutcome = {
      files: [
        { path: 'src/a.ts', mark: 'kept' },
        { path: 'src/b.ts', mark: 'undone' }
      ]
    }
    window.vyotiq = { taskOutcome: vi.fn().mockResolvedValue({ ok: true, data: outcome }) } as unknown as typeof window.vyotiq
    const items = [user('Fix it', 0), edit('src/a.ts', 2), edit('src/b.ts', 4), said('Fixed.', 6)]
    const { container } = show(items, { running: false })
    // Two edits are under the fold's size, so their cards show as they are.
    await waitFor(() => expect(container.querySelectorAll('[data-edit-mark]')).toHaveLength(2))
    const marks = [...container.querySelectorAll('[data-record-edit]')].map((card) => [
      card.querySelector('[data-edit-mark]')?.textContent,
      card.querySelector('.line-through') != null
    ])
    expect(marks).toEqual([
      ['Kept', false],
      ['Undone', true]
    ])
  })
})

describe('Edit and rerun', () => {
  it('says what Rerun does before you press it', () => {
    const items = [user('Fix it', 0), said('Fixed.', 2)]
    const { container } = show(items, { running: false }, { editingUserMessageIndex: 0, editComposer: <div data-edit-box /> })
    const note = container.querySelector('[data-rerun-note]')
    expect(note?.textContent).toBe('Rerunning undoes this task’s edits since this brief first, then starts again from it.')
    expect(within(container).queryByText('Fixed.')).not.toBeNull()
  })
})
