import { describe, expect, it } from 'vitest'
import type { UiItem } from '@shared/transcript'
import { buildRecordModel, type BuildOptions, type RecordStep } from '@renderer/features/task/recordModel'

/**
 * Run dd5aafe0 (2026-09-28), in shape: a plan that set three steps in
 * progress together, one child spawned for each with no step named, the
 * awaits in one step, and a closing todo_write that named only the last step.
 * The record filed all three children under the first step, drew the other
 * two as running with nothing in them, and — once the run ended — dropped
 * every step but the last.
 */

const T0 = Date.parse('2026-09-28T09:48:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

let seq = 0
const nextId = (p: string): string => `${p}-${++seq}`

const RUN = {
  a: '7368760e-fa2c-4c57-8283-3b41e0a421db',
  b: '6c7bfd8f-0352-451a-b471-8246ef9aa7c0',
  c: 'd88605b2-274d-4960-bd03-18f13617ad85'
}

function tool(
  name: string,
  args: Record<string, unknown>,
  content: string,
  s: number,
  end: number = s,
  status: 'done' | 'running' | 'fail' = 'done'
): UiItem {
  return {
    kind: 'tool',
    id: nextId('t'),
    at: at(s),
    ...(status === 'running' ? {} : { endedAt: at(end) }),
    tool: { id: nextId('call'), name, summary: '', status, content, argsPreview: JSON.stringify(args) }
  }
}

function todos(items: Array<[string, ' ' | '~' | 'x' | '-', string]>, s: number): UiItem {
  const done = items.filter(([, m]) => m === 'x').length
  const body = [`${done}/${items.length} complete`, ...items.map(([i, m, t]) => `[${m}] (${i}) ${t}`)].join('\n')
  return tool('todo_write', {}, body, s)
}

const spawned = (runId: string): string => `Agent V Instance id; ${runId} (short ${runId.slice(0, 8)})\nrun_id: ${runId}`
const spawn = (runId: string, goal: string, s: number, stepId?: string): UiItem =>
  tool(
    'spawn_agent_instance',
    { goal, outcome: goal, sub_tasks: ['do it'], done_when: 'done', ...(stepId ? { step_id: stepId } : {}) },
    spawned(runId),
    s,
    s + 8
  )
const awaited = (runId: string, s: number, end: number | null, report = '# Report'): UiItem =>
  end == null
    ? tool('await_agent_instance', { run_id: runId }, '', s, s, 'running')
    : tool('await_agent_instance', { run_id: runId }, `Agent V Instance id; ${runId}\nphase: done\n\n${report}`, s, end)

const TITLES = {
  s1: 'Inspect root: README, package.json, layout',
  s2: 'Child A: map src/main subsystems',
  s3: 'Child B: map renderer/preload/shared',
  s4: 'Child C: map tests/scripts/docs + scale',
  s5: "Verify children's claims, synthesize final answer"
}

function plan(s: number): UiItem {
  return tool(
    'create_plan',
    {
      title: 'Analyze codebase',
      plan: '# Analyze codebase',
      todos: [
        { id: 's1', content: TITLES.s1, status: 'completed' },
        { id: 's2', content: TITLES.s2, status: 'in_progress' },
        { id: 's3', content: TITLES.s3, status: 'in_progress' },
        { id: 's4', content: TITLES.s4, status: 'in_progress' },
        { id: 's5', content: TITLES.s5, status: 'pending' }
      ]
    },
    // Written before create_plan echoed the list it kept.
    'Wrote plan.md under `# Analyze codebase`.',
    s
  )
}

const user: UiItem = { kind: 'message', id: 'u-1', role: 'user', content: 'analyze the codebase and tell me what it is', at: at(0) }

function liveItems(): UiItem[] {
  return [
    user,
    plan(56),
    spawn(RUN.a, 'Map src/main', 84),
    spawn(RUN.b, 'Map the renderer', 84),
    spawn(RUN.c, 'Map the tests', 84),
    awaited(RUN.a, 111, null),
    awaited(RUN.b, 111, null),
    awaited(RUN.c, 111, 218)
  ]
}

function finishedItems(): UiItem[] {
  return [
    user,
    plan(56),
    spawn(RUN.a, 'Map src/main', 84),
    spawn(RUN.b, 'Map the renderer', 84),
    spawn(RUN.c, 'Map the tests', 84),
    awaited(RUN.a, 111, 351),
    awaited(RUN.b, 111, 417),
    awaited(RUN.c, 111, 218),
    tool('grep', { pattern: 'runAgent' }, 'src/main/agent/loop.ts:1051', 426),
    todos(
      [
        ['s1', 'x', TITLES.s1],
        ['s2', 'x', TITLES.s2],
        ['s3', 'x', TITLES.s3],
        ['s4', 'x', TITLES.s4],
        ['s5', '~', TITLES.s5]
      ],
      468
    ),
    // The closing write named only s5, and main (then) replaced the list with it.
    todos([['s5', 'x', TITLES.s5]], 478),
    { kind: 'message', id: 'a-1', role: 'assistant', content: 'Vyotiq is an Electron coding agent.', at: at(490) }
  ]
}

const spawnsIn = (step: RecordStep): string[] =>
  step.work.flatMap((w) =>
    w.kind === 'instance' ? [`${w.tool.tool.name === 'spawn_agent_instance' ? 'spawn' : 'await'}:${w.tool.tool.content?.match(/Instance id; (\w{8})/)?.[1] ?? JSON.parse(w.tool.tool.argsPreview ?? '{}').run_id?.slice(0, 8)}`] : []
  )

describe('a fan-out plan in the record', () => {
  it('files each child, and its await, under the step it was spawned for', () => {
    const options: BuildOptions = {
      running: true,
      instances: {
        [RUN.a]: { phase: 'started', startedAt: at(92) },
        [RUN.b]: { phase: 'started', startedAt: at(92) },
        [RUN.c]: { phase: 'done', startedAt: at(92), endedAt: at(218) }
      }
    }
    const [r] = buildRecordModel(liveItems(), options).runs
    const byKey = new Map(r!.steps.map((s) => [s.key, s]))
    expect(spawnsIn(byKey.get('s2')!)).toEqual(['spawn:7368760e', 'await:7368760e'])
    expect(spawnsIn(byKey.get('s3')!)).toEqual(['spawn:6c7bfd8f', 'await:6c7bfd8f'])
    expect(spawnsIn(byKey.get('s4')!)).toEqual(['spawn:d88605b2', 'await:d88605b2'])
  })

  it('runs a step while its child runs, and ends it when the child ends — not when the model ticks it', () => {
    const options: BuildOptions = {
      running: true,
      instances: {
        [RUN.a]: { phase: 'started', startedAt: at(92) },
        [RUN.b]: { phase: 'started', startedAt: at(92) },
        [RUN.c]: { phase: 'done', startedAt: at(92), endedAt: at(218) }
      }
    }
    const [r] = buildRecordModel(liveItems(), options).runs
    const state = Object.fromEntries(r!.steps.map((s) => [s.key, s.state]))
    // Main kept one todo in progress (s4) and demoted s2 and s3: their children
    // run all the same, so they read as running.
    expect(state).toMatchObject({ s1: 'done', s2: 'running', s3: 'running', s5: 'queued' })
    // Child C finished while its todo was still the one in progress: the parent
    // is still on it, so it stays running.
    expect(state.s4).toBe('running')
    const s2 = r!.steps.find((s) => s.key === 's2')!
    expect(s2.startedAt).toBe(T0 + 84_000)
    expect(s2.endedAt).toBeNull()
  })

  it('keeps every step once the run has ended, each with its own time', () => {
    const [r] = buildRecordModel(finishedItems(), { running: false }).runs
    expect(r!.steps.map((s) => [s.key, s.n, s.state, Boolean(s.superseded)])).toEqual([
      ['s1', 1, 'done', false],
      ['s2', 2, 'done', false],
      ['s3', 3, 'done', false],
      ['s4', 4, 'done', false],
      ['s5', 5, 'done', false]
    ])
    const time = (key: string): number | null => {
      const s = r!.steps.find((x) => x.key === key)!
      return s.startedAt != null && s.endedAt != null ? (s.endedAt - s.startedAt) / 1000 : null
    }
    // Each ends when its own work did (A's await at 351 s, B's at 417 s), not
    // at the one todo_write that ticked them all off at 468 s.
    expect(time('s2')).toBe(351 - 84)
    expect(time('s3')).toBe(417 - 84)
    expect(r!.result?.text).toBe('Vyotiq is an Electron coding agent.')
  })

  it('files a spawn under the step it names', () => {
    const items: UiItem[] = [
      user,
      todos(
        [
          ['s1', '~', 'Plan'],
          ['s2', ' ', 'Child work']
        ],
        5
      ),
      spawn(RUN.a, 'Do the child work', 10, 's2'),
      awaited(RUN.a, 20, null)
    ]
    const [r] = buildRecordModel(items, { running: true, instances: { [RUN.a]: { phase: 'started', startedAt: at(18) } } }).runs
    const [s1, s2] = r!.steps
    expect(spawnsIn(s1!)).toEqual([])
    expect(spawnsIn(s2!)).toEqual(['spawn:7368760e', 'await:7368760e'])
    expect(s2!.state).toBe('running')
  })

  it('fails the step whose child failed, not the step the spawns were made from', () => {
    const items: UiItem[] = [
      user,
      plan(56),
      spawn(RUN.a, 'Map src/main', 84),
      spawn(RUN.b, 'Map the renderer', 84),
      spawn(RUN.c, 'Map the tests', 84),
      tool('await_agent_instance', { run_id: RUN.b }, `Agent V Instance id; ${RUN.b}\nphase: error\n\nCrashed.`, 111, 200, 'fail')
    ]
    const [r] = buildRecordModel(items, { running: false }).runs
    const state = Object.fromEntries(r!.steps.map((s) => [s.key, s.state]))
    expect(state.s3).toBe('failed')
    expect(state.s2).not.toBe('failed')
  })

  it('does not fail a step on an await that timed out while its child went on to finish', () => {
    const items: UiItem[] = [
      user,
      todos([['s1', '~', 'Fan out']], 1),
      spawn(RUN.a, 'Work', 2),
      tool('await_agent_instance', { run_id: RUN.a }, `Timed out waiting for Agent V Instance id; ${RUN.a} after 900000 ms. Child is still running.`, 12, 912, 'fail'),
      awaited(RUN.a, 913, 1000),
      todos([['s1', 'x', 'Fan out']], 1001)
    ]
    const [r] = buildRecordModel(items, { running: false }).runs
    expect(r!.steps[0]!.state).toBe('done')
  })
})
