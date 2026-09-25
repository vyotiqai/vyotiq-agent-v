import { describe, expect, it } from 'vitest'
import type { UiItem } from '@shared/transcript'
import { buildRecordModel, runStateOf } from '@renderer/features/task/recordModel'
import { latestRetryableErrorId } from '@renderer/features/task/record/WorkItems'

const T0 = Date.parse('2026-09-24T10:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

let seq = 0
const id = (p: string): string => `${p}-${++seq}`

function user(text: string, s: number): UiItem {
  return { kind: 'message', id: id('u'), role: 'user', content: text, at: at(s) }
}
function said(text: string, s: number, extra: Partial<Extract<UiItem, { kind: 'message' }>> = {}): UiItem {
  return { kind: 'message', id: id('a'), role: 'assistant', content: text, at: at(s), ...extra }
}
function tool(name: string, args: Record<string, unknown>, content: string, s: number, status: 'done' | 'running' | 'fail' = 'done'): UiItem {
  return {
    kind: 'tool',
    id: id('t'),
    at: at(s),
    tool: { id: id('call'), name, summary: '', status, content, argsPreview: JSON.stringify(args) }
  }
}
/** The todo tool's real result: "N/M complete" then one line per item. */
function todos(items: Array<[string, ' ' | '~' | 'x' | '-', string]>, s: number): UiItem {
  const done = items.filter(([, m]) => m === 'x').length
  const body = [`${done}/${items.length} complete`, ...items.map(([i, m, t]) => `[${m}] (${i}) ${t}`)].join('\n')
  return tool('todo_write', {}, body, s)
}

const read = (path: string, s: number): UiItem => tool('read', { path }, 'contents', s)
const edit = (path: string, oldS: string, newS: string, s: number): UiItem =>
  tool('str_replace', { path, old_string: oldS, new_string: newS }, `Replaced in ${path}`, s)
const run = (command: string, s: number, code = 0): UiItem =>
  tool('terminal', { command }, `cwd: /ws\nshell: pwsh\nok\nexit_code: ${code}`, s)

describe('buildRecordModel', () => {
  it('groups work under the step that was in progress when it ran', () => {
    const items = [
      user('Fix the flaky updater test', 0),
      read('src/main/updater/swap.ts', 1),
      read('tests/main/unit/updaterSwap.test.ts', 2),
      todos([['a', '~', 'Find the open handle'], ['b', ' ', 'Fix the swap']], 10),
      read('src/main/updater/staging.ts', 11),
      todos([['a', 'x', 'Find the open handle'], ['b', '~', 'Fix the swap']], 60),
      edit('src/main/updater/swap.ts', 'a\nb', 'a\nc\nd', 61),
      run('pnpm vitest run tests/main/unit/updaterSwap.test.ts', 70),
      todos([['a', 'x', 'Find the open handle'], ['b', 'x', 'Fix the swap']], 120),
      said('The watcher kept a handle open; it now closes before the swap.', 121)
    ]
    const [r] = buildRecordModel(items, { running: false }).runs
    expect(r!.text).toBe('Fix the flaky updater test')
    // Reading before any step started is setup: one explore line for both reads.
    expect(r!.setup.map((w) => w.kind)).toEqual(['explore'])
    expect(r!.steps.map((s) => [s.n, s.title, s.state])).toEqual([
      [1, 'Find the open handle', 'done'],
      [2, 'Fix the swap', 'done']
    ])
    expect(r!.steps[0]!.work.map((w) => w.kind)).toEqual(['explore'])
    // A command and an edit are cards, in the order they happened.
    expect(r!.steps[1]!.work.map((w) => w.kind)).toEqual(['card', 'card'])
    // Durations come from the stamps on the todo writes.
    expect(r!.steps[0]!.startedAt).toBe(T0 + 10_000)
    expect(r!.steps[0]!.endedAt).toBe(T0 + 60_000)
    // −b +c +d
    expect(r!.steps[1]!.edits).toEqual({ files: 1, add: 2, del: 1 })
    expect(r!.result?.text).toBe('The watcher kept a handle open; it now closes before the swap.')
  })

  it('seeds steps from create_plan’s own todos, whose result does not echo them', () => {
    const items = [
      user('Analyze the codebase', 0),
      tool(
        'create_plan',
        { title: 'Codebase analysis', plan: '# Codebase analysis', todos: [{ id: '1', content: 'Map the runtime', status: 'in_progress' }, { id: '2', content: 'Write the report', status: 'pending' }] },
        'Wrote plan.md',
        5
      ),
      read('src/main/index.ts', 6)
    ]
    const [r] = buildRecordModel(items, { running: true }).runs
    expect(r!.setup).toEqual([expect.objectContaining({ kind: 'plan', title: 'Codebase analysis' })])
    expect(r!.steps.map((s) => s.state)).toEqual(['running', 'queued'])
    expect(r!.steps[0]!.work.map((w) => w.kind)).toEqual(['explore'])
  })

  it('does not call mid-run narration a result while the run is live', () => {
    const items = [user('Do it', 0), said('Looking at the updater first.', 1)]
    const [live] = buildRecordModel(items, { running: true }).runs
    expect(live!.result).toBeNull()
    expect(live!.after.map((w) => w.kind)).toEqual(['note'])
    const [over] = buildRecordModel(items, { running: false }).runs
    expect(over!.result?.text).toBe('Looking at the updater first.')
  })

  it('does not lift a note that later work followed, even in a later step', () => {
    const items = [
      user('Do it', 0),
      todos([['a', '~', 'One'], ['b', ' ', 'Two']], 1),
      said('Step one looks fine.', 2),
      todos([['a', 'x', 'One'], ['b', '~', 'Two']], 3),
      read('x.ts', 4)
    ]
    const [r] = buildRecordModel(items, { running: false }).runs
    expect(r!.result).toBeNull()
    expect(r!.steps[0]!.work.map((w) => w.kind)).toEqual(['note'])
  })

  it('puts a pending approval at the top and marks its step as needing you', () => {
    const gated: UiItem = {
      ...(run('pnpm vitest run', 5) as Extract<UiItem, { kind: 'tool' }>),
      approval: {
        requestId: 'req-1',
        runId: 'r',
        toolCallId: 'call',
        name: 'terminal',
        summary: 'pnpm vitest run',
        argsPreview: '{"command":"pnpm vitest run"}',
        mutating: true
      }
    } as UiItem
    const items = [user('Do it', 0), todos([['a', '~', 'Verify']], 1), gated]
    const [r] = buildRecordModel(items, { running: true }).runs
    expect(r!.needs).toHaveLength(1)
    expect(r!.needs[0]).toMatchObject({ kind: 'approval', stepKey: 'a' })
    expect(r!.steps[0]!.state).toBe('needs')
    expect(runStateOf(r!, true, { running: true })).toBe('needs')
  })

  it('splits follow-ups into runs, each with its own steps', () => {
    const items = [
      user('First', 0),
      todos([['a', 'x', 'Only step']], 5),
      said('Done.', 6),
      user('Now also check the docs', 100),
      read('docs/a.md', 101),
      said('Docs are fine.', 102)
    ]
    const { runs } = buildRecordModel(items, { running: false })
    expect(runs.map((r) => [r.n, r.text])).toEqual([
      [1, 'First'],
      [2, 'Now also check the docs']
    ])
    expect(runs[0]!.steps).toHaveLength(1)
    // No plan in run 2: its work is all "after", its closing words its result.
    expect(runs[1]!.steps).toHaveLength(0)
    expect(runs[1]!.after.map((w) => w.kind)).toEqual(['explore'])
    expect(runs[1]!.result?.text).toBe('Docs are fine.')
  })

  it('never leaves a step "running" once the run is over', () => {
    const items = [user('Do it', 0), todos([['a', '~', 'Long step']], 1), read('a.ts', 2)]
    expect(buildRecordModel(items, { running: false }).runs[0]!.steps[0]!.state).toBe('stopped')
    expect(buildRecordModel(items, { running: false, failed: true }).runs[0]!.steps[0]!.state).toBe('failed')
  })

  it('prefers the live todos.json for the latest run while it is in flight', () => {
    const items = [user('Do it', 0), todos([['a', '~', 'One'], ['b', ' ', 'Two']], 1)]
    const [r] = buildRecordModel(items, {
      running: true,
      liveTodos: [
        { id: 'a', content: 'One', status: 'completed' },
        { id: 'b', content: 'Two', status: 'in_progress' }
      ]
    }).runs
    expect(r!.steps.map((s) => s.state)).toEqual(['done', 'running'])
  })

  it('never gives a follow-up the last run’s plan from todos.json', () => {
    // todos.json still holds run 1's finished plan while run 2 (no plan) runs.
    const items = [
      user('Do it', 0),
      todos([['a', 'x', 'One']], 1),
      said('Done.', 2),
      user('Thanks — anything else?', 10),
      said('Nothing else.', 11)
    ]
    const { runs } = buildRecordModel(items, {
      running: true,
      liveTodos: [{ id: 'a', content: 'One', status: 'completed' }]
    })
    expect(runs[0]!.steps).toHaveLength(1)
    expect(runs[1]!.steps).toHaveLength(0)
  })

  it('keeps errors and folded history where they happened', () => {
    const items: UiItem[] = [
      user('Do it', 0),
      read('a.ts', 1),
      { kind: 'run_error', id: 'e1', message: 'Provider rate limit', code: 'rate_limit', at: at(2) }
    ]
    const [r] = buildRecordModel(items, { running: false, failed: true }).runs
    expect(r!.after.map((w) => w.kind)).toEqual(['explore', 'error'])
  })
})

describe('a run that ended in an error', () => {
  const failure = (s: number): UiItem => ({ kind: 'run_error', id: id('err'), message: 'Connection dropped', code: 'PROVIDER_NETWORK', at: at(s) }) as UiItem

  it('reads as failed in the history, though a later run finished', () => {
    const items = [user('Summarize the notes', 0), read('a.md', 1), failure(2), user('Try the other model', 10), said('Here it is.', 11)]
    const options = { running: false, failed: false }
    const { runs } = buildRecordModel(items, options)
    expect(runStateOf(runs[0]!, false, options)).toBe('failed')
    expect(runStateOf(runs[1]!, true, options)).toBe('done')
  })

  it('is not failed when the run carried on after the error', () => {
    const items = [user('Fix it', 0), failure(1), read('a.ts', 5), said('Fixed.', 6)]
    const options = { running: false, failed: false }
    const [r] = buildRecordModel(items, options).runs
    expect(runStateOf(r!, true, options)).toBe('done')
  })
})

describe('latestRetryableErrorId', () => {
  const failure = (key: string): UiItem => ({ kind: 'run_error', id: key, message: 'Connection lost', code: 'PROVIDER_NETWORK' }) as UiItem

  it('names the error that ended the latest turn', () => {
    expect(latestRetryableErrorId([user('Go', 0), read('a', 1), failure('e1')], false)).toBe('e1')
  })

  it('names nothing once a newer instruction was sent, or while the run is live', () => {
    expect(latestRetryableErrorId([user('Go', 0), failure('e1'), user('Again', 5)], false)).toBeNull()
    expect(latestRetryableErrorId([user('Go', 0), failure('e1')], true)).toBeNull()
    expect(latestRetryableErrorId([user('Go', 0), said('Done.', 1)], false)).toBeNull()
  })
})
