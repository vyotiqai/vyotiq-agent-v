import { describe, expect, it } from 'vitest'
import type { UiItem } from '@shared/transcript'
import { buildRecordModel, runStateOf, type WorkItem } from '@renderer/features/task/recordModel'
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

  it('never promotes a serialized payload answer to the result', () => {
    const payload =
      '{"isNewTopic":false,"title":null,"steps":[{"kind":"output","value":"Hi! What do you need?","tool_calls":[]}],"execute_report":""}'
    const items = [user('Say hi', 0), said(payload, 1)]
    const [r] = buildRecordModel(items, { running: false }).runs
    // No result: the history title and Result row fall back to the brief…
    expect(r!.result).toBeNull()
    // …and the payload is still a visible note in the work list.
    expect(r!.after.map((w) => w.kind)).toEqual(['note'])
    const [note] = r!.after
    expect(note!.kind === 'note' ? note.text : null).toBe(payload)
  })

  it('fails a step whose own instance work failed, even when the todo says done', () => {
    const items = [
      user('Fan the work out', 0),
      todos([['a', '~', 'Spawn the children']], 1),
      tool('spawn_agent_instance', { name: 'a' }, 'spawned', 2),
      tool('await_agent_instance', { instanceId: 'a' }, 'Cancelled', 20, 'fail'),
      todos([['a', 'x', 'Spawn the children']], 30)
    ]
    const options = { running: false, failed: false }
    const [r] = buildRecordModel(items, options).runs
    expect(r!.steps[0]!.state).toBe('failed')
    expect(r!.steps[0]!.work.map((w) => w.kind)).toEqual(['instance', 'instance'])
    expect(runStateOf(r!, true, options)).toBe('failed')
  })

  it('does not fail a step whose only failure is a non-instance tool', () => {
    const items = [
      user('Fix it', 0),
      todos([['a', '~', 'Run the suite']], 1),
      tool('terminal', { command: 'pnpm vitest run' }, 'cwd: /ws\nexit_code: 1', 2, 'fail'),
      todos([['a', 'x', 'Run the suite']], 3)
    ]
    const options = { running: false, failed: false }
    const [r] = buildRecordModel(items, options).runs
    expect(r!.steps[0]!.state).toBe('done')
    expect(runStateOf(r!, true, options)).toBe('done')
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

  it('prefers the live todos.json for the latest run while it is in flight, when it is newer', () => {
    const items = [user('Do it', 0), todos([['a', '~', 'One'], ['b', ' ', 'Two']], 1)]
    const liveTodos = [
      { id: 'a', content: 'One', status: 'completed' as const },
      { id: 'b', content: 'Two', status: 'in_progress' as const }
    ]
    const [r] = buildRecordModel(items, { running: true, liveTodos, liveTodosUpdatedAt: at(2) }).runs
    expect(r!.steps.map((s) => s.state)).toEqual(['done', 'running'])
    // Its write stamp starts the step it put in progress.
    expect(r!.steps[1]!.startedAt).toBe(T0 + 2_000)
  })

  it('never lets a todos.json poll that lags the items roll a step back', () => {
    const items = [
      user('Do it', 0),
      todos([['a', '~', 'One'], ['b', ' ', 'Two']], 1),
      read('a.ts', 2),
      todos([['a', 'x', 'One'], ['b', '~', 'Two']], 3),
      read('b.ts', 4)
    ]
    // The poll still holds the first write.
    const stale = [
      { id: 'a', content: 'One', status: 'in_progress' as const },
      { id: 'b', content: 'Two', status: 'pending' as const }
    ]
    for (const liveTodosUpdatedAt of [at(1), null]) {
      const [r] = buildRecordModel(items, { running: true, liveTodos: stale, liveTodosUpdatedAt }).runs
      expect(r!.steps.map((s) => s.state)).toEqual(['done', 'running'])
      expect(r!.steps[1]!.work.map((w) => w.kind)).toEqual(['explore'])
    }
  })

  it('never adds steps from todos.json that this run did not name', () => {
    // create_plan merged into a list still holding run 1's leftovers.
    const plan = tool('create_plan', { title: 'P', plan: '# P', todos: [{ id: 'n1', content: 'New', status: 'in_progress' }] }, 'Wrote plan.md', 11)
    const items = [user('First', 0), todos([['old', ' ', 'Old leftover']], 1), said('Done.', 2), user('Next', 10), plan]
    const { runs } = buildRecordModel(items, {
      running: true,
      liveTodos: [
        { id: 'old', content: 'Old leftover', status: 'pending' },
        { id: 'n1', content: 'New', status: 'in_progress' }
      ],
      liveTodosUpdatedAt: at(12)
    })
    expect(runs[1]!.steps.map((s) => s.title)).toEqual(['New'])
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

describe('the record keeps work where and when it happened', () => {
  const explored = (w: WorkItem | undefined): string[] =>
    w?.kind === 'explore' ? w.tools.map((t) => (JSON.parse(t.tool.argsPreview ?? '{}') as { path?: string }).path ?? '') : []

  it('keeps a replaced plan step, and the work done under it', () => {
    const items = [
      user('Go', 0),
      todos([['a', '~', 'Old step']], 1),
      read('a.ts', 2),
      read('b.ts', 3),
      todos([['n1', '~', 'New step']], 4),
      read('c.ts', 5)
    ]
    const [r] = buildRecordModel(items, { running: false }).runs
    expect(r!.steps.map((s) => [s.title, s.state, Boolean(s.superseded), s.n])).toEqual([
      ['Old step', 'stopped', true, 0],
      ['New step', 'stopped', false, 1]
    ])
    expect(explored(r!.steps[0]!.work[0])).toEqual(['a.ts', 'b.ts'])
    expect(explored(r!.steps[1]!.work[0])).toEqual(['c.ts'])
    // A replaced step alone does not make the run read as stopped.
    expect(runStateOf({ ...r!, steps: [r!.steps[0]!] }, false, { running: false })).toBe('done')
  })

  it('keeps work done between two steps after the one that settled, not inside it', () => {
    const items = [
      user('Go', 0),
      todos([['a', '~', 'A'], ['b', ' ', 'B']], 1),
      read('a.ts', 2),
      todos([['a', 'x', 'A'], ['b', ' ', 'B']], 3),
      read('between.ts', 4),
      todos([['a', 'x', 'A'], ['b', '~', 'B']], 5),
      read('b.ts', 6)
    ]
    const live = buildRecordModel(items.slice(0, 5), { running: true }).runs[0]!
    expect(live.tail).toEqual({ kind: 'between', key: 'a' })
    const [r] = buildRecordModel(items, { running: false }).runs
    expect(r!.steps[0]!.work.map(explored)).toEqual([['a.ts']])
    expect(r!.steps[0]!.between.map(explored)).toEqual([['between.ts']])
    expect(r!.steps[1]!.work.map(explored)).toEqual([['b.ts']])
  })

  it('files calls the loop ran after a todo_write it ran first under the step that write started', () => {
    // The model listed read x before its todo_write; the loop ran the write first.
    const readX = { ...(read('x.ts', 11) as Extract<UiItem, { kind: 'tool' }>) }
    const write = todos([['a', 'x', 'A'], ['b', '~', 'B']], 10)
    const items = [user('Go', 0), todos([['a', '~', 'A'], ['b', ' ', 'B']], 1), read('a.ts', 2), readX, write]
    const [r] = buildRecordModel(items, { running: false }).runs
    expect(r!.steps[0]!.work.map(explored)).toEqual([['a.ts']])
    expect(r!.steps[1]!.work.map(explored)).toEqual([['x.ts']])
  })

  it('names the step a never-started snapshot marks done as the one the work served', () => {
    // Every snapshot without an in-progress mark: a model that skips it, or a
    // transcript an older run end rewrote.
    const items = [
      user('Go', 0),
      read('context.ts', 1),
      todos([['a', ' ', 'A'], ['b', ' ', 'B']], 2),
      read('a.ts', 3),
      todos([['a', 'x', 'A'], ['b', ' ', 'B']], 4),
      read('b.ts', 5),
      todos([['a', 'x', 'A'], ['b', 'x', 'B']], 6)
    ]
    const [r] = buildRecordModel(items, { running: false }).runs
    expect(r!.setup.map(explored)).toEqual([['context.ts']])
    expect(r!.steps[0]!.work.map(explored)).toEqual([['a.ts']])
    expect(r!.steps[1]!.work.map(explored)).toEqual([['b.ts']])
    expect(r!.steps[1]!.startedAt).toBe(T0 + 4_000)
  })

  it('reads a step started and set back to pending by a run that is over as stopped, not queued', () => {
    const items = [user('Go', 0), todos([['a', '~', 'A']], 1), read('a.ts', 2), todos([['a', ' ', 'A']], 3)]
    const [r] = buildRecordModel(items, { running: false }).runs
    expect(r!.steps[0]!.state).toBe('stopped')
    // Its time ends with its last work, not blank.
    expect(r!.steps[0]!.endedAt).toBe(T0 + 2_000)
  })

  it('keeps the closing answer whatever reasoning followed it, with thinking shown or not', () => {
    const items = [user('Go', 0), read('a.ts', 1), said('Here is the answer.', 2), said('', 3, { thinking: 'Nothing left to do.' })]
    for (const showThinking of [true, false]) {
      const [r] = buildRecordModel(items, { running: false, showThinking }).runs
      expect(r!.result?.text).toBe('Here is the answer.')
    }
  })

  it('carries the plan across a follow-up sent mid-turn', () => {
    const steer: UiItem = { ...(user('Also cover the docs', 3) as Extract<UiItem, { kind: 'message' }>), midTurn: true }
    const items = [user('Go', 0), todos([['a', 'x', 'A'], ['b', '~', 'B']], 1), read('b1.ts', 2), steer, read('b2.ts', 4)]
    const { runs } = buildRecordModel(items, { running: true })
    expect(runs).toHaveLength(2)
    expect(runs[0]!.continued).toBe(true)
    expect(runs[0]!.steps.map((s) => s.state)).toEqual(['done', 'paused'])
    expect(runs[0]!.result).toBeNull()
    expect(runStateOf(runs[0]!, false, { running: true })).toBe('done')
    expect(runs[1]!.steps.map((s) => s.state)).toEqual(['done', 'running'])
    expect(runs[1]!.steps[1]!.work.map(explored)).toEqual([['b2.ts']])
    // The step's clock still runs from when it first started.
    expect(runs[1]!.steps[1]!.startedAt).toBe(T0 + 1_000)
  })

  it('keys a create_plan step as todos.json does, and merges a second plan into the first', () => {
    const plan = (todosArg: unknown[], s: number) => tool('create_plan', { title: 'P', plan: '# P', todos: todosArg }, 'Wrote plan.md', s)
    const items = [
      user('Go', 0),
      plan([{ id: 'step 1', content: 'A', status: 'in_progress' }, { id: 'step 2', content: 'B', status: 'pending' }], 1),
      read('a.ts', 2),
      plan([{ id: 'step 3', content: 'C', status: 'pending' }], 3)
    ]
    const live = [
      { id: 'step1', content: 'A', status: 'in_progress' as const },
      { id: 'step2', content: 'B', status: 'pending' as const },
      { id: 'step3', content: 'C', status: 'pending' as const }
    ]
    const [r] = buildRecordModel(items, { running: true, liveTodos: live, liveTodosUpdatedAt: at(4) }).runs
    expect(r!.steps.map((s) => [s.key, s.title])).toEqual([
      ['step1', 'A'],
      ['step2', 'B'],
      ['step3', 'C']
    ])
    // The second plan was written while step 1 was in progress.
    expect(r!.steps[0]!.work.map((w) => w.kind)).toEqual(['explore', 'plan'])
    expect(r!.steps[0]!.work.map(explored)[0]).toEqual(['a.ts'])
  })

  it('ends a run at its last call’s end, and starts a queued follow-up when it was taken up', () => {
    const slow: UiItem = { ...(run('pnpm test', 1) as Extract<UiItem, { kind: 'tool' }>), endedAt: at(90) }
    const items = [user('Go', 0), slow, user('Queued while it ran', 30), said('Ok.', 95)]
    const { runs } = buildRecordModel(items, { running: false })
    expect(runs[0]!.endedAt).toBe(T0 + 90_000)
    expect(runs[1]!.at).toBe(T0 + 30_000)
    expect(runs[1]!.startedAt).toBe(T0 + 90_000)
  })

  it('does not draw a command until it knows whether it changes things', () => {
    const streaming: UiItem = {
      kind: 'tool',
      id: 'call_t',
      tool: { id: 'call_t', name: 'terminal', summary: '', status: 'running', argsPreview: '{"command":"cat src/a' }
    }
    const [r] = buildRecordModel([user('Go', 0), streaming], { running: true }).runs
    expect(r!.after).toEqual([])
    const withCommand = (command: string): UiItem =>
      ({ ...streaming, tool: { ...streaming.tool, argsPreview: JSON.stringify({ command }) } }) as UiItem
    const kinds = (item: UiItem) => buildRecordModel([user('Go', 0), item], { running: true }).runs[0]!.after.map((w) => w.kind)
    // Once known, it is drawn once, as what it is: a read is a lookup line, a build a card.
    expect(kinds(withCommand('cat src/a.ts'))).toEqual(['explore'])
    expect(kinds(withCommand('pnpm build'))).toEqual(['card'])
  })

  it('keys a row by its first id, so a provider id replacing a placeholder keeps its view', () => {
    const renamed: UiItem = { ...(run('pnpm build', 1) as Extract<UiItem, { kind: 'tool' }>), id: 'toolu_real', key: 'pending_0' }
    const [r] = buildRecordModel([user('Go', 0), renamed], { running: false }).runs
    expect(r!.after.map((w) => w.id)).toEqual(['pending_0'])
  })
})
