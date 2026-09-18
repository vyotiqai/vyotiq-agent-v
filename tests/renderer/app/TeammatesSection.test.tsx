// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TeammatesSection } from '@renderer/app/sidebar/TeammatesSection'
import type { AgentProfile, DelegatedTask } from '@shared/ipc'

const { useAgentProfilesMock, useDelegatedTasksMock } = vi.hoisted(() => ({
  useAgentProfilesMock: vi.fn(),
  useDelegatedTasksMock: vi.fn()
}))

vi.mock('@renderer/lib/hooks/useAgentProfiles', () => ({
  useAgentProfiles: () => useAgentProfilesMock()
}))

vi.mock('@renderer/lib/hooks/useDelegatedTasks', () => ({
  useDelegatedTasks: () => useDelegatedTasksMock()
}))

const profile: AgentProfile = {
  id: 'scout',
  name: 'Scout',
  persona: '',
  identity: '',
  tone: 'Concise',
  autoResumeOnLaunch: false,
  createdAt: '2026-09-18T00:00:00.000Z',
  updatedAt: '2026-09-18T00:00:00.000Z'
}

function task(overrides: Partial<DelegatedTask>): DelegatedTask {
  return {
    id: 'task-1',
    profileId: 'scout',
    workspacePath: '/ws-a',
    prompt: 'audit and analyze the codebase end to end',
    status: 'running',
    createdAt: '2026-09-18T00:00:00.000Z',
    ...overrides
  }
}

function setup(tasks: DelegatedTask[], onOpenTaskRun?: (path: string, runId: string) => void) {
  useAgentProfilesMock.mockReturnValue({
    profiles: [profile],
    ready: true,
    createProfile: vi.fn(),
    updateProfile: vi.fn(),
    deleteProfile: vi.fn()
  })
  useDelegatedTasksMock.mockReturnValue({
    tasks,
    enqueueTask: vi.fn(),
    cancelTask: vi.fn()
  })
  return render(<TeammatesSection activeWorkspacePath="/ws-a" onOpenTaskRun={onOpenTaskRun} />)
}

describe('TeammatesSection delegated-task rows', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('opens the session when a task with a runId is clicked', () => {
    const onOpenTaskRun = vi.fn()
    setup([task({ runId: 'run-1' })], onOpenTaskRun)

    const row = screen.getByTitle(/^Open session — audit and analyze/)
    fireEvent.click(row)
    expect(onOpenTaskRun).toHaveBeenCalledWith('/ws-a', 'run-1')
  })

  it('does not render an opener for a task that never started (no runId)', () => {
    const onOpenTaskRun = vi.fn()
    setup([task({ status: 'queued' })], onOpenTaskRun)

    expect(screen.queryByTestId('delegated-task-open')).toBeNull()
    expect(screen.getByTitle('audit and analyze the codebase end to end')).toBeTruthy()
  })

  it('renders a plain row when no opener is wired (backwards compatible)', () => {
    setup([task({ runId: 'run-2', status: 'done' })], undefined)

    expect(screen.queryByTestId('delegated-task-open')).toBeNull()
  })
})
