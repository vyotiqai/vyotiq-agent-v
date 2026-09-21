/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MAX_DELEGATED_TASK_PROMPT_CHARS, type AgentProfile, type DelegatedTask } from '@shared/ipc'

const pushToastMock = vi.hoisted(() => vi.fn())
vi.mock('@renderer/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/ui')>()),
  pushToast: pushToastMock
}))

import { TeammatesView } from '@renderer/features/teammates/TeammatesView'
import { resetAgentProfilesStoreForTests } from '@renderer/lib/hooks/useAgentProfiles'
import { resetDelegatedTasksStoreForTests } from '@renderer/lib/hooks/useDelegatedTasks'

/**
 * Task surfaces. The record has always carried scheduling, timing, failure
 * text and retry provenance; none of it was ever rendered, and everything but
 * the active task plus two finished ones was unreachable.
 */

function profile(patch: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'scout',
    name: 'Scout',
    scope: 'global',
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    ...patch
  } as AgentProfile
}

function task(patch: Partial<DelegatedTask> = {}): DelegatedTask {
  return {
    id: 'task-1',
    profileId: 'scout',
    workspacePath: '/ws-a',
    prompt: 'audit and analyze the codebase end to end',
    status: 'queued',
    createdAt: '2026-09-18T00:00:00.000Z',
    ...patch
  } as DelegatedTask
}

let roster: AgentProfile[] = []
let queue: DelegatedTask[] = []
let enqueued: unknown[] = []
let cancelled: string[] = []
let retried: string[] = []
let enqueueOutcome: { ok: boolean; error?: string } = { ok: true }

function renderView(
  props: Partial<React.ComponentProps<typeof TeammatesView>> = {}
): ReturnType<typeof render> {
  return render(
    <TeammatesView
      secrets={{ openai: true } as never}
      openWorkspaces={['/ws-a', '/ws-b']}
      activeWorkspacePath="/ws-a"
      onClose={() => {}}
      {...props}
    />
  )
}

beforeEach(() => {
  resetAgentProfilesStoreForTests()
  resetDelegatedTasksStoreForTests()
  roster = [profile()]
  queue = []
  enqueued = []
  cancelled = []
  retried = []
  enqueueOutcome = { ok: true }
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
  // @ts-expect-error test bridge
  window.vyotiq = {
    agentProfilesList: vi.fn(async () => ({ ok: true as const, data: roster })),
    onAgentProfilesChanged: vi.fn(() => () => {}),
    agentProfilesUpdate: vi.fn(async () => ({ ok: true as const, data: profile() })),
    agentProfilesDelete: vi.fn(async () => ({
      ok: true as const,
      data: { deleted: true as const, cancelledTasks: 0, cancelledRuns: 0, warnings: [] }
    })),
    tasksList: vi.fn(async () => ({ ok: true as const, data: queue })),
    onTasksChanged: vi.fn(() => () => {}),
    tasksEnqueue: vi.fn(async (req: unknown) => {
      enqueued.push(req)
      return enqueueOutcome.ok
        ? { ok: true as const, data: task({ id: 'task-new' }) }
        : { ok: false as const, error: enqueueOutcome.error ?? 'nope' }
    }),
    tasksCancel: vi.fn(async (req: { id: string }) => {
      cancelled.push(req.id)
      return { ok: true as const, data: true }
    }),
    tasksRetry: vi.fn(async (req: { id: string }) => {
      retried.push(req.id)
      return { ok: true as const, data: task({ id: 'task-clone', retryOf: req.id }) }
    }),
    listModels: vi.fn(async () => ({ ok: true as const, data: { models: [] } }))
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// The Roster/Tasks tab pair is gone: the inbox is a row in the rail, above
// the roster, and it is the only way there.
async function openInbox(): Promise<void> {
  renderView()
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Scout' })).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'All tasks' }))
}

describe('task rows', () => {
  it('shows why a task failed, not just that it did', async () => {
    queue = [
      task({
        status: 'failed',
        error: 'Teammate profile no longer exists',
        finishedAt: '2026-09-18T01:00:00.000Z'
      })
    ]
    renderView()

    const failure = await screen.findByTestId('delegated-task-error')
    expect(failure.textContent).toBe('Teammate profile no longer exists')
    expect(failure.className).toContain('text-danger')
  })

  it('says a task is a retry, which the record recorded and nothing showed', async () => {
    queue = [task({ retryOf: 'task-0' })]
    renderView()

    expect(await screen.findByText('Retry of an earlier attempt')).toBeTruthy()
  })

  it('says when a scheduled task actually starts', async () => {
    // 180 minutes, not 90: the hours label rounds, so a 1.5h fixture sits
    // exactly on the rounding boundary and a millisecond of drift flips the
    // label between "in 2h" and "in 1h".
    const soon = new Date(Date.now() + 180 * 60_000).toISOString()
    queue = [task({ status: 'scheduled', scheduledAt: soon })]
    renderView()

    expect(await screen.findByText(/^Starts .* \(in 3h\)$/)).toBeTruthy()
  })

  it('reports how long a finished task took', async () => {
    queue = [
      task({
        status: 'done',
        startedAt: '2026-09-18T00:00:00.000Z',
        finishedAt: '2026-09-18T00:01:30.000Z'
      })
    ]
    renderView()

    expect(await screen.findByText(/^Took 1m 30s,/)).toBeTruthy()
  })

  it('opens the transcript of a task that produced a run', async () => {
    const onOpenTaskRun = vi.fn()
    queue = [
      task({ status: 'done', runId: 'run-1', finishedAt: '2026-09-18T01:00:00.000Z' })
    ]
    renderView({ onOpenTaskRun })

    fireEvent.click(await screen.findByTestId('delegated-task-open'))
    expect(onOpenTaskRun).toHaveBeenCalledWith('/ws-a', 'run-1')
  })

  it('leaves a task that never started unopenable', async () => {
    queue = [task()]
    renderView()
    await screen.findByText('audit and analyze the codebase end to end')

    expect(screen.queryByTestId('delegated-task-open')).toBeNull()
  })
})

describe('task controls', () => {
  it('offers retry on a finished task and calls main with its id', async () => {
    queue = [task({ status: 'done', finishedAt: '2026-09-18T01:00:00.000Z' })]
    renderView()

    fireEvent.click(await screen.findByTestId('delegated-task-retry'))

    await waitFor(() => expect(retried).toEqual(['task-1']))
    expect(pushToastMock).toHaveBeenCalledWith('Task reassigned to Scout')
  })

  it('offers cancel, not retry, while a task is still running', async () => {
    queue = [
      task({ status: 'running', runId: 'run-1', startedAt: '2026-09-18T00:00:10.000Z' })
    ]
    renderView()
    await screen.findByText('audit and analyze the codebase end to end')

    expect(screen.queryByTestId('delegated-task-retry')).toBeNull()
    fireEvent.click(screen.getByLabelText(/^Cancel task:/))
    await waitFor(() => expect(cancelled).toEqual(['task-1']))
  })

  it('offers neither once a stop is already in flight', async () => {
    // cancelTask refuses a second stop, so a Cancel button here would be a
    // control that silently does nothing.
    queue = [
      task({ status: 'cancelling', runId: 'run-1', startedAt: '2026-09-18T00:00:10.000Z' })
    ]
    renderView()

    expect(await screen.findByText('Stopping…')).toBeTruthy()
    expect(screen.queryByTestId('delegated-task-retry')).toBeNull()
    expect(screen.queryByLabelText(/^Cancel task:/)).toBeNull()
  })

  it('blocks retry for a task whose workspace is closed, and says why', async () => {
    // `retryTask` re-enqueues and `enqueueTask` refuses a closed workspace, so
    // an enabled Retry here is a button that reliably errors. The pane lists
    // rows from workspaces this session opened and later closed.
    queue = [
      task({
        status: 'failed',
        workspacePath: '/ws-closed',
        error: 'boom',
        finishedAt: '2026-09-18T01:00:00.000Z'
      })
    ]
    renderView()

    await screen.findByText('audit and analyze the codebase end to end')
    expect(screen.queryByTestId('delegated-task-retry')).toBeNull()
    // Disabled rather than absent — a control that vanishes reads as missing.
    const blocked = screen.getByTestId('delegated-task-retry-blocked')
    expect(blocked.getAttribute('aria-label')).toContain('is closed')
    expect((blocked as HTMLButtonElement).disabled).toBe(true)
  })

  it('still offers retry when the workspace is open under another spelling', async () => {
    // Stored paths come from `cacheKeyFor`, which need not match the open path
    // character for character.
    queue = [
      task({
        status: 'failed',
        workspacePath: '/ws-a/',
        error: 'boom',
        finishedAt: '2026-09-18T01:00:00.000Z'
      })
    ]
    renderView()

    expect(await screen.findByTestId('delegated-task-retry')).toBeTruthy()
  })

  it('surfaces a refused stop instead of swallowing it', async () => {
    window.vyotiq.tasksCancel = vi.fn(async () => ({ ok: true as const, data: false }))
    queue = [task({ status: 'running', runId: 'run-1', startedAt: '2026-09-18T00:00:10.000Z' })]
    renderView()

    fireEvent.click(await screen.findByLabelText(/^Cancel task:/))

    const alert = await screen.findByText(/there was nothing to stop/i)
    expect(alert).toBeTruthy()
  })
})

describe('teammate history', () => {
  it('keeps every finished task reachable, not just the last two', async () => {
    queue = Array.from({ length: 8 }, (_, i) =>
      task({
        id: `task-${i}`,
        prompt: `finished job ${i}`,
        status: 'done',
        finishedAt: `2026-09-18T0${i}:00:00.000Z`
      })
    )
    renderView()

    const expand = await screen.findByRole('button', { name: 'Show all 8 finished tasks' })
    expect(screen.queryByText('finished job 0')).toBeNull()

    fireEvent.click(expand)
    expect(screen.getByText('finished job 0')).toBeTruthy()
  })
})

describe('assigning work', () => {
  async function openAssign(): Promise<void> {
    renderView()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Scout' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Assign task' }))
  }

  it('blocks a brief past the cap and says so', async () => {
    await openAssign()
    const box = screen.getByPlaceholderText(/Research the top 5/)
    fireEvent.change(box, { target: { value: 'x'.repeat(MAX_DELEGATED_TASK_PROMPT_CHARS + 1) } })

    const counter = screen.getByTestId('task-prompt-length')
    expect(counter.textContent).toBe(
      `${(MAX_DELEGATED_TASK_PROMPT_CHARS + 1).toLocaleString()} / ${MAX_DELEGATED_TASK_PROMPT_CHARS.toLocaleString()} — too long to assign`
    )
    expect(box.getAttribute('aria-invalid')).toBe('true')
    const submit = screen.getAllByRole('button', { name: 'Assign task' }).at(-1) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(enqueued).toHaveLength(0)
  })

  it('accepts a brief exactly at the cap', async () => {
    await openAssign()
    fireEvent.change(screen.getByPlaceholderText(/Research the top 5/), {
      target: { value: 'y'.repeat(MAX_DELEGATED_TASK_PROMPT_CHARS) }
    })

    expect(screen.getByTestId('task-prompt-length').textContent).toBe(
      `${MAX_DELEGATED_TASK_PROMPT_CHARS.toLocaleString()} / ${MAX_DELEGATED_TASK_PROMPT_CHARS.toLocaleString()}`
    )
    const submit = screen.getAllByRole('button', { name: 'Assign task' }).at(-1) as HTMLButtonElement
    fireEvent.click(submit)

    await waitFor(() => expect(enqueued).toHaveLength(1))
    expect(pushToastMock).toHaveBeenCalledWith('Task assigned to Scout')
  })

  it('keeps the counter out of the way for an ordinary brief', async () => {
    await openAssign()
    fireEvent.change(screen.getByPlaceholderText(/Research the top 5/), {
      target: { value: 'ship it' }
    })
    expect(screen.queryByTestId('task-prompt-length')).toBeNull()
  })

  it('surfaces main reason and keeps the brief when the task is refused', async () => {
    enqueueOutcome = { ok: false, error: 'Workspace is not open' }
    await openAssign()
    fireEvent.change(screen.getByPlaceholderText(/Research the top 5/), {
      target: { value: 'ship it' }
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Assign task' }).at(-1) as HTMLElement)

    await waitFor(() =>
      expect(pushToastMock).toHaveBeenCalledWith(
        'Could not assign task — Workspace is not open',
        'error'
      )
    )
    expect((screen.getByPlaceholderText(/Research the top 5/) as HTMLTextAreaElement).value).toBe(
      'ship it'
    )
  })

  it('cannot assign work with no workspace open', async () => {
    renderView({ activeWorkspacePath: null })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Scout' })).toBeTruthy())

    expect(
      (screen.getByRole('button', { name: 'Assign task' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('cannot assign work to a teammate that belongs to another workspace', async () => {
    // The scheduler would refuse it with a bare "Unknown teammate profile".
    roster = [profile({ scope: 'workspace', workspacePath: '/ws-b' })]
    renderView({ activeWorkspacePath: '/ws-a' })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Scout' })).toBeTruthy())

    expect(
      (screen.getByRole('button', { name: 'Assign task' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })
})

describe('task inbox', () => {
  it('shows work from every teammate and every open workspace', async () => {
    roster = [profile(), profile({ id: 'ace', name: 'Ace' })]
    queue = [
      task({ id: 't1', prompt: 'scout job', workspacePath: '/ws-a' }),
      task({ id: 't2', prompt: 'ace job', profileId: 'ace', workspacePath: '/ws-b' })
    ]
    await openInbox()

    expect(await screen.findByText('scout job')).toBeTruthy()
    expect(screen.getByText('ace job')).toBeTruthy()
    // The sidebar filtered to one workspace and hid the rest.
    expect(screen.getByText('ws-b')).toBeTruthy()
  })

  it('filters the inbox down to one teammate', async () => {
    roster = [profile(), profile({ id: 'ace', name: 'Ace' })]
    queue = [
      task({ id: 't1', prompt: 'scout job' }),
      task({ id: 't2', prompt: 'ace job', profileId: 'ace' })
    ]
    await openInbox()
    await screen.findByText('scout job')

    fireEvent.click(screen.getByRole('button', { name: 'Filter by teammate' }))
    const listbox = await screen.findByRole('listbox', { name: 'Filter by teammate' })
    fireEvent.click(within(listbox).getByRole('option', { name: 'Ace' }))

    expect(screen.queryByText('scout job')).toBeNull()
    expect(screen.getByText('ace job')).toBeTruthy()
  })

  it('searches across the brief, the teammate and the workspace', async () => {
    queue = [
      task({ id: 't1', prompt: 'rewrite the pricing page' }),
      task({ id: 't2', prompt: 'upgrade the toolchain' })
    ]
    await openInbox()
    await screen.findByText('rewrite the pricing page')

    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'toolchain' } })

    expect(screen.queryByText('rewrite the pricing page')).toBeNull()
    expect(screen.getByText('upgrade the toolchain')).toBeTruthy()
  })

  it('separates work that still needs attention from work that is done', async () => {
    queue = [
      task({ id: 't1', prompt: 'live job', status: 'running', runId: 'r', startedAt: '2026-09-18T00:00:01.000Z' }),
      task({ id: 't2', prompt: 'old job', status: 'done', finishedAt: '2026-09-18T01:00:00.000Z' })
    ]
    await openInbox()

    const active = await screen.findByRole('region', { name: 'Active tasks' })
    expect(within(active).getByText('live job')).toBeTruthy()
    const finished = screen.getByRole('region', { name: 'Finished tasks' })
    expect(within(finished).getByText('old job')).toBeTruthy()
  })

  it('still names a task whose teammate has since been deleted', async () => {
    // Deleting a teammate keeps its run history; the tasks outlive the roster
    // entry, and a blank row would be a worse answer than saying so.
    roster = []
    queue = [task({ id: 't1', prompt: 'orphan job', profileId: 'ghost', status: 'done', finishedAt: '2026-09-18T01:00:00.000Z' })]
    renderView()
    fireEvent.click(await screen.findByRole('button', { name: 'All tasks' }))

    expect(await screen.findByText('orphan job')).toBeTruthy()
    expect(screen.getByText('Deleted teammate')).toBeTruthy()
  })
})
