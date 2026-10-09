/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ComingUpSection, upcomingSchedules } from '@renderer/features/home/components/ComingUpSection'
import type { TaskSchedule } from '@shared/ipc/schemas/schedules'

afterEach(cleanup)

const schedule = (id: string, over: Partial<TaskSchedule>): TaskSchedule => ({
  id: `sched-${id}-0000`,
  workspacePath: 'C:\\ws',
  instruction: `Check ${id}`,
  mode: 'agent',
  schedule: { kind: 'daily', time: '09:00' },
  enabled: true,
  nextRunAt: '2026-10-09T09:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over
})

describe('Coming up on Home', () => {
  it('lists enabled schedules of open workspaces, soonest first', () => {
    const list = upcomingSchedules(
      [
        schedule('late', { nextRunAt: '2026-10-10T09:00:00.000Z' }),
        schedule('off', { enabled: false }),
        schedule('elsewhere', { workspacePath: 'C:\\other' }),
        schedule('soon', { nextRunAt: '2026-10-08T21:00:00.000Z' })
      ],
      ['C:\\ws']
    )
    expect(list.map((s) => s.instruction)).toEqual(['Check soon', 'Check late'])
  })

  it('shows nothing without a schedule, and the next ones with one', async () => {
    window.vyotiq = { listSchedules: vi.fn(async () => ({ ok: true, data: { schedules: [] } })) } as never
    const view = render(<ComingUpSection openWorkspaces={['C:\\ws']} />)
    await Promise.resolve()
    expect(screen.queryByRole('region', { name: 'Coming up' })).toBeNull()
    view.unmount()
    window.vyotiq = {
      listSchedules: vi.fn(async () => ({ ok: true, data: { schedules: [schedule('ci', {})] } }))
    } as never
    render(<ComingUpSection openWorkspaces={['C:\\ws']} />)
    const section = await screen.findByRole('region', { name: 'Coming up' })
    expect(section.textContent).toContain('Check ci')
    expect(section.textContent).toContain('Daily')
  })
})
