/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { answerShaped, buildRecordModel, type BuildOptions, type RecordStep } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { detailOf } from '@renderer/features/task/record/WorkFold'

/**
 * Run 4db57774 (2026-10-07), in shape: two children spawned before any list
 * (one naming its step, one not), then a list setting two steps in progress
 * together, then a child whose args reached the record malformed (main read
 * its step all the same), a spawn main refused, and its retry. The record left
 * the first two outside every step, filed the malformed one under step 1, and
 * failed step 2 for the refused spawn.
 */

afterEach(cleanup)

const T0 = Date.parse('2026-10-07T14:04:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

let seq = 0
const nextId = (p: string): string => `${p}-${++seq}`

const RUN = {
  a: 'b80fe6a5-ac1a-4e42-b589-ddcd6fdc15c1',
  b: '31a601e7-96b7-462a-9b8e-299b440077c4',
  c: 'cfa92b86-8d70-4ca9-badc-7857d2d7e2f7',
  d: 'd7d1a374-bc09-4059-aff1-421d086d5fed'
}

function tool(name: string, argsPreview: string, content: string, s: number, status: 'done' | 'fail' = 'done'): UiItem {
  return {
    kind: 'tool',
    id: nextId('t'),
    at: at(s),
    endedAt: at(s + 1),
    tool: { id: nextId('call'), name, summary: '', status, content, argsPreview }
  }
}

const spawned = (runId: string): string => `Agent V Instance id; ${runId} (short ${runId.slice(0, 8)})\nrun_id: ${runId}`
const spawnArgs = (outcome: string, stepId?: string): string =>
  JSON.stringify({ goal: 'Repo: the shared background', outcome, sub_tasks: ['do it'], done_when: 'done', ...(stepId ? { step_id: stepId } : {}) })

const TITLES = ['Analyze the loop', 'Analyze the tools', 'Analyze the renderer', 'Audit the docs']

/** A todo_write that sets the first `going` steps in progress together. */
function list(going: number, s: number): UiItem {
  const todos = TITLES.map((content, i) => ({ id: `s${i + 1}`, content, status: i < going ? 'in_progress' : 'pending' }))
  const body = ['0/4 complete', ...todos.map((t) => `[${t.status === 'in_progress' ? '~' : ' '}] (${t.id}) ${t.content}`)].join('\n')
  return tool('todo_write', JSON.stringify({ todos }), body, s)
}

const items: UiItem[] = [
  { kind: 'message', id: 'user-0', role: 'user', content: 'Analyze the code base', at: at(0) },
  tool('spawn_agent_instance', spawnArgs('The loop', 's1'), spawned(RUN.a), 10),
  tool('spawn_agent_instance', spawnArgs('The tools'), spawned(RUN.b), 11),
  list(2, 20),
  // Cut before its end, as the stored args were: no step_id the parser can read.
  tool('spawn_agent_instance', '{"goal": "Repo: the shared background", "outcome": "The renderer", "sub_tasks": ', spawned(RUN.c), 30),
  // Refused by main; the step it named is still there in so many words.
  tool('spawn_agent_instance', '{"done_when": "x", "read_only": true, "step_id": "s4", "goal', 'goal: Required; outcome: Required', 40, 'fail'),
  tool('spawn_agent_instance', spawnArgs('The docs', 's4'), spawned(RUN.d), 41)
]

const instances: BuildOptions['instances'] = {
  [RUN.a]: { phase: 'started', stepId: 's1' },
  [RUN.b]: { phase: 'started' },
  [RUN.c]: { phase: 'started', stepId: 's3' },
  [RUN.d]: { phase: 'started', stepId: 's4' }
}

const childrenOf = (step: RecordStep): string[] =>
  step.work.flatMap((w) => (w.kind === 'instance' && w.tool.tool.name === 'spawn_agent_instance' ? [w.tool.tool.content ?? ''] : []))

describe('children filed under the steps they serve', () => {
  const live: BuildOptions = { running: true, instances }
  const run = buildRecordModel(items, live).runs[0]!
  const step = (n: number): RecordStep => run.steps.find((s) => s.n === n)!

  it('files a child spawned before the list under the step it named, and one naming none under the next step set going', () => {
    expect(childrenOf(step(1)).join()).toContain(RUN.a)
    expect(childrenOf(step(2)).join()).toContain(RUN.b)
    expect(run.setup.some((w) => w.kind === 'instance')).toBe(false)
  })

  it('reads the step main read when the args preview does not parse', () => {
    expect(childrenOf(step(3)).join()).toContain(RUN.c)
    expect(childrenOf(step(1)).join()).not.toContain(RUN.c)
  })

  it('files a refused spawn under the step it named, without failing that step', () => {
    expect(step(4).work.filter((w) => w.kind === 'instance')).toHaveLength(2)
    expect(step(4).state).toBe('running')
  })

  it('reads a stopped fan-out as stopped: a wait that ran out, or one the Stop cut off, is not a failure', () => {
    const timedOut = (runId: string, s: number): UiItem =>
      tool('await_agent_instance', JSON.stringify({ run_id: runId }), `Timed out waiting for Agent V Instance id; ${runId} after 900000 ms. Child is still running.`, s, 'fail')
    const cut = (runId: string, s: number): UiItem => tool('await_agent_instance', JSON.stringify({ run_id: runId }), 'Cancelled', s, 'fail')
    const stopped: UiItem[] = [...items, timedOut(RUN.a, 50), cut(RUN.a, 60)]
    const cancelled: BuildOptions['instances'] = Object.fromEntries(
      Object.entries(instances!).map(([id, facts]) => [id, { ...facts, phase: 'cancelled' as const }])
    )
    const options: BuildOptions = { running: false, stopped: true, instances: cancelled }
    const done = buildRecordModel(stopped, options).runs[0]!
    expect(done.steps.find((s) => s.n === 1)!.state).toBe('stopped')
    // The receipt says how many stopped together, not "at step 1".
    const { container } = render(<TaskRecord model={buildRecordModel(stopped, options)} options={options} messageCount={1} />)
    expect(container.textContent).toContain('4 of 4 steps unfinished')
    expect(container.textContent).not.toContain('at step 1 of 4')
  })

  it('files a child spawned in the same step as the list by the step it names', () => {
    // Listed before the write, but the loop ran the write first.
    const spawn = tool('spawn_agent_instance', spawnArgs('The tools', 's2'), spawned(RUN.b), 21)
    const together: UiItem[] = [items[0]!, spawn, list(1, 20)]
    const one = buildRecordModel(together, { running: true, instances: { [RUN.b]: { phase: 'started' } } }).runs[0]!
    expect(childrenOf(one.steps.find((s) => s.n === 2)!).join()).toContain(RUN.b)
    expect(childrenOf(one.steps.find((s) => s.n === 1)!)).toEqual([])
  })

  it('files two children spawned before the list under the one step both name', () => {
    const retry: UiItem[] = [
      items[0]!,
      tool('spawn_agent_instance', spawnArgs('The loop', 's1'), spawned(RUN.a), 10),
      tool('spawn_agent_instance', spawnArgs('The loop', 's1'), spawned(RUN.b), 11),
      list(1, 20)
    ]
    const one = buildRecordModel(retry, { running: true }).runs[0]!
    expect(childrenOf(one.steps.find((s) => s.n === 1)!)).toHaveLength(2)
    expect(one.setup.some((w) => w.kind === 'instance')).toBe(false)
  })

  it('says how many steps run side by side, not only the first', () => {
    expect(run.steps.map((s) => s.state)).toEqual(['running', 'running', 'running', 'running'])
    expect(detailOf(run, true)).toBe('4 of 4 steps running')
  })
})

describe('the answer, while it is being written', () => {
  const answer = [
    '## What I found',
    '',
    'The loop parks on approvals and resumes from its checkpoint.',
    '',
    '- `loop.ts` drives each step',
    '- `executeStepTools.ts` runs the calls',
    '',
    'Every claim above is from a file read in this run.'
  ].join('\n')
  const writing = (content: string, streaming = true): UiItem[] => [
    { kind: 'message', id: 'user-0', role: 'user', content: 'Explain the loop', at: at(0) },
    tool('read', JSON.stringify({ path: 'src/main/agent/loop.ts' }), 'x', 2),
    { kind: 'message', id: 'a-2', role: 'assistant', content, at: at(10), ...(streaming ? { streaming: true } : {}) }
  ]
  const show = (list: UiItem[]) => {
    const options = { running: true }
    return render(<TaskRecord model={buildRecordModel(list, options)} options={options} messageCount={3} />)
  }

  it('moves to the Result as it streams, and the work folds behind “Writing the answer”', () => {
    const { container } = show(writing(answer))
    expect(container.querySelector('section[aria-label="Result"]')?.textContent).toContain('What I found')
    const line = container.querySelector<HTMLElement>('[data-work-fold] > div > button')!
    expect(container.querySelector('[data-work-fold]')?.getAttribute('data-work-fold')).toBe('writing')
    expect(line.textContent).toContain('Writing the answer')
    expect(line.getAttribute('aria-expanded')).toBe('false')
  })

  it('leaves a line of narration in the work', () => {
    const { container } = show(writing('Let me read the scheduler next, then the checkpoint code.'))
    expect(container.querySelector('section[aria-label="Result"]')).toBeNull()
    expect(container.querySelector('[data-work-fold]')?.getAttribute('data-work-fold')).toBe('working')
  })

  it('puts the words back in the work once a call follows them', () => {
    const list = [...writing(answer, false), tool('read', JSON.stringify({ path: 'src/main/x.ts' }), 'x', 20)]
    const run = buildRecordModel(list, { running: true }).runs[0]!
    expect(run.result).toBeNull()
  })

  it('reads structure or several paragraphs as an answer, a sentence as narration', () => {
    expect(answerShaped(answer)).toBe(true)
    expect(answerShaped('Let me check the config and then the tests before I write anything up for you here.')).toBe(false)
    // Where it will look next is a list too, but not a reply's worth.
    const plan = "I'll look at three places before writing anything up:\n- the checkpoint code in loop.ts\n- the scheduler in executeStepTools.ts\n- the tools barrel"
    expect(answerShaped(plan)).toBe(false)
  })

  it('keeps the answer in the Result while the agent reasons after it', () => {
    const thought: UiItem = { kind: 'message', id: 'a-3', role: 'assistant', content: '', thinking: 'Anything left to check?', at: at(12) }
    const run = buildRecordModel([...writing(answer, false), thought], { running: true }).runs[0]!
    expect(run.result?.text).toContain('What I found')
  })
})

describe('a plan the agent could not write', () => {
  it('says so, with why, and offers no plan to open', () => {
    const list: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'Plan it', at: at(0) },
      tool('create_plan', '{"plan": "# A plan', 'Arguments for create_plan must be one complete JSON object — resend them.', 2, 'fail')
    ]
    const options = { running: true }
    const { container } = render(<TaskRecord model={buildRecordModel(list, options)} options={options} messageCount={2} />)
    const row = container.querySelector('[data-record-plan="failed"]')!
    expect(row.textContent).toContain('Plan not written')
    expect(row.textContent).toContain('must be one complete JSON object')
    expect(container.textContent).not.toContain('Wrote the plan')
  })

  it('says one stopped with the run, or denied, ended so — not that it wrote one, nor that it failed', () => {
    for (const [content, word] of [
      ['Interrupted', 'Interrupted'],
      ['The user denied permission to run create_plan.', 'Denied']
    ] as const) {
      const list: UiItem[] = [
        { kind: 'message', id: 'user-0', role: 'user', content: 'Plan it', at: at(0) },
        tool('create_plan', '{"plan": "# A plan', content, 2, 'fail')
      ]
      const options = { running: false }
      const view = render(<TaskRecord model={buildRecordModel(list, options)} options={options} messageCount={2} />)
      fireEvent.click(view.container.querySelector<HTMLElement>('[data-work-fold] > div > button')!)
      expect(view.container.textContent).toContain('Writing the plan')
      expect(view.container.textContent).toContain(word)
      expect(view.container.textContent).not.toContain('Wrote the plan')
      expect(view.container.querySelector('[data-record-plan="failed"]')).toBeNull()
      view.unmount()
    }
  })
})

describe('step counts', () => {
  const MARK: Record<string, string> = { completed: 'x', in_progress: '~' }
  const todo =(todos: { id: string; status: string }[], s: number): UiItem =>
    tool(
      'todo_write',
      JSON.stringify({ todos: todos.map((t) => ({ ...t, content: TITLES[Number(t.id.slice(1)) - 1] })) }),
      [
        `${todos.filter((t) => t.status === 'completed').length}/${todos.length} complete`,
        ...todos.map((t) => `[${MARK[t.status] ?? ' '}] (${t.id}) ${TITLES[Number(t.id.slice(1)) - 1]}`)
      ].join('\n'),
      s
    )

  it('counts the steps never started among the unfinished when several stopped together', () => {
    const list: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'Do it', at: at(0) },
      todo(
        [
          { id: 's1', status: 'in_progress' },
          { id: 's2', status: 'in_progress' },
          { id: 's3', status: 'pending' }
        ],
        1
      ),
      tool('read', JSON.stringify({ path: 'a.ts' }), 'Interrupted', 2, 'fail')
    ]
    const options: BuildOptions = { running: false, stopped: true }
    const { container } = render(<TaskRecord model={buildRecordModel(list, options)} options={options} messageCount={1} />)
    expect(container.textContent).toContain('3 of 3 steps unfinished')
  })

  it('counts a run’s plan in History as its work line does, without the steps it replaced', () => {
    const list: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'Do it', at: at(0) },
      todo(
        [
          { id: 's1', status: 'pending' },
          { id: 's2', status: 'in_progress' }
        ],
        1
      ),
      tool('read', JSON.stringify({ path: 'a.ts' }), 'x', 2),
      // s2 gives way to s3 after work under it: replaced, not part of the plan.
      todo(
        [
          { id: 's1', status: 'completed' },
          { id: 's3', status: 'completed' }
        ],
        4
      ),
      { kind: 'message', id: 'a-5', role: 'assistant', content: 'Done.', at: at(5) },
      { kind: 'message', id: 'user-6', role: 'user', content: 'And again', at: at(10) }
    ]
    const model = buildRecordModel(list, { running: false })
    expect(model.runs[0]!.steps.filter((s) => s.n === 0)).toHaveLength(1)
    const { container } = render(<TaskRecord model={model} options={{ running: false }} messageCount={3} />)
    expect(container.textContent).toContain('2 steps')
    expect(container.textContent).not.toContain('3 steps')
  })
})

describe('a run asked for again', () => {
  it('starts with its steps folded, whatever was open in the last one', () => {
    const run = (sentAt: number): UiItem[] => [
      { kind: 'message', id: 'user-0', role: 'user', content: 'Do it', at: at(sentAt) },
      list(1, sentAt + 1),
      tool('read', JSON.stringify({ path: 'a.ts' }), 'x', sentAt + 2),
      tool('todo_write', JSON.stringify({ todos: [{ id: 's1', content: TITLES[0], status: 'completed' }] }), '1/1 complete\n[x] (s1) Analyze the loop', sentAt + 3),
      { kind: 'message', id: 'a-9', role: 'assistant', content: 'Done.', at: at(sentAt + 4) }
    ]
    const options = { running: false }
    const view = render(<TaskRecord model={buildRecordModel(run(0), options)} options={options} messageCount={5} />)
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-work-fold] > div > button')!)
    const stepToggle = (): HTMLElement => view.container.querySelector<HTMLElement>('[data-step="1"] button[aria-expanded]')!
    fireEvent.click(stepToggle())
    expect(stepToggle().getAttribute('aria-expanded')).toBe('true')
    // The same brief, sent again later: a new run under the same id.
    view.rerender(<TaskRecord model={buildRecordModel(run(100), options)} options={options} messageCount={5} />)
    expect(view.container.querySelector('[data-work-fold] > div > button')?.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(view.container.querySelector<HTMLElement>('[data-work-fold] > div > button')!)
    expect(stepToggle().getAttribute('aria-expanded')).toBe('false')
  })
})
