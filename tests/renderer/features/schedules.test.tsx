/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DEFAULT_SETTINGS, emptySecretStatus, type RunSummary, type TaskSchedule } from '@shared/ipc'

vi.mock('@renderer/features/updates/updaterStore', () => ({
  useUpdateAnnouncement: () => ({ info: null, status: 'idle', progress: null, autoOpen: false }),
  markAnnounced: vi.fn()
}))

import { ScheduledTasksDialog } from '@renderer/features/schedules/ScheduledTasksDialog'
import { RepeatTaskDialog } from '@renderer/features/schedules/RepeatTaskDialog'
import { requestRepeatTask, requestScheduledTasks } from '@renderer/features/schedules/scheduleRequests'
import { DEFAULT_SCHEDULE_DRAFT, draftToSpec, specToDraft } from '@renderer/features/schedules/ScheduleFields'
import { useScheduledWorktreeOpener } from '@renderer/features/schedules/useScheduledWorktreeOpener'
import { Navigator, type NavigatorProps } from '@renderer/app/navigator/Navigator'
import { paletteCommands, runPaletteCommand } from '@renderer/features/commandPalette/paletteCommands'

const WS = 'C:\\work\\alpha'
const OTHER = 'C:\\work\\beta'

afterEach(cleanup)

function schedule(over: Partial<TaskSchedule> = {}): TaskSchedule {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    workspacePath: WS,
    instruction: 'Summarize open PRs',
    mode: 'agent',
    schedule: { kind: 'daily', time: '09:00' },
    enabled: true,
    nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: '2026-10-01T08:00:00.000Z',
    ...over
  }
}

function stubApi(schedules: TaskSchedule[]): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    listSchedules: vi.fn(async () => ({ ok: true as const, data: { schedules } })),
    toggleSchedule: vi.fn(async (id: string, enabled: boolean) => ({
      ok: true as const,
      data: { ...schedules.find((s) => s.id === id)!, enabled }
    })),
    runScheduleNow: vi.fn(async (id: string) => ({
      ok: true as const,
      data: {
        ...schedules.find((s) => s.id === id)!,
        lastOutcome: { kind: 'started' as const, at: new Date().toISOString(), runId: 'run-new' }
      }
    })),
    deleteSchedule: vi.fn(async () => ({ ok: true as const, data: true })),
    createSchedule: vi.fn(async (payload: { schedule: TaskSchedule['schedule'] }) => ({
      ok: true as const,
      data: schedule({ schedule: payload.schedule })
    })),
    updateSchedule: vi.fn(async (payload: Partial<TaskSchedule> & { id: string }) => ({
      ok: true as const,
      data: { ...schedules.find((s) => s.id === payload.id)!, ...payload } as TaskSchedule
    })),
    getSettings: vi.fn(async () => ({ ok: true as const, data: DEFAULT_SETTINGS })),
    secretStatus: vi.fn(async () => ({
      ok: true as const,
      data: { encryptionAvailable: true, keys: { ...emptySecretStatus(), anthropic: true, openai: true } }
    })),
    listModels: vi.fn(async () => ({ ok: true as const, data: { models: [] } })),
    onChatEvent: vi.fn(() => () => undefined)
  }
  window.vyotiq = api as unknown as typeof window.vyotiq
  return api
}

describe('Scheduled tasks list', () => {
  it('lists each schedule with when it runs, how its last turn went, and its controls', async () => {
    const api = stubApi([
      schedule({
        lastOutcome: { kind: 'started', at: new Date().toISOString(), runId: 'run-1', detail: 'Catching up a missed run from Thu' }
      }),
      schedule({
        id: 'a0000000-0000-4000-8000-000000000002',
        workspacePath: OTHER,
        instruction: 'Bump deps',
        schedule: { kind: 'weekly', days: [1, 3], time: '18:30' },
        enabled: false,
        lastOutcome: { kind: 'skipped', at: new Date().toISOString(), runId: 'run-0', detail: 'The last run was still going' }
      }),
      schedule({
        id: 'a0000000-0000-4000-8000-000000000003',
        instruction: 'Nightly',
        schedule: { kind: 'interval', minutes: 120 },
        lastOutcome: { kind: 'failed', at: new Date().toISOString(), detail: 'Workspace is not open' }
      })
    ])
    const onOpenTask = vi.fn()
    render(<ScheduledTasksDialog onOpenTask={onOpenTask} />)
    act(() => {
      expect(requestScheduledTasks()).toBe(true)
    })
    const dialog = await screen.findByRole('dialog', { name: 'Scheduled tasks' })
    await waitFor(() => expect(dialog.querySelectorAll('[data-schedule-row]')).toHaveLength(3))
    const rows = [...dialog.querySelectorAll<HTMLElement>('[data-schedule-row]')]
    expect(rows[0]!.textContent).toContain('Summarize open PRs')
    expect(rows[0]!.textContent).toContain('Daily at 09:00')
    expect(rows[0]!.textContent).toContain('next')
    // Two workspaces: each row says which.
    expect(rows[1]!.textContent).toContain('beta')
    expect(rows[1]!.textContent).toContain('Mon, Wed at 18:30')
    expect(rows[1]!.textContent).toContain('paused')
    expect(rows[1]!.querySelector('[data-schedule-outcome="skipped"]')?.textContent).toMatch(/Skipped .*still going/)
    expect(rows[2]!.querySelector('[data-schedule-outcome="failed"]')?.textContent).toMatch(/Didn’t start .*not open/)
    expect(rows[0]!.textContent).toContain('Catching up a missed run')

    // The last run opens like any task.
    fireEvent.click(within(rows[0]!).getByRole('button', { name: /^Last run/ }))
    expect(onOpenTask).toHaveBeenCalledWith(WS, 'run-1')
  })

  it('pauses, runs now (opening the new task) and deletes from the row', async () => {
    const api = stubApi([schedule()])
    const onOpenTask = vi.fn()
    render(<ScheduledTasksDialog onOpenTask={onOpenTask} />)
    act(() => void requestScheduledTasks())
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-schedule-row]')
      if (!el) throw new Error('no row')
      return el
    })
    const toggle = within(row).getByRole('switch')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(api.toggleSchedule).toHaveBeenCalledWith(schedule().id, false)
    await waitFor(() => expect(within(row).getByRole('switch').getAttribute('aria-checked')).toBe('false'))

    fireEvent.click(within(row).getByRole('button', { name: 'Run now' }))
    await waitFor(() => expect(onOpenTask).toHaveBeenCalledWith(WS, 'run-new'))
    expect(api.runScheduleNow).toHaveBeenCalledWith(schedule().id)

    act(() => void requestScheduledTasks())
    const again = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-schedule-row]')
      if (!el) throw new Error('no row')
      return el
    })
    fireEvent.click(within(again).getByRole('button', { name: /^Delete schedule/ }))
    await waitFor(() => expect(document.querySelector('[data-scheduled-empty]')).toBeTruthy())
    expect(api.deleteSchedule).toHaveBeenCalledWith(schedule().id)
  })

  it('says where new ones come from when there are none', async () => {
    stubApi([])
    render(<ScheduledTasksDialog />)
    act(() => void requestScheduledTasks())
    expect((await screen.findByText(/Nothing repeats yet/)).textContent).toContain('Repeat…')
  })
})

describe('Repeat task', () => {
  it('turns a draft into a spec, refusing what main would refuse', () => {
    expect(draftToSpec(DEFAULT_SCHEDULE_DRAFT)).toEqual({ ok: true, spec: { kind: 'daily', time: '09:00' } })
    expect(draftToSpec({ ...DEFAULT_SCHEDULE_DRAFT, kind: 'interval', minutes: '10' }).ok).toBe(false)
    expect(draftToSpec({ ...DEFAULT_SCHEDULE_DRAFT, kind: 'weekly', days: [] }).ok).toBe(false)
    expect(draftToSpec({ ...DEFAULT_SCHEDULE_DRAFT, kind: 'cron', expr: '61 * * * *' }).ok).toBe(false)
    expect(draftToSpec({ ...DEFAULT_SCHEDULE_DRAFT, kind: 'weekly', days: [3, 1] })).toEqual({
      ok: true,
      spec: { kind: 'weekly', days: [1, 3], time: '09:00' }
    })
  })

  it('asks when, previews the next run, and creates the schedule from the task', async () => {
    const api = stubApi([])
    render(<RepeatTaskDialog />)
    act(() => {
      expect(requestRepeatTask({ workspacePath: WS, runId: 'r1', title: 'Update the changelog' })).toBe(true)
    })
    const dialog = screen.getByRole('dialog', { name: 'Repeat task' })
    expect(dialog.textContent).toContain('Update the changelog')
    expect(dialog.querySelector('[data-schedule-preview]')?.textContent).toMatch(/^Next run /)

    fireEvent.click(within(dialog).getByRole('radio', { name: 'Every' }))
    const minutes = within(dialog).getByRole('spinbutton')
    fireEvent.change(minutes, { target: { value: '10' } })
    expect(dialog.querySelector('[data-schedule-preview]')?.textContent).toMatch(/At least every 15 minutes/)
    const repeat = within(dialog).getByRole('button', { name: 'Repeat' }) as HTMLButtonElement
    expect(repeat.disabled).toBe(true)
    fireEvent.change(minutes, { target: { value: '30' } })
    expect(repeat.disabled).toBe(false)
    fireEvent.click(repeat)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Repeat task' })).toBeNull())
    expect(api.createSchedule).toHaveBeenCalledWith({
      workspacePath: WS,
      fromRunId: 'r1',
      schedule: { kind: 'interval', minutes: 30 }
    })
  })
})

describe('Repeat task: model and worktree', () => {
  it('starts on the task’s model and worktree, and saves what was changed', async () => {
    const api = stubApi([])
    const scheduleSource = vi.fn(async () => ({
      ok: true as const,
      data: {
        instruction: 'Fix the flaky test',
        mode: 'agent' as const,
        provider: 'anthropic' as const,
        model: 'claude-test',
        worktreeBranch: 'vyotiq/fix-the-flaky-test',
        canWorktree: true
      }
    }))
    Object.assign(window.vyotiq, { scheduleSource })
    render(<RepeatTaskDialog />)
    act(() => void requestRepeatTask({ workspacePath: WS, runId: 'r1', title: 'Fix the flaky test' }))
    const dialog = screen.getByRole('dialog', { name: 'Repeat task' })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Model: model' }).textContent).toContain('claude-test'))
    expect(scheduleSource).toHaveBeenCalledWith(WS, 'r1')
    expect(within(dialog).getByRole('button', { name: 'Model: provider' }).textContent).toContain('Anthropic')
    const worktree = within(dialog).getByRole('checkbox', { name: 'Run each time in a new worktree' })
    expect(worktree.getAttribute('aria-checked')).toBe('true')

    // Back to the default model, and no worktree.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Model: provider' }))
    fireEvent.click(screen.getByRole('option', { name: 'Default model' }))
    fireEvent.click(worktree)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Repeat' }))
    await waitFor(() => expect(api.createSchedule).toHaveBeenCalled())
    expect(api.createSchedule).toHaveBeenCalledWith({
      workspacePath: WS,
      fromRunId: 'r1',
      schedule: { kind: 'daily', time: '09:00' },
      provider: null,
      model: null,
      worktree: false
    })
  })

  it('keeps the pin and offers no worktree outside a git repository', async () => {
    const api = stubApi([])
    Object.assign(window.vyotiq, {
      scheduleSource: vi.fn(async () => ({
        ok: true as const,
        data: { instruction: 'Tidy notes', provider: 'openai' as const, model: 'gpt-test', canWorktree: false }
      }))
    })
    render(<RepeatTaskDialog />)
    act(() => void requestRepeatTask({ workspacePath: WS, runId: 'r2', title: 'Tidy notes' }))
    const dialog = screen.getByRole('dialog', { name: 'Repeat task' })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Model: model' }).textContent).toContain('gpt-test'))
    expect(within(dialog).queryByRole('checkbox')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Repeat' }))
    await waitFor(() => expect(api.createSchedule).toHaveBeenCalled())
    expect(api.createSchedule).toHaveBeenCalledWith({
      workspacePath: WS,
      fromRunId: 'r2',
      schedule: { kind: 'daily', time: '09:00' },
      provider: 'openai',
      model: 'gpt-test'
    })
  })
})

describe('Editing a scheduled task', () => {
  it('turns a saved spec back into the fields', () => {
    expect(specToDraft({ kind: 'weekly', days: [1, 3], time: '18:30' })).toMatchObject({
      kind: 'weekly',
      days: [1, 3],
      time: '18:30'
    })
    expect(specToDraft({ kind: 'interval', minutes: 45 })).toMatchObject({ kind: 'interval', minutes: '45' })
    expect(specToDraft({ kind: 'cron', expr: '@daily' })).toMatchObject({ kind: 'cron', expr: '@daily' })
    const specs: Array<TaskSchedule['schedule']> = [
      { kind: 'daily', time: '07:15' },
      { kind: 'weekly', days: [0, 6], time: '10:00' },
      { kind: 'interval', minutes: 90 },
      { kind: 'cron', expr: '0 9 * * 1-5' }
    ]
    for (const spec of specs) {
      expect(draftToSpec(specToDraft(spec))).toEqual({ ok: true, spec })
    }
  })

  it('opens the schedule’s fields filled in, and saves the brief, mode, model, time and worktree', async () => {
    const original = schedule({
      schedule: { kind: 'weekly', days: [1, 3], time: '18:30' },
      provider: 'anthropic',
      model: 'claude-test',
      worktree: true
    })
    const api = stubApi([original])
    render(<ScheduledTasksDialog />)
    act(() => void requestScheduledTasks())
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-schedule-row]')
      if (!el) throw new Error('no row')
      return el
    })
    fireEvent.click(within(row).getByRole('button', { name: /^Edit schedule/ }))
    const dialog = screen.getByRole('dialog', { name: 'Edit schedule' })
    const brief = within(dialog).getByRole('textbox', { name: 'Instruction' }) as HTMLTextAreaElement
    expect(brief.value).toBe('Summarize open PRs')
    expect(within(dialog).getByRole('radio', { name: 'Agent' }).getAttribute('aria-checked')).toBe('true')
    expect(within(dialog).getByRole('radio', { name: 'Weekly' }).getAttribute('aria-checked')).toBe('true')
    expect(within(dialog).getByRole('button', { name: 'Monday' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(dialog).getByRole('button', { name: 'Tuesday' }).getAttribute('aria-pressed')).toBe('false')
    expect((within(dialog).getByLabelText('At') as HTMLInputElement).value).toBe('18:30')
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Model: model' }).textContent).toContain('claude-test'))
    expect(
      within(dialog).getByRole('checkbox', { name: 'Run each time in a new worktree' }).getAttribute('aria-checked')
    ).toBe('true')

    // An empty brief can't be saved.
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement
    fireEvent.change(brief, { target: { value: '   ' } })
    expect(save.disabled).toBe(true)

    fireEvent.change(brief, { target: { value: 'Summarize open PRs and issues' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Ask' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tuesday' }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Run each time in a new worktree' }))
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(api.updateSchedule).toHaveBeenCalled())
    expect(api.updateSchedule).toHaveBeenCalledWith({
      id: original.id,
      instruction: 'Summarize open PRs and issues',
      mode: 'ask',
      provider: 'anthropic',
      model: 'claude-test',
      worktree: false,
      schedule: { kind: 'weekly', days: [1, 2, 3], time: '18:30' }
    })
    // Back on the list, with the row as saved.
    const list = await screen.findByRole('dialog', { name: 'Scheduled tasks' })
    await waitFor(() => expect(list.querySelector('[data-schedule-row]')?.textContent).toContain('Summarize open PRs and issues'))
  })

  it('Cancel goes back to the list without saving; a refused save says why', async () => {
    const api = stubApi([schedule()])
    api.updateSchedule.mockResolvedValueOnce({ ok: false, error: 'A new worktree each run needs a git repository' } as never)
    render(<ScheduledTasksDialog />)
    act(() => void requestScheduledTasks())
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-schedule-row]')
      if (!el) throw new Error('no row')
      return el
    })
    fireEvent.click(within(row).getByRole('button', { name: /^Edit schedule/ }))
    let dialog = screen.getByRole('dialog', { name: 'Edit schedule' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/git repository/)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('dialog', { name: 'Scheduled tasks' })).toBeTruthy()
    fireEvent.click(within(document.querySelector<HTMLElement>('[data-schedule-row]')!).getByRole('button', { name: /^Edit/ }))
    dialog = screen.getByRole('dialog', { name: 'Edit schedule' })
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })

  it('shows a run still starting in its new worktree', async () => {
    stubApi([schedule({ worktree: true, lastOutcome: { kind: 'starting', at: new Date().toISOString(), detail: 'Making a new worktree' } })])
    render(<ScheduledTasksDialog />)
    act(() => void requestScheduledTasks())
    await waitFor(() =>
      expect(document.querySelector('[data-schedule-outcome="starting"]')?.textContent).toMatch(/^Starting .*Making a new worktree/)
    )
  })
})

describe('Opening a scheduled run’s worktree', () => {
  function Opener({ addWorkspace }: { addWorkspace: (path: string, opts: { onError: (m: string) => void }) => Promise<unknown> }) {
    useScheduledWorktreeOpener(addWorkspace)
    return null
  }

  it('opens the worktree as a workspace and tells main, or tells main why not', async () => {
    let deliver: ((request: { token: string; scheduleId: string; workspacePath: string; branch: string }) => void) | null = null
    const scheduleWorktreeOpened = vi.fn(async () => ({ ok: true as const, data: null }))
    window.vyotiq = {
      onScheduleWorktreeOpen: (handler: typeof deliver) => {
        deliver = handler
        return () => {
          deliver = null
        }
      },
      scheduleWorktreeOpened
    } as unknown as typeof window.vyotiq
    const addWorkspace = vi.fn(async (_path: string, _opts: { onError: (m: string) => void }) => ({ activePath: 'wt' }))
    const { unmount } = render(<Opener addWorkspace={addWorkspace} />)
    const token = '0b4f8a52-6a0c-4c5e-9a57-0d6c3e2b1a11'
    act(() => deliver!({ token, scheduleId: 'a0000000-0000-4000-8000-000000000001', workspacePath: 'C:\\wt\\a', branch: 'vyotiq/a' }))
    await waitFor(() => expect(scheduleWorktreeOpened).toHaveBeenCalledWith({ token }))
    expect(addWorkspace.mock.calls[0]![0]).toBe('C:\\wt\\a')

    addWorkspace.mockImplementationOnce(async (_path, opts) => {
      opts.onError('Workspace not found: C:\\wt\\b')
      return null as never
    })
    act(() => deliver!({ token, scheduleId: 'a0000000-0000-4000-8000-000000000001', workspacePath: 'C:\\wt\\b', branch: 'vyotiq/b' }))
    await waitFor(() => expect(scheduleWorktreeOpened).toHaveBeenLastCalledWith({ token, error: 'Workspace not found: C:\\wt\\b' }))
    unmount()
    expect(deliver).toBeNull()
  })
})

function run(runId: string, over: Partial<RunSummary> = {}): RunSummary {
  return { runId, status: 'done', updatedAt: new Date().toISOString(), goal: `Task ${runId}`, ...over }
}

function navProps(over: Partial<NavigatorProps> = {}): NavigatorProps {
  return {
    place: 'task',
    selected: null,
    openPaths: [WS],
    activePath: WS,
    runsByWorkspacePath: { [WS]: { runs: [run('r1')] } },
    activeRuns: [],
    activeRunsLoaded: true,
    scopePath: null,
    onScopeChange: vi.fn(),
    onNewTask: vi.fn(),
    onOpenHome: vi.fn(),
    onOpenExtensions: vi.fn(),
    onOpenUsage: vi.fn(),
    onOpenSettings: vi.fn(),
    onAddWorkspace: vi.fn(),
    onCloseWorkspace: vi.fn(),
    onLoadOlderRuns: vi.fn(),
    onDismissRunsError: vi.fn(),
    rowActions: { onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn() },
    notifications: {
      items: [],
      unreadCount: 0,
      onMarkRead: vi.fn(),
      onDismiss: vi.fn(),
      onOpenItem: vi.fn(),
      onOpenSettings: vi.fn()
    },
    widthPx: 264,
    ...over
  }
}

describe('Scheduled runs in the navigator and the palette', () => {
  it('marks a scheduled run with the repeat icon, says so to assistive tech, and offers Repeat… on every row', () => {
    const onRepeat = vi.fn()
    render(
      <Navigator
        {...navProps({
          runsByWorkspacePath: {
            [WS]: {
              runs: [
                run('sched', { scheduled: { scheduleId: 'a0000000-0000-4000-8000-000000000001', label: 'Daily at 09:00' } }),
                run('plain')
              ]
            }
          },
          rowActions: { onSelect: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onRepeat }
        })}
      />
    )
    const scheduled = screen.getByRole('button', { name: /^Task sched/ })
    expect(scheduled.querySelector('[data-row-scheduled]')).toBeTruthy()
    const describedBy = scheduled.getAttribute('aria-describedby')!
    expect(document.getElementById(describedBy)?.textContent).toContain('Repeats: Daily at 09:00')
    const plain = screen.getByRole('button', { name: /^Task plain/ })
    expect(plain.querySelector('[data-row-scheduled]')).toBeNull()

    fireEvent.contextMenu(plain)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Repeat…' }))
    expect(onRepeat).toHaveBeenCalledWith(WS, 'plain', 'Task plain')
  })

  it('opens the list from the View menu and from the palette', async () => {
    stubApi([schedule()])
    render(
      <>
        <Navigator {...navProps()} />
        <ScheduledTasksDialog />
      </>
    )
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Scheduled tasks…' }))
    expect(await screen.findByRole('dialog', { name: 'Scheduled tasks' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Scheduled tasks' })).toBeNull())

    const commands = paletteCommands({ workspaces: [WS], activePath: WS, canSendFeedback: false })
    expect(commands.find((c) => c.id === 'scheduledTasks')?.title).toBe('Scheduled tasks')
    act(() =>
      runPaletteCommand('scheduledTasks', {
        workspaces: [WS],
        onOpenSettings: vi.fn(),
        onOpenHome: vi.fn(),
        onOpenUsage: vi.fn(),
        onNewTask: vi.fn(),
        onToggleNavigator: vi.fn(),
        onNextNeedsYou: vi.fn(),
        onSwitchWorkspaceByIndex: vi.fn(),
        onFocusInstructionLine: vi.fn(),
        onOpenSettingsField: vi.fn()
      })
    )
    expect(await screen.findByRole('dialog', { name: 'Scheduled tasks' })).toBeTruthy()
  })
})
