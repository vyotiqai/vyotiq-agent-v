/**
 * @vitest-environment jsdom
 *
 * A row's `status` is a snapshot on disk, not a live fact. Main drops a run
 * from its active registry before the terminal status.json write has flushed,
 * and the renderer refreshes the run list exactly once on that transition — a
 * refresh that loses the race pins `running` forever and the row spins for a
 * chat that visibly finished. These pin the reconciliation that stops that.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChatRow } from '@renderer/app/sidebar/ChatRow'
import { ChatList } from '@renderer/app/sidebar/ChatList'
import type { WorkspaceSidebarGroup } from '@renderer/app/sidebar/types'
import type { RunSummary } from '@shared/ipc'

const noop = (): void => {}

const runningRun: RunSummary = {
  runId: 'run-1',
  goal: 'Hi',
  status: 'running',
  createdAt: Date.now(),
  updatedAt: Date.now()
}

function renderRow(live: boolean | undefined) {
  return render(
    <ChatRow
      run={runningRun}
      workspacePath="/ws/home"
      active={false}
      live={live}
      onSelectRun={noop}
      onRenameRun={noop}
      onDeleteRun={noop}
    />
  )
}

describe('ChatRow running indicator', () => {
  it('spins while main still lists the run as active', () => {
    renderRow(true)
    expect(screen.getByTitle('Running')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Running/ })).toBeTruthy()
  })

  it('stops spinning once main no longer lists the run', () => {
    renderRow(false)
    expect(screen.queryByTitle('Running')).toBeNull()
    // The label must agree — a screen reader was being told "Running" too.
    expect(screen.queryByRole('button', { name: /Running/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Hi' })).toBeTruthy()
  })

  it('trusts the snapshot while liveness is unknown', () => {
    renderRow(undefined)
    expect(screen.getByTitle('Running')).toBeTruthy()
  })
})

const group = (runs: RunSummary[]): WorkspaceSidebarGroup => ({
  path: '/ws/demo',
  label: 'demo',
  isActiveWorkspace: true,
  expanded: true,
  filteredRuns: runs,
  instanceRuns: [],
  groupedRuns: [{ id: 'g', label: 'Results', runs }],
  runsCapped: false,
  runsError: null,
  runsLoaded: true,
  activeRunId: null
})

function renderList(props: {
  activeRuns: { runId: string; workspacePath: string }[]
  activeRunsLoaded?: boolean
}) {
  return render(
    <ChatList
      workspaceReady
      sessionQuery=""
      filteredRunsCount={1}
      workspaceGroups={[group([runningRun])]}
      onToggleWorkspace={noop}
      onSwitchWorkspace={noop}
      onCloseWorkspace={noop}
      onAddWorkspace={noop}
      activeRuns={props.activeRuns}
      activeRunsLoaded={props.activeRunsLoaded}
      workspaceHasBackgroundRun={() => false}
      onSelectRun={noop}
      onRenameRun={noop}
      onDeleteRun={noop}
    />
  )
}

describe('ChatList liveness reconciliation', () => {
  it('drops the spinner for a run main has finished', () => {
    renderList({ activeRuns: [], activeRunsLoaded: true })
    expect(screen.queryByTitle('Running')).toBeNull()
  })

  it('keeps the spinner while that run is still active', () => {
    renderList({
      activeRuns: [{ runId: 'run-1', workspacePath: '/ws/demo' }],
      activeRunsLoaded: true
    })
    expect(screen.getByTitle('Running')).toBeTruthy()
  })

  it('does not blink live runs off before main has answered once', () => {
    // An empty list pre-answer means "unknown", not "nothing is running".
    renderList({ activeRuns: [], activeRunsLoaded: false })
    expect(screen.getByTitle('Running')).toBeTruthy()
  })
})
