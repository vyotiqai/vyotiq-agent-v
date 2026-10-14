/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'
import { TaskPane, type TaskPaneProps } from '@renderer/features/task/TaskPane'

/**
 * The run strip over the line while a run is live: what it is doing, where
 * its plan is, how long this turn has run and what it has cost — the live
 * region carries the state alone, so the ticking time is not re-read.
 */

const T0 = Date.parse('2026-10-14T09:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.setSystemTime(T0 + 95_000)
  window.vyotiq = {
    readRunArtifact: vi.fn().mockResolvedValue({ ok: true, data: { exists: false, content: '' } })
  } as unknown as typeof window.vyotiq
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const items: UiItem[] = [
  { kind: 'message', id: 'u-1', role: 'user', content: 'Fix the overflow', at: new Date(T0).toISOString() }
]

const usage = {
  steps: 2,
  stepsWithCostReport: 2,
  stepsWithEstimate: 0,
  billedCost: 0.051,
  estimatedCost: 0
} as unknown as StepUsageTotals

function pane(over: Partial<TaskPaneProps> = {}): HTMLElement {
  const props: TaskPaneProps = {
    workspacePath: '/ws',
    runId: 'r1',
    items,
    running: true,
    pendingRun: false,
    turnFailed: false,
    turnStatus: null,
    compacting: false,
    showThinking: false,
    run: null,
    onStop: vi.fn(),
    actions: {},
    messageCount: 1,
    composer: null,
    turnUsage: [usage],
    ...over
  }
  return render(<TaskPane {...props} />).container
}

describe('Run strip', () => {
  it('says what it is doing, and beside it how long this turn has run and what it has cost', () => {
    const container = pane()
    const strip = container.querySelector('[data-run-strip]')!
    expect(strip.querySelector('[role="status"]')!.textContent).toBe('Working')
    const meta = strip.querySelector('[data-run-strip-meta]')!
    expect(meta.getAttribute('aria-hidden')).toBe('true')
    expect(meta.textContent).toBe('1m 35s · $0.051')
    // The live region is the state only: Stop is not inside it.
    expect(strip.querySelector('[role="status"] button')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(meta.textContent).toBe('1m 37s · $0.051')
  })

  it('leaves the meta out when nothing has been measured yet', () => {
    const container = pane({ items: [{ ...items[0]!, at: undefined } as UiItem], turnUsage: [] })
    expect(container.querySelector('[data-run-strip-meta]')).toBeNull()
  })

  it('is not there once the run is not live', () => {
    const container = pane({ running: false, turnStatus: 'done' })
    expect(container.querySelector('[data-run-strip]')).toBeNull()
  })
})
