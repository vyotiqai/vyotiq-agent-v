/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ActiveRun, RunSearchResult, RunSummary } from '@shared/ipc'
import { CommandPalette } from '@renderer/features/commandPalette/CommandPalette'
import { buildNavigatorSections } from '@renderer/app/navigator/navigatorModel'

/** Ctrl K finds a task by its title, then by the line under it: what it is doing now, or where it is. */

afterEach(cleanup)

const WS = 'C:\\work\\vyotiq'
const OTHER = 'C:\\work\\billing'

const now = new Date().toISOString()
const RUNS: Record<string, RunSummary[]> = {
  [WS]: [
    { runId: 'live', status: 'running', updatedAt: now, goal: 'Speed up the importer' },
    { runId: 'done', status: 'done', updatedAt: now, goal: 'Tidy the parser' }
  ],
  [OTHER]: [
    { runId: 'inv', status: 'done', updatedAt: now, goal: 'Fix the invoice totals' },
    { runId: 'exp', status: 'done', updatedAt: now, goal: 'Add a billing export' }
  ]
}
const ACTIVE: ActiveRun[] = [{ runId: 'live', workspacePath: WS, invokeId: 1, pendingFollowUps: [], activity: 'Running pnpm vitest api' }]

function palette(searchRuns?: (query: string) => Promise<RunSearchResult | null>) {
  const tasks = buildNavigatorSections({
    runsByWorkspacePath: Object.fromEntries(Object.entries(RUNS).map(([path, runs]) => [path, { runs }])),
    openPaths: [WS, OTHER],
    activePath: WS,
    activeRuns: ACTIVE,
    activeRunsLoaded: true,
    scopePath: null
  }).flatMap((s) => s.rows)
  render(
    <CommandPalette
      open
      tasks={tasks}
      commands={[]}
      searchRuns={searchRuns}
      newTaskIn={null}
      onClose={vi.fn()}
      onOpenTask={vi.fn()}
      onOpenFile={vi.fn()}
      onRunCommand={vi.fn()}
      onNewTask={vi.fn()}
    />
  )
  return screen.getByRole('textbox', { name: 'Search tasks, files and commands' })
}

const taskTitles = (): string[] =>
  [...document.querySelectorAll('[data-palette-kind="task"], [data-palette-index]')]
    .map((el) => el.textContent ?? '')
    .filter((text) => /importer|parser|invoice|export/i.test(text))

describe('Ctrl K task search', () => {
  it('finds a running task by what it is doing now', () => {
    const input = palette()
    fireEvent.change(input, { target: { value: 'vitest api' } })
    const found = taskTitles()
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('Speed up the importer')
  })

  it('finds a task by the workspace it is in, after the ones whose title matches', () => {
    const input = palette()
    fireEvent.change(input, { target: { value: 'billing' } })
    const found = taskTitles()
    expect(found).toHaveLength(2)
    // Its title says "billing": it leads. The other is only in the billing workspace.
    expect(found[0]).toContain('Add a billing export')
    expect(found[1]).toContain('Fix the invoice totals')
  })

  it('still finds by title alone, and nothing for a word no task line holds', () => {
    const input = palette()
    fireEvent.change(input, { target: { value: 'parser' } })
    expect(taskTitles()).toHaveLength(1)
    fireEvent.change(input, { target: { value: 'zebra' } })
    expect(taskTitles()).toHaveLength(0)
  })
})

describe('Ctrl K searches what was said', () => {
  it('lists tasks that mention the query under "Mentioned in", after a pause', async () => {
    const searchRuns = vi.fn(async () => ({
      truncated: false,
      scannedRuns: 4,
      hits: [
        // A title hit is already in Tasks; only the transcript hit is new.
        { workspacePath: OTHER, runId: 'exp', title: 'Add a billing export', updatedAt: now, status: 'done', where: 'title' as const, snippet: 'Add a billing export', matchStart: 0, matchLength: 3 },
        { workspacePath: OTHER, runId: 'inv', title: 'Fix the invoice totals', updatedAt: now, status: 'done', where: 'agent' as const, snippet: 'the tax was subtracted twice', matchStart: 12, matchLength: 10 }
      ]
    }))
    const input = palette(searchRuns)
    fireEvent.change(input, { target: { value: 'subtracted' } })
    const group = await screen.findByRole('group', { name: 'Mentioned in' }, { timeout: 2000 })
    expect(searchRuns).toHaveBeenCalledWith('subtracted')
    expect(within(group).getAllByRole('option')).toHaveLength(1)
    expect(group.textContent).toContain('Fix the invoice totals')
    expect(group.querySelector('[data-palette-snippet]')?.textContent).toBe('Agent: the tax was subtracted twice')
    expect(group.querySelector('mark')?.textContent).toBe('subtracted')
  })

  it('does not search transcripts in commands-only mode', async () => {
    const searchRuns = vi.fn(async () => null)
    const input = palette(searchRuns)
    fireEvent.change(input, { target: { value: '>settings' } })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(searchRuns).not.toHaveBeenCalled()
  })
})
