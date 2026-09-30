/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import type { AgentInstanceUiState } from '@shared/utils/agentInstance'
import { buildRecordModel, type BuildOptions, type WorkItem } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { WorkList, groupWork } from '@renderer/features/task/record/WorkItems'
import { stepSummaryText } from '@renderer/features/task/record/Steps'
import { TerminalBody, markedOutput } from '@renderer/features/chat/toolUi/bodies/TerminalBody'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'

const copyText = vi.hoisted(() => vi.fn(async (_text: string) => true))
vi.mock('@renderer/lib/markdown/copyText', () => ({ copyText }))

/**
 * What the record says at a glance, without opening anything: what you
 * answered, which tests passed or failed, what a folded step amounts to, the
 * children a step started, and the result to copy.
 */

afterEach(cleanup)

const T0 = Date.parse('2026-09-30T09:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()
let seq = 0
const id = (p: string): string => `${p}-${++seq}`

const user = (text: string, s: number): UiItem => ({ kind: 'message', id: 'user-0', role: 'user', content: text, at: at(s) })
const said = (text: string, s: number): UiItem => ({ kind: 'message', id: id('a'), role: 'assistant', content: text, at: at(s) })
function tool(name: string, args: Record<string, unknown>, content: string, s: number, summary = ''): UiItem {
  return {
    kind: 'tool',
    id: id('t'),
    at: at(s),
    endedAt: at(s + 1),
    tool: { id: id('c'), name, summary, status: 'done', content, argsPreview: JSON.stringify(args) }
  }
}
function todos(items: Array<[string, ' ' | '~' | 'x', string]>, s: number): UiItem {
  const done = items.filter(([, m]) => m === 'x').length
  const body = [`${done}/${items.length} complete`, ...items.map(([i, m, t]) => `[${m}] (${i}) ${t}`)].join('\n')
  return tool('todo_write', {}, body, s)
}

function show(items: UiItem[], options: BuildOptions = { running: false }) {
  const model = buildRecordModel(items, options)
  const view = render(<TaskRecord model={model} options={options} messageCount={items.length} />)
  return { model, ...view }
}

describe('an answered question', () => {
  it('says what you answered, not only that you did', () => {
    const { container } = show([
      user('Set up the database', 0),
      tool('ask_question', { questions: [{ id: 'db', prompt: 'Which database?', type: 'single', options: ['Postgres', 'SQLite'] }] }, 'User answered: Postgres', 1, 'Which database?'),
      said('Done.', 5)
    ])
    const row = container.querySelector('[data-record-tool="ask_question"]') as HTMLElement
    expect(row.querySelector('[data-record-answer]')?.textContent).toBe('You answered: Postgres')
    // The bare chip is gone: the answer says it.
    expect(within(row).queryByText('Answered')).toBeNull()
  })

  it('lists each answer of a form of several questions', () => {
    const questions = [
      { id: 'db', prompt: 'Which database?', type: 'single', options: ['Postgres'] },
      { id: 'region', prompt: 'Region?', type: 'single', options: ['EU'] }
    ]
    const { container } = show([
      user('Set up the database', 0),
      tool('ask_question', { questions }, 'User answered:\n- Which database?: Postgres\n- Region?: EU', 1, 'Setup'),
      said('Done.', 5)
    ])
    const answer = container.querySelector('[data-record-answer]') as HTMLElement
    expect(answer.textContent).toContain('You answered')
    expect([...answer.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Which database?: Postgres', 'Region?: EU'])
  })

  it('keeps the chip for a question that was skipped', () => {
    const { container } = show([
      user('Set up the database', 0),
      tool('ask_question', { question: 'Which database?' }, 'Question skipped (autonomous mode)', 1, 'Which database?'),
      said('Done.', 5)
    ])
    const row = container.querySelector('[data-record-tool="ask_question"]') as HTMLElement
    expect(row.querySelector('[data-record-answer]')).toBeNull()
    expect(row.textContent).toContain('Skipped')
  })
})

describe('test output in a command card', () => {
  const output = ['RUN v3', ' ✓ login retries once 4ms', ' ✗ login gives up after three 12ms', 'Tests 1 failed | 1 passed'].join('\n')

  it('marks a pass in the success hue and a failure in danger, keeping the glyph', () => {
    const { container } = render(<pre>{markedOutput(output)}</pre>)
    const pass = container.querySelector('[data-output-mark="pass"]') as HTMLElement
    const fail = container.querySelector('[data-output-mark="fail"]') as HTMLElement
    expect(pass.textContent).toBe(' ✓ login retries once 4ms')
    expect(pass.querySelector('.text-success')?.textContent).toBe('✓')
    expect(fail.textContent).toBe(' ✗ login gives up after three 12ms')
    expect(fail.querySelector('.text-danger')?.textContent).toBe('✗')
    // Not one character added or lost.
    expect(container.textContent).toBe(output)
  })

  it('reads vitest’s × as a failure too, and leaves plain output a string', () => {
    const { container } = render(<pre>{markedOutput(' × breaks 3ms')}</pre>)
    expect(container.querySelector('[data-output-mark="fail"]')).not.toBeNull()
    expect(markedOutput('all good\nexit 0')).toBe('all good\nexit 0')
  })

  it('does so in the terminal body the record’s card opens onto', () => {
    const { container } = render(
      <TerminalBody
        tool={{ id: 't', name: 'terminal', summary: '', status: 'done', argsPreview: JSON.stringify({ command: 'pnpm test' }), content: `cwd: /repo\nshell: bash\n---\n${output}` }}
      />
    )
    expect(container.querySelectorAll('[data-output-mark]')).toHaveLength(2)
  })
})

describe('a folded step’s summary', () => {
  const planRun = (): UiItem[] => [
    user('Fix the flaky login test', 0),
    todos([['s1', '~', 'Find and fix the retry']], 1),
    tool('read', { path: 'src/login.ts' }, 'contents', 2, 'src/login.ts'),
    tool('grep', { pattern: 'retry' }, 'src/login.ts:4', 3),
    tool('terminal', { command: 'pnpm vitest run login' }, 'cwd: /ws\nshell: pwsh\nok\nexit_code: 0', 4),
    tool('str_replace', { path: 'src/login.ts', old_string: 'a', new_string: 'b' }, 'Replaced in src/login.ts', 6),
    todos([['s1', 'x', 'Find and fix the retry']], 8),
    said('The retry awaits now.', 9)
  ]

  it('counts lookups and commands, not only edits', () => {
    const { model, container } = show(planRun())
    const step = model.runs[0]!.steps[0]!
    expect(stepSummaryText(step)).toMatch(/^2 lookups · 1 command · 1 file edited/)
    expect(container.querySelector('[data-step="1"]')?.textContent).toContain('2 lookups · 1 command · 1 file edited')
  })

  it('says nothing for a step with no work', () => {
    expect(stepSummaryText({ work: [], edits: null })).toBeNull()
  })
})

type ToolItem = Extract<UiItem, { kind: 'tool' }>
const RUNS = ['5e8249bc-1111-2222-3333-444455556666', '7a01c2de-1111-2222-3333-444455556666', '9b12d3ef-1111-2222-3333-444455556666']

function spawn(runId: string, outcome: string): WorkItem {
  const item: ToolItem = {
    kind: 'tool',
    id: `spawn-${runId}`,
    at: at(0),
    endedAt: at(2),
    tool: {
      id: `spawn-${runId}`,
      name: 'spawn_agent_instance',
      summary: outcome,
      status: 'done',
      content: `Agent V Instance id; ${runId} (short ${runId.slice(0, 8)})\nrun_id: ${runId}`,
      argsPreview: JSON.stringify({ goal: outcome, outcome })
    }
  }
  return { kind: 'instance', id: item.id, tool: item }
}

describe('a step that started several instances', () => {
  const instances: Record<string, AgentInstanceUiState> = {
    [RUNS[0]!]: { instanceRunId: RUNS[0]!, phase: 'started', startedAt: at(2), activity: 'Reading routes/users.ts' },
    [RUNS[1]!]: { instanceRunId: RUNS[1]!, phase: 'done', startedAt: at(2), endedAt: at(62) },
    [RUNS[2]!]: { instanceRunId: RUNS[2]!, phase: 'error', summary: 'The route test never passed.' }
  }
  const work = (): WorkItem[] => [spawn(RUNS[0]!, 'Users route'), spawn(RUNS[1]!, 'Orders route'), spawn(RUNS[2]!, 'Billing route')]

  it('shows them as one block, a row each, not a spawn line each', () => {
    const onOpenAgentInstance = vi.fn()
    const { container } = render(
      <RunSessionProvider value={{ workspacePath: '/ws', runId: 'parent', agentInstances: instances, onOpenAgentInstance }}>
        <WorkList items={work()} />
      </RunSessionProvider>
    )
    const block = container.querySelector('[data-record-instances]') as HTMLElement
    expect(block.getAttribute('data-record-instances')).toBe('3')
    expect(block.textContent).toContain('3 instances')
    expect(block.textContent).toContain('1 running · 1 failed · 1 done')
    expect(block.querySelectorAll('li')).toHaveLength(3)
    // No separate spawn lines beside the block.
    expect(screen.queryByText(/^Running instance/)).toBeNull()
    // Each row says what its child is doing, was asked, or why it failed.
    expect(screen.getByText('Reading routes/users.ts')).toBeTruthy()
    expect(screen.getByText('Orders route')).toBeTruthy()
    expect(screen.getByText('The route test never passed.').className).toContain('text-danger')
    expect(screen.getByText('1m')).toBeTruthy()
    // The row opens its child.
    fireEvent.click(screen.getByRole('button', { name: /Open instance 7a01c2de/ }))
    expect(onOpenAgentInstance).toHaveBeenCalledWith(RUNS[1])
  })

  it('leaves a single spawn as its own line', () => {
    const one = [spawn(RUNS[1]!, 'Orders route')]
    expect(groupWork(one)).toEqual(one)
    const { container } = render(
      <RunSessionProvider value={{ workspacePath: '/ws', runId: 'parent', agentInstances: instances }}>
        <WorkList items={one} />
      </RunSessionProvider>
    )
    expect(container.querySelector('[data-record-instances]')).toBeNull()
    expect(screen.getByText('Instance finished 7a01c2de')).toBeTruthy()
  })

  it('groups only spawns made together', () => {
    const note: WorkItem = { kind: 'error', id: 'e1', message: 'x' }
    const groups = groupWork([spawn(RUNS[0]!, 'a'), note, spawn(RUNS[1]!, 'b'), spawn(RUNS[2]!, 'c')])
    expect(groups.map((g) => g.kind)).toEqual(['instance', 'error', 'instances'])
  })
})

describe('the result', () => {
  it('can be copied as text from the receipt', async () => {
    copyText.mockClear()
    show([user('Fix it', 0), tool('read', { path: 'a.ts' }, 'contents', 1), said('## Fixed\n\nThe retry awaits now.', 4)])
    fireEvent.click(screen.getByRole('button', { name: 'Copy the summary' }))
    await waitFor(() => expect(copyText).toHaveBeenCalledWith('## Fixed\n\nThe retry awaits now.'))
  })

  it('offers no copy while the run is live, or when it has no result', () => {
    show([user('Fix it', 0), tool('read', { path: 'a.ts' }, 'contents', 1)], { running: true })
    expect(screen.queryByRole('button', { name: 'Copy the summary' })).toBeNull()
    cleanup()
    show([user('Fix it', 0), tool('read', { path: 'a.ts' }, 'contents', 1)], { running: false, stopped: true })
    expect(screen.queryByRole('button', { name: 'Copy the summary' })).toBeNull()
  })
})
