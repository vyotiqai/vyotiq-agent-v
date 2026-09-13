/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatList } from '@renderer/app/sidebar/ChatList'
import { RUN_LIST_CAP } from '@shared/domain/runs'
import type { WorkspaceSidebarGroup } from '@renderer/app/sidebar/types'

afterEach(() => cleanup())

const workspaceGroup = (overrides: Partial<WorkspaceSidebarGroup> = {}): WorkspaceSidebarGroup => ({
  path: '/ws/demo',
  label: 'demo',
  isActiveWorkspace: true,
  expanded: true,
  filteredRuns: [],
  instanceRuns: [],
  groupedRuns: [],
  runsCapped: false,
  runsError: null,
  runsLoaded: true,
  activeRunId: null,
  ...overrides
})

const noop = (): void => {}

describe('ChatList', () => {
  it('offers an Open workspace action when no workspace is open', () => {
    const onAddWorkspace = vi.fn()
    render(
      <ChatList
        workspaceReady={false}
        sessionQuery=""
        filteredRunsCount={0}
        workspaceGroups={[]}
        onToggleWorkspace={noop}
        onSwitchWorkspace={noop}
        onCloseWorkspace={noop}
        onAddWorkspace={onAddWorkspace}
        activeRuns={[]}
        workspaceHasBackgroundRun={() => false}
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={noop}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }))
    expect(onAddWorkspace).toHaveBeenCalledTimes(1)
  })

  it('uses the shared section label for workspaces', () => {
    render(
      <ChatList
        workspaceReady
        sessionQuery=""
        filteredRunsCount={0}
        workspaceGroups={[workspaceGroup()]}
        onToggleWorkspace={noop}
        onSwitchWorkspace={noop}
        onCloseWorkspace={noop}
        onAddWorkspace={noop}
        activeRuns={[]}
        workspaceHasBackgroundRun={() => false}
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={noop}
      />
    )

    expect(screen.getByText('Workspaces')).toBeTruthy()
  })

  it('shows the search empty state once for global search misses', () => {
    render(
      <ChatList
        workspaceReady
        sessionQuery="missing"
        filteredRunsCount={0}
        workspaceGroups={[workspaceGroup({ filteredRuns: [], groupedRuns: [] })]}
        onToggleWorkspace={noop}
        onSwitchWorkspace={noop}
        onCloseWorkspace={noop}
        onAddWorkspace={noop}
        activeRuns={[]}
        workspaceHasBackgroundRun={() => false}
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={noop}
      />
    )

    expect(screen.getAllByText('No matching chats')).toHaveLength(1)
    const emptyState = screen.getByText('No matching chats')
    expect(emptyState.className).not.toContain('rounded-xl')
  })

  it('shows the dynamic runs cap footnote', () => {
    render(
      <ChatList
        workspaceReady
        sessionQuery=""
        filteredRunsCount={1}
        workspaceGroups={[
          workspaceGroup({
            filteredRuns: [
              {
                runId: 'run-1',
                goal: 'Ship sidebar',
                status: 'done',
                updatedAt: new Date().toISOString()
              }
            ],
            groupedRuns: [
              {
                id: 'today',
                label: 'Today',
                runs: [
                  {
                    runId: 'run-1',
                    goal: 'Ship sidebar',
                    status: 'done',
                    updatedAt: new Date().toISOString()
                  }
                ]
              }
            ],
            runsCapped: true
          })
        ]}
        onToggleWorkspace={noop}
        onSwitchWorkspace={noop}
        onCloseWorkspace={noop}
        onAddWorkspace={noop}
        activeRuns={[]}
        workspaceHasBackgroundRun={() => false}
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={noop}
      />
    )

    expect(screen.getByText(`Showing ${RUN_LIST_CAP} most recent`)).toBeTruthy()
  })

  it('hides chat rows when hideSessionRuns is set (keeps workspace chrome)', () => {
    render(
      <ChatList
        workspaceReady
        sessionQuery=""
        filteredRunsCount={1}
        hideSessionRuns
        workspaceGroups={[
          workspaceGroup({
            filteredRuns: [
              {
                runId: 'run-1',
                goal: 'Ship sidebar',
                status: 'done',
                updatedAt: new Date().toISOString()
              }
            ],
            groupedRuns: [
              {
                id: 'today',
                label: 'Today',
                runs: [
                  {
                    runId: 'run-1',
                    goal: 'Ship sidebar',
                    status: 'done',
                    updatedAt: new Date().toISOString()
                  }
                ]
              }
            ]
          })
        ]}
        onToggleWorkspace={noop}
        onSwitchWorkspace={noop}
        onCloseWorkspace={noop}
        onAddWorkspace={noop}
        activeRuns={[]}
        workspaceHasBackgroundRun={() => false}
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={noop}
      />
    )

    expect(screen.getByText('Workspaces')).toBeTruthy()
    expect(screen.getByText('demo')).toBeTruthy()
    expect(screen.queryByText('Ship sidebar')).toBeNull()
  })

  it('folds idle instance children and expands when parent is focused', () => {
    const parent = {
      runId: 'parent-1',
      goal: 'Orchestrate audit',
      status: 'done' as const,
      updatedAt: new Date().toISOString()
    }
    const child = {
      runId: 'child-1',
      goal: 'Audit-partition B (LLM client & config)',
      status: 'done' as const,
      updatedAt: new Date().toISOString(),
      parentRunId: 'parent-1',
      inlineInstance: true as const,
      pathScope: ['src/llm/']
    }

    const groups = [
      workspaceGroup({
        filteredRuns: [parent],
        instanceRuns: [child],
        groupedRuns: [{ id: 'today', label: 'Today', runs: [parent] }],
        activeRunId: null
      })
    ]

    const { rerender } = render(
      <ChatList
        workspaceReady
        sessionQuery=""
        filteredRunsCount={1}
        workspaceGroups={groups}
        onToggleWorkspace={noop}
        onSwitchWorkspace={noop}
        onCloseWorkspace={noop}
        onAddWorkspace={noop}
        activeRuns={[]}
        workspaceHasBackgroundRun={() => false}
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={noop}
      />
    )

    expect(screen.getByText('1 instance')).toBeTruthy()
    expect(screen.queryByText('Audit-partition B (LLM client & config)')).toBeNull()

    rerender(
      <ChatList
        workspaceReady
        sessionQuery=""
        filteredRunsCount={1}
        workspaceGroups={[
          workspaceGroup({
            filteredRuns: [parent],
            instanceRuns: [child],
            groupedRuns: [{ id: 'today', label: 'Today', runs: [parent] }],
            activeRunId: 'parent-1'
          })
        ]}
        onToggleWorkspace={noop}
        onSwitchWorkspace={noop}
        onCloseWorkspace={noop}
        onAddWorkspace={noop}
        activeRuns={[]}
        workspaceHasBackgroundRun={() => false}
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={noop}
      />
    )

    expect(screen.getByText('Audit-partition B (LLM client & config)')).toBeTruthy()
    expect(screen.getByLabelText('Instances of Orchestrate audit')).toBeTruthy()
    const nestedRow = screen.getByText('Audit-partition B (LLM client & config)').closest('button')
    expect(nestedRow?.getAttribute('draggable')).toBe('false')
    const parentRow = screen.getByText('Orchestrate audit').closest('button')
    expect(parentRow?.getAttribute('draggable')).toBe('true')
  })

  it('moves session focus with ArrowDown without selecting', () => {
    const onSelectRun = vi.fn()
    const runA = {
      runId: 'run-a',
      goal: 'First chat',
      status: 'done' as const,
      updatedAt: new Date().toISOString()
    }
    const runB = {
      runId: 'run-b',
      goal: 'Second chat',
      status: 'done' as const,
      updatedAt: new Date().toISOString()
    }
    render(
      <ChatList
        workspaceReady
        sessionQuery=""
        filteredRunsCount={2}
        workspaceGroups={[
          workspaceGroup({
            filteredRuns: [runA, runB],
            groupedRuns: [{ id: 'today', label: 'Today', runs: [runA, runB] }]
          })
        ]}
        onToggleWorkspace={noop}
        onSwitchWorkspace={noop}
        onCloseWorkspace={noop}
        onAddWorkspace={noop}
        activeRuns={[]}
        workspaceHasBackgroundRun={() => false}
        onSelectRun={onSelectRun}
        onRenameRun={noop}
        onDeleteRun={noop}
      />
    )
    const first = screen.getByRole('button', { name: 'First chat' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Second chat' }))
    expect(onSelectRun).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Second chat' }))
    expect(onSelectRun).toHaveBeenCalledWith('/ws/demo', 'run-b')
  })

  it('offers a per-workspace new chat action on the workspace header', () => {
    const onNewChatInWorkspace = vi.fn()
    const onSwitchWorkspace = vi.fn()
    render(
      <ChatList
        workspaceReady
        sessionQuery=""
        filteredRunsCount={0}
        workspaceGroups={[workspaceGroup()]}
        onToggleWorkspace={noop}
        onSwitchWorkspace={onSwitchWorkspace}
        onCloseWorkspace={noop}
        onAddWorkspace={noop}
        onNewChatInWorkspace={onNewChatInWorkspace}
        activeRuns={[]}
        workspaceHasBackgroundRun={() => false}
        onSelectRun={noop}
        onRenameRun={noop}
        onDeleteRun={noop}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'New chat in demo' }))
    expect(onNewChatInWorkspace).toHaveBeenCalledWith('/ws/demo')
    expect(onSwitchWorkspace).not.toHaveBeenCalled()
  })
})
