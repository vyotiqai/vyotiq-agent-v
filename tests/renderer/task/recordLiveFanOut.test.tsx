/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import type { AgentInstanceUiState } from '@shared/utils/agentInstance'
import { buildRecordModel, type BuildOptions, type WorkItem } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { WorkList } from '@renderer/features/task/record/WorkItems'
import { detailOf } from '@renderer/features/task/record/WorkFold'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'

/**
 * Run 68591427 (2026-10-07), in shape: a plan of steps each run by a child,
 * the parent waiting on two of them. The record said "Working" twice, put its
 * live line above the steps, and named each running child three times — the
 * step row, its own row and the wait on it — each with a spinner and a time.
 */

afterEach(cleanup)

const T0 = Date.parse('2026-10-07T17:04:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

let seq = 0
const nextId = (p: string): string => `${p}-${++seq}`

const KID = '689a9c1c-1111-4222-8333-444455556666'
const KID2 = '0bd1ab3b-1111-4222-8333-444455556666'

type ToolItem = Extract<UiItem, { kind: 'tool' }>

function tool(
  name: string,
  args: unknown,
  content: string | undefined,
  s: number,
  status: 'done' | 'fail' | 'running' = 'done',
  summary = ''
): ToolItem {
  return {
    kind: 'tool',
    id: nextId('t'),
    at: at(s),
    ...(status === 'running' ? {} : { endedAt: at(s + 1) }),
    tool: { id: nextId('call'), name, summary, status, content, argsPreview: typeof args === 'string' ? args : JSON.stringify(args) }
  }
}

const spawned = (runId: string): string => `Agent V Instance id; ${runId} (short ${runId.slice(0, 8)})\nrun_id: ${runId}`
const spawn = (runId: string, stepId: string, s: number): ToolItem =>
  tool('spawn_agent_instance', { goal: 'Repo: background', outcome: 'An end-to-end traced description', sub_tasks: ['x'], done_when: 'y', step_id: stepId }, spawned(runId), s)
const waitOn = (runId: string, s: number): ToolItem => tool('await_agent_instance', { run_id: runId }, undefined, s, 'running')

const plan = tool(
  'create_plan',
  {
    title: 'Parallel analysis',
    plan: '# P',
    todos: [
      { id: 's1', content: 'Appearance + settings trace', status: 'pending' },
      { id: 's2', content: 'Guard integrity', status: 'pending' }
    ]
  },
  'Wrote plan.md',
  2
)

const items: UiItem[] = [
  { kind: 'message', id: 'user-0', role: 'user', content: 'run parallel instances for analysis', at: at(0) },
  plan,
  spawn(KID, 's1', 10),
  spawn(KID2, 's2', 11),
  waitOn(KID, 20),
  waitOn(KID2, 21)
]

const running = (activity: string): AgentInstanceUiState => ({
  instanceRunId: '',
  phase: 'started',
  startedAt: at(10),
  step: 32,
  activity
})
const agentInstances: Record<string, AgentInstanceUiState> = {
  [KID]: { ...running('Thinking'), instanceRunId: KID, stepId: 's1' },
  [KID2]: { ...running('Reading loop.ts'), instanceRunId: KID2, stepId: 's2' }
}
const live: BuildOptions = { running: true, instances: agentInstances }

function show(activity: string | null) {
  return render(
    <RunSessionProvider value={{ workspacePath: '/ws', runId: 'parent', agentInstances }}>
      <TaskRecord model={buildRecordModel(items, live)} options={live} activity={activity} messageCount={1} />
    </RunSessionProvider>
  )
}

describe('a live fan-out, said once', () => {
  it('names a running child once: its step row has its id and time, its own row only how it stands', () => {
    const { container } = show(null)
    const step = container.querySelector<HTMLElement>('[data-step="1"]')!
    // The id is the step row's chip, and nowhere else in the step.
    expect(step.textContent!.split(KID.slice(0, 8)).length - 1).toBe(1)
    const row = step.querySelector<HTMLElement>('[data-record-instance]')!
    expect(row.textContent).toContain('Running instance')
    expect(row.textContent).toContain('Thinking')
    // Not the child's own loop count, which read as step 32 of a two-step plan.
    expect(row.textContent).not.toMatch(/Step 32/)
    // Not the outcome again (its title tells it) and not a second "Open" beside the chip.
    expect(row.textContent).not.toContain('An end-to-end traced description')
    expect(row.textContent).not.toContain('Open')
    expect(row.getAttribute('title')).toBe('An end-to-end traced description')
  })

  it('draws no row for a wait on a child whose own row is right there', () => {
    const { container } = show(null)
    expect(container.querySelector('[data-record-tool="await_agent_instance"]')).toBeNull()
  })

  it('keeps a wait that has settled: that is where the child’s report is', () => {
    const work: WorkItem[] = [
      { kind: 'instance', id: 'i-1', tool: spawn(KID, 's1', 10) },
      {
        kind: 'instance',
        id: 'i-2',
        tool: tool('await_agent_instance', { run_id: KID }, `Agent V Instance id; ${KID}\nphase: done\n\n# Findings\nAll good.`, 30)
      }
    ]
    render(
      <RunSessionProvider value={{ workspacePath: '/ws', runId: 'parent', agentInstances: { [KID]: { instanceRunId: KID, phase: 'done' } } }}>
        <WorkList items={work} />
      </RunSessionProvider>
    )
    expect(document.querySelector('[data-record-tool="await_agent_instance"]')).not.toBeNull()
  })

  it('says nothing more than the work line when all there is to say is "Working"', () => {
    show('Working')
    expect(screen.queryByText('Now')).toBeNull()
  })

  it('puts a live line after the steps, not above them, while children work in them', () => {
    const { container } = show('Reconnecting (attempt 2)')
    const steps = container.querySelector('ol[aria-label="Steps"]')!
    const now = screen.getByText('Now')
    expect(steps.compareDocumentPosition(now) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('says how far a live plan has got when none of its steps is under way', () => {
    const waiting: UiItem[] = [items[0]!, plan, tool('read', { path: 'a.ts' }, 'x', 3)]
    const run = buildRecordModel(waiting, { running: true }).runs[0]!
    expect(detailOf(run, true)).toBe('0 of 2 steps done · 1 lookup · 1 call')
    // Settled, it is how many there were.
    expect(detailOf(buildRecordModel(waiting, { running: false }).runs[0]!, false)).toBe('2 steps · 1 lookup · 1 call')
  })
})

describe('a call whose summary is its own name', () => {
  it('says "Git status" once, not "Git status  git status"', () => {
    const work: WorkItem[] = [{ kind: 'tool', id: 'g', tool: tool('git_status', {}, 'clean', 1, 'done', 'git status') }]
    const { container } = render(<WorkList items={work} />)
    const line = container.querySelector('[data-record-tool="git_status"]')!
    expect(line.textContent).toContain('Git status')
    expect(line.textContent).not.toContain('git status')
  })

  it('says it once as the lookup the record files it as (run 8a71e5dd)', () => {
    const lookups: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'go', at: at(0) },
      tool('git_status', {}, 'On branch main\nnothing to commit', 1, 'done', 'git status')
    ]
    const run = buildRecordModel(lookups, { running: false }).runs[0]!
    const work = [...run.setup, ...run.after]
    expect(work.map((w) => w.kind)).toContain('explore')
    const { container } = render(<WorkList items={work} />)
    expect(container.textContent).toContain('Git status')
    expect(container.textContent).not.toContain('git status')
  })
})

describe('History', () => {
  it('leads each run with what you asked, then the answer’s first line without its colon', () => {
    const runs: UiItem[] = [
      { kind: 'message', id: 'user-0', role: 'user', content: 'list files', at: at(0) },
      tool('list_dir', { path: '.' }, 'a\nb', 1),
      { kind: 'message', id: 'a-1', role: 'assistant', content: 'Root directory listing (43 entries):\n\n- a\n- b', at: at(3) },
      { kind: 'message', id: 'user-1', role: 'user', content: 'yes go deeper', at: at(10) }
    ]
    const { container } = render(<TaskRecord model={buildRecordModel(runs, { running: false })} options={{ running: false }} messageCount={4} />)
    const row = container.querySelector('[data-history-run="1"]')!
    expect(row.textContent).toContain('list files · Root directory listing (43 entries)')
    expect(row.textContent).not.toContain('entries):')
  })
})
