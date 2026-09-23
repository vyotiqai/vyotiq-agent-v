import { describe, expect, it } from 'vitest'
import type { ActiveRun, RunSummary } from '@shared/ipc'
import { RUN_INTERRUPTED_ERROR } from '@shared/runInterrupt'
import { buildNavigatorSections, type NavigatorInput } from '@renderer/app/navigator/navigatorModel'

const NOW = Date.parse('2026-09-23T12:00:00.000Z')
const minsAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString()
const A = 'C:\\work\\alpha'
const B = 'C:\\work\\beta'

function run(runId: string, over: Partial<RunSummary> = {}): RunSummary {
  return { runId, status: 'done', updatedAt: minsAgo(30), goal: `Task ${runId}`, ...over }
}

function input(over: Partial<NavigatorInput> = {}): NavigatorInput {
  return {
    runsByWorkspacePath: {},
    openPaths: [A, B],
    activePath: A,
    activeRuns: [],
    activeRunsLoaded: true,
    scopePath: null,
    now: NOW,
    ...over
  }
}

const live = (runId: string, over: Partial<ActiveRun> = {}): ActiveRun => ({
  runId,
  workspacePath: A,
  invokeId: 1,
  pendingFollowUps: [],
  ...over
})

function sectionOf(sections: ReturnType<typeof buildNavigatorSections>, runId: string) {
  for (const s of sections) {
    const row = s.rows.find((r) => r.runId === runId)
    if (row) return { section: s.key, row }
  }
  return null
}

describe('buildNavigatorSections', () => {
  it('puts a live run that waits on an approval under Needs you, with the wait as an accent age', () => {
    const sections = buildNavigatorSections(
      input({
        runsByWorkspacePath: { [A]: { runs: [run('r1', { status: 'running' })] } },
        activeRuns: [live('r1', { waiting: { kind: 'approval', since: minsAgo(3) } })]
      })
    )
    const hit = sectionOf(sections, 'r1')
    expect(hit?.section).toBe('needs')
    expect(hit?.row.state).toBe('needs')
    expect(hit?.row.meta).toEqual({ kind: 'age', text: '3m', accent: true })
  })

  it('shows the step in progress for a running task with todos', () => {
    const sections = buildNavigatorSections(
      input({
        runsByWorkspacePath: { [A]: { runs: [run('r1', { status: 'running' })] } },
        activeRuns: [live('r1', { steps: { completed: 3, total: 5 } })]
      })
    )
    expect(sectionOf(sections, 'r1')).toMatchObject({
      section: 'running',
      row: { state: 'running', meta: { kind: 'steps', current: 4, total: 5 } }
    })
  })

  it('never reports step 6 of 5 once every todo is done', () => {
    const sections = buildNavigatorSections(
      input({
        runsByWorkspacePath: { [A]: { runs: [run('r1', { status: 'running' })] } },
        activeRuns: [live('r1', { steps: { completed: 5, total: 5 } })]
      })
    )
    expect(sectionOf(sections, 'r1')?.row.meta).toEqual({ kind: 'steps', current: 5, total: 5 })
  })

  it('trusts the live registry over a stale "running" snapshot once it has answered', () => {
    const runs = { [A]: { runs: [run('r1', { status: 'running' })] } }
    expect(sectionOf(buildNavigatorSections(input({ runsByWorkspacePath: runs })), 'r1')).toMatchObject({
      section: 'done',
      row: { state: 'stopped' }
    })
    // Before main answers, the snapshot is all there is.
    expect(
      sectionOf(buildNavigatorSections(input({ runsByWorkspacePath: runs, activeRunsLoaded: false })), 'r1')
        ?.section
    ).toBe('running')
  })

  it('lists an armed loop under Running as queued, with when it runs next', () => {
    const next = new Date(NOW + 4 * 3_600_000).toISOString()
    const sections = buildNavigatorSections(
      input({ runsByWorkspacePath: { [A]: { runs: [run('r1', { loopArmed: true, loopNextAt: next })] } } })
    )
    expect(sectionOf(sections, 'r1')).toMatchObject({
      section: 'running',
      row: { state: 'queued', stateLabel: 'Scheduled', meta: { kind: 'age', text: 'in 4h' } }
    })
  })

  it('puts a finished task with unresolved edits under Ready for review with its exact diff', () => {
    const sections = buildNavigatorSections(
      input({ runsByWorkspacePath: { [A]: { runs: [run('r1', { review: { files: 3, add: 52, del: 4 } })] } } })
    )
    expect(sectionOf(sections, 'r1')).toMatchObject({
      section: 'review',
      row: { state: 'review', meta: { kind: 'diff', add: 52, del: 4, files: 3 } }
    })
  })

  it('shows only a file count when the edits could not be counted exactly', () => {
    const sections = buildNavigatorSections(
      input({ runsByWorkspacePath: { [A]: { runs: [run('r1', { review: { files: 2 } })] } } })
    )
    expect(sectionOf(sections, 'r1')?.row.meta).toEqual({ kind: 'files', files: 2 })
  })

  it('keeps a failed task with edits in review but says it failed', () => {
    const sections = buildNavigatorSections(
      input({ runsByWorkspacePath: { [A]: { runs: [run('r1', { status: 'error', review: { files: 1, add: 1, del: 0 } })] } } })
    )
    expect(sectionOf(sections, 'r1')).toMatchObject({
      section: 'review',
      row: { state: 'failed', stateLabel: 'Failed · edits to review' }
    })
  })

  it('names finished states truthfully under Done', () => {
    const sections = buildNavigatorSections(
      input({
        runsByWorkspacePath: {
          [A]: {
            runs: [
              run('done'),
              run('failed', { status: 'error' }),
              run('stopped', { status: 'cancelled' }),
              run('interrupted', { status: 'cancelled', error: RUN_INTERRUPTED_ERROR }),
              run('paused', { goalStatus: 'paused' })
            ]
          }
        }
      })
    )
    const labels = Object.fromEntries(
      ['done', 'failed', 'stopped', 'interrupted', 'paused'].map((id) => {
        const hit = sectionOf(sections, id)
        return [id, `${hit?.section}:${hit?.row.state}:${hit?.row.stateLabel}`]
      })
    )
    expect(labels).toEqual({
      done: 'done:done:Done',
      failed: 'done:failed:Failed',
      stopped: 'done:stopped:Stopped',
      interrupted: 'done:stopped:Interrupted',
      paused: 'done:paused:Goal paused'
    })
  })

  it('leaves instances out — they belong to their parent task', () => {
    const sections = buildNavigatorSections(
      input({ runsByWorkspacePath: { [A]: { runs: [run('child', { inlineInstance: true, parentRunId: 'p' })] } } })
    )
    expect(sections).toEqual([])
  })

  it('filters to one workspace and marks rows from others as foreign', () => {
    const runsByWorkspacePath = { [A]: { runs: [run('a1')] }, [B]: { runs: [run('b1')] } }
    const all = buildNavigatorSections(input({ runsByWorkspacePath }))
    expect(sectionOf(all, 'a1')?.row.foreign).toBe(false)
    expect(sectionOf(all, 'b1')?.row).toMatchObject({ foreign: true, workspaceName: 'beta' })

    const onlyB = buildNavigatorSections(input({ runsByWorkspacePath, scopePath: B }))
    expect(sectionOf(onlyB, 'a1')).toBeNull()
    expect(sectionOf(onlyB, 'b1')).not.toBeNull()
  })

  it('orders sections by what they want from you and omits empty ones', () => {
    const sections = buildNavigatorSections(
      input({
        runsByWorkspacePath: {
          [A]: { runs: [run('d'), run('w', { status: 'running' }), run('rv', { review: { files: 1 } })] }
        },
        activeRuns: [live('w', { waiting: { kind: 'question', since: minsAgo(1) } })]
      })
    )
    expect(sections.map((s) => s.key)).toEqual(['needs', 'review', 'done'])
  })

  it('lists the longest wait first under Needs you, newest first elsewhere', () => {
    const sections = buildNavigatorSections(
      input({
        runsByWorkspacePath: {
          [A]: {
            runs: [
              run('w-new', { status: 'running' }),
              run('w-old', { status: 'running' }),
              run('d-old', { updatedAt: minsAgo(90) }),
              run('d-new', { updatedAt: minsAgo(5) })
            ]
          }
        },
        activeRuns: [
          live('w-new', { waiting: { kind: 'approval', since: minsAgo(1) } }),
          live('w-old', { waiting: { kind: 'approval', since: minsAgo(10) } })
        ]
      })
    )
    expect(sections[0]!.rows.map((r) => r.runId)).toEqual(['w-old', 'w-new'])
    expect(sections[1]!.rows.map((r) => r.runId)).toEqual(['d-new', 'd-old'])
  })

  it('marks a task unread when its finish notification is unread', () => {
    const sections = buildNavigatorSections(
      input({ runsByWorkspacePath: { [A]: { runs: [run('r1')] } }, unreadRunIds: new Set(['r1']) })
    )
    expect(sectionOf(sections, 'r1')?.row.unread).toBe(true)
  })
})
