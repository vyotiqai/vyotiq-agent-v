// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgentProfile, DelegatedTask } from '@shared/ipc'

const pushToastMock = vi.hoisted(() => vi.fn())
const enqueueTaskMock = vi.hoisted(() => vi.fn())
const cancelTaskMock = vi.hoisted(() => vi.fn())
const retryTaskMock = vi.hoisted(() => vi.fn())
const clearErrorMock = vi.hoisted(() => vi.fn())
const clearTaskErrorMock = vi.hoisted(() => vi.fn())
const useAgentProfilesMock = vi.hoisted(() => vi.fn())
const useDelegatedTasksMock = vi.hoisted(() => vi.fn())

vi.mock('@renderer/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/ui')>()),
  pushToast: pushToastMock
}))
vi.mock('@renderer/lib/hooks/useAgentProfiles', () => ({
  useAgentProfiles: () => useAgentProfilesMock()
}))
vi.mock('@renderer/lib/hooks/useDelegatedTasks', () => ({
  useDelegatedTasks: () => useDelegatedTasksMock()
}))

import { TeammatesSection } from '@renderer/app/sidebar/TeammatesSection'

/**
 * The sidebar roster is the ambient view: who exists, who is working, one
 * click to start. Creating, editing, deleting, the model pin, scope and
 * finished-task history all moved to the Teammates pane, which is why this
 * file is now about presence and live work rather than management.
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
let rosterError: string | null = null
let taskError: string | null = null

function setup(
  props: Partial<React.ComponentProps<typeof TeammatesSection>> = {}
): ReturnType<typeof render> {
  useAgentProfilesMock.mockReturnValue({
    profiles: roster,
    ready: true,
    error: rosterError,
    clearError: clearErrorMock
  })
  useDelegatedTasksMock.mockReturnValue({
    tasks: queue,
    ready: true,
    error: taskError,
    enqueueTask: enqueueTaskMock,
    cancelTask: cancelTaskMock,
    retryTask: retryTaskMock,
    clearError: clearTaskErrorMock
  })
  return render(
    <TeammatesSection
      activeWorkspacePath="/ws-a"
      onStartTeammateChat={vi.fn()}
      onOpenTaskRun={vi.fn()}
      onOpenTeammates={vi.fn()}
      {...props}
    />
  )
}

beforeEach(() => {
  roster = [profile()]
  queue = []
  rosterError = null
  taskError = null
  enqueueTaskMock.mockResolvedValue({ ok: true, task: task() })
  cancelTaskMock.mockResolvedValue(true)
  retryTaskMock.mockResolvedValue({ ok: true, task: task({ id: 'clone' }) })
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TeammatesSection roster', () => {
  it('starts a chat bound to the teammate that was clicked', () => {
    const onStartTeammateChat = vi.fn()
    setup({ onStartTeammateChat })

    fireEvent.click(screen.getByTitle('New chat with Scout'))
    expect(onStartTeammateChat).toHaveBeenCalledWith('scout')
  })

  it('opens the pane where everything else now lives', () => {
    const onOpenTeammates = vi.fn()
    setup({ onOpenTeammates })

    fireEvent.click(screen.getByLabelText('Open teammates'))
    expect(onOpenTeammates).toHaveBeenCalled()
  })

  it('refuses a teammate that belongs to another workspace instead of failing at send', () => {
    // main returns null from resolveAgentProfile outside the owning workspace,
    // so the bound chat would fail on its first send.
    roster = [profile({ scope: 'workspace', workspacePath: '/ws-b' })]
    setup({ activeWorkspacePath: '/ws-a' })

    const row = screen.getByTitle(/cannot run here/i)
    expect((row as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Assign task to Scout') as HTMLButtonElement).disabled).toBe(true)
  })

  it('cannot assign work with no workspace open', () => {
    setup({ activeWorkspacePath: null })
    expect((screen.getByLabelText('Assign task to Scout') as HTMLButtonElement).disabled).toBe(true)
  })

  it('surfaces a partial-delete warning in an alert region', () => {
    rosterError = 'Could not remove override in /ws-a'
    setup()

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Could not remove override in /ws-a')
    fireEvent.click(screen.getByLabelText('Dismiss teammate warning'))
    expect(clearErrorMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces a refused stop, which has no other route to the user', () => {
    taskError = 'That task had already finished — there was nothing to stop.'
    setup()
    expect(screen.getByRole('alert').textContent).toContain('nothing to stop')
  })

  it('shows no alert region when nothing is wrong', () => {
    setup()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('TeammatesSection live work', () => {
  it('opens the session of a task that produced a run', () => {
    const onOpenTaskRun = vi.fn()
    queue = [task({ status: 'running', runId: 'run-1', startedAt: '2026-09-18T00:00:10.000Z' })]
    setup({ onOpenTaskRun })

    fireEvent.click(screen.getByTestId('delegated-task-open'))
    expect(onOpenTaskRun).toHaveBeenCalledWith('/ws-a', 'run-1')
  })

  it('does not render an opener for a task that never started', () => {
    queue = [task()]
    setup()

    expect(screen.queryByTestId('delegated-task-open')).toBeNull()
    expect(screen.getByTitle('audit and analyze the codebase end to end')).toBeTruthy()
  })

  it('offers cancel, not retry, while a task is still running', () => {
    queue = [task({ status: 'running', runId: 'run-1', startedAt: '2026-09-18T00:00:10.000Z' })]
    setup()

    expect(screen.queryByTestId('delegated-task-retry')).toBeNull()
    fireEvent.click(screen.getByLabelText(/^Cancel task:/))
    expect(cancelTaskMock).toHaveBeenCalledWith('task-1')
  })

  it('keeps a cancelling task uncancellable and unretryable', () => {
    // cancelTask refuses a second stop, so either button would be a control
    // that silently does nothing.
    queue = [task({ status: 'cancelling', runId: 'run-1', startedAt: '2026-09-18T00:00:10.000Z' })]
    setup()

    expect(screen.getByText('Stopping…')).toBeTruthy()
    expect(screen.queryByTestId('delegated-task-retry')).toBeNull()
    expect(screen.queryByLabelText(/^Cancel task:/)).toBeNull()
  })

  it('shows why a task failed, and offers to run it again', async () => {
    queue = [
      task({
        status: 'failed',
        error: 'Teammate profile no longer exists',
        finishedAt: '2026-09-18T01:00:00.000Z'
      })
    ]
    setup()

    const failure = screen.getByTestId('delegated-task-error')
    expect(failure.textContent).toBe('Teammate profile no longer exists')
    expect(failure.className).toContain('text-danger')

    fireEvent.click(screen.getByTestId('delegated-task-retry'))
    await waitFor(() => expect(retryTaskMock).toHaveBeenCalledWith('task-1'))
    expect(pushToastMock).toHaveBeenCalledWith('Task reassigned to Scout')
  })

  it('surfaces the reason when a retry is refused', async () => {
    retryTaskMock.mockResolvedValue({ ok: false, error: 'Workspace is not open' })
    queue = [task({ status: 'failed', finishedAt: '2026-09-18T01:00:00.000Z' })]
    setup()

    fireEvent.click(screen.getByTestId('delegated-task-retry'))
    await waitFor(() =>
      expect(pushToastMock).toHaveBeenCalledWith(
        'Could not retry task — Workspace is not open',
        'error'
      )
    )
  })

  it('leaves finished work to the pane rather than showing an arbitrary slice', () => {
    // The old sidebar showed the two most recent finished tasks and hid the
    // rest, so the record of what a teammate had done was unreachable.
    queue = [
      task({ id: 'done-1', prompt: 'shipped it', status: 'done', finishedAt: '2026-09-18T01:00:00.000Z' }),
      task({ id: 'cancelled-1', prompt: 'called off', status: 'cancelled', finishedAt: '2026-09-18T02:00:00.000Z' })
    ]
    setup()

    expect(screen.queryByText('shipped it')).toBeNull()
    expect(screen.queryByText('called off')).toBeNull()
  })

  it('shows only the active workspace queue', () => {
    queue = [
      task({ id: 'here', prompt: 'local job', workspacePath: '/ws-a' }),
      task({ id: 'elsewhere', prompt: 'other job', workspacePath: '/ws-b' })
    ]
    setup({ activeWorkspacePath: '/ws-a' })

    expect(screen.getByText('local job')).toBeTruthy()
    expect(screen.queryByText('other job')).toBeNull()
  })
})

describe('TeammatesSection assign dialog', () => {
  it('assigns a brief to the teammate whose row opened it', async () => {
    setup()
    fireEvent.click(screen.getByLabelText('Assign task to Scout'))
    fireEvent.change(screen.getByPlaceholderText(/Research the top 5/), {
      target: { value: 'ship the pricing page' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Assign task' }))

    await waitFor(() =>
      expect(enqueueTaskMock).toHaveBeenCalledWith({
        profileId: 'scout',
        workspacePath: '/ws-a',
        prompt: 'ship the pricing page'
      })
    )
    expect(pushToastMock).toHaveBeenCalledWith('Task assigned to Scout')
  })

  it('surfaces main reason when the task is refused', async () => {
    enqueueTaskMock.mockResolvedValue({ ok: false, error: 'Workspace is not open' })
    setup()
    fireEvent.click(screen.getByLabelText('Assign task to Scout'))
    fireEvent.change(screen.getByPlaceholderText(/Research the top 5/), {
      target: { value: 'ship it' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Assign task' }))

    await waitFor(() =>
      expect(pushToastMock).toHaveBeenCalledWith(
        'Could not assign task — Workspace is not open',
        'error'
      )
    )
  })
})
