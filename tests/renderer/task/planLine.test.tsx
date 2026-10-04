/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { TaskState } from '@renderer/lib/ui'
import { PlanLine } from '@renderer/features/task/record/RecordLayout'

afterEach(cleanup)

const steps = (...states: TaskState[]) => states.map((state, i) => ({ title: `Step ${i + 1}`, state }))

describe('the plan line in the Plan panel header', () => {
  it('draws one segment per step, in the step’s state, and says where the run is', () => {
    const { container } = render(<PlanLine steps={steps('done', 'running', 'queued', 'queued')} />)
    const line = container.querySelector('[data-plan-line]')!
    expect([...line.querySelectorAll('[data-plan-step]')].map((s) => s.getAttribute('data-plan-step'))).toEqual([
      'done',
      'running',
      'queued',
      'queued'
    ])
    expect(screen.getByRole('img', { name: 'Step 2 of 4' })).toBe(line)
    // The live step breathes; the rest hold still.
    expect(line.querySelector('[data-plan-step="running"]')!.classList.contains('animate-live')).toBe(true)
    expect(line.querySelector('[data-plan-step="done"]')!.classList.contains('animate-live')).toBe(false)
  })

  it('marks a step that needs you and a failed one apart from a done one', () => {
    const { container } = render(<PlanLine steps={steps('done', 'needs', 'failed')} />)
    const fill = (state: string) => container.querySelector(`[data-plan-step="${state}"]`)!.className
    expect(fill('needs')).toContain('bg-accent')
    expect(fill('failed')).toContain('bg-danger')
    expect(fill('done')).toContain('bg-muted')
  })

  it('draws nothing with no plan, or once every step is done', () => {
    const { container, rerender } = render(<PlanLine steps={[]} />)
    expect(container.querySelector('[data-plan-line]')).toBeNull()
    rerender(<PlanLine steps={steps('done', 'done')} />)
    expect(container.querySelector('[data-plan-line]')).toBeNull()
  })
})
