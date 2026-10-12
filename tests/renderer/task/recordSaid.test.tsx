/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { addTurnUsage, emptyStepUsageTotals, type StepUsageTotals } from '@shared/utils/runTelemetry'
import { buildRecordModel, type BuildOptions } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { foldsToOpen, workOpenKey } from '@renderer/features/task/recordFind'
import { openWork } from './helpers/openWork'

/**
 * What you say into a run while it works (Send now) is a line in its work —
 * "You said …" where it landed — not a run of its own: the run carried on.
 */

afterEach(cleanup)

const T0 = Date.parse('2026-10-07T10:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

const items: UiItem[] = [
  { kind: 'message', id: 'user-0', role: 'user', content: 'Fix the login test', at: at(0) },
  {
    kind: 'tool',
    id: 't1',
    at: at(1),
    endedAt: at(2),
    tool: { id: 'c1', name: 'read', summary: 'src/login.ts', status: 'done', content: 'x', argsPreview: '{"path":"src/login.ts"}' }
  },
  { kind: 'message', id: 'user-2', role: 'user', content: 'Also check `retry.ts`', at: at(3), midTurn: true },
  {
    kind: 'tool',
    id: 't2',
    at: at(4),
    endedAt: at(5),
    tool: { id: 'c2', name: 'read', summary: 'src/retry.ts', status: 'done', content: 'x', argsPreview: '{"path":"src/retry.ts"}' }
  },
  { kind: 'message', id: 'a-4', role: 'assistant', content: 'Both fixed.', at: at(8) }
]

function show(options: BuildOptions) {
  const view = render(<TaskRecord model={buildRecordModel(items, options)} options={options} messageCount={5} />)
  openWork(view.container)
  return view
}

describe('a message said into a live run', () => {
  it('reads as a line in the work, between what came before and after it', () => {
    const { container } = show({ running: true })
    const said = container.querySelector('[data-record-said]')!
    expect(said.textContent).toBe('You said Also check retry.ts')
    expect(said.querySelector('code')?.textContent).toBe('retry.ts')
    // No second run, no second brief.
    expect(container.querySelector('[data-run-divider]')).toBeNull()
    expect(container.querySelectorAll('[data-brief]')).toHaveLength(1)
  })

  it('stays in the run once it answers, behind the work line', () => {
    const { container } = show({ running: false })
    expect(container.querySelector('section[aria-label="Result"]')?.textContent).toContain('Both fixed.')
    expect(container.querySelector('[data-record-said]')).not.toBeNull()
    expect([...foldsToOpen(buildRecordModel(items, { running: false }).runs, 'retry.ts')]).toContain(workOpenKey(1))
  })
})

describe('the turns a run is counted under', () => {
  it('gives work from before any instruction no turn, so the first run’s usage is not shown twice', () => {
    // A transcript window that opens mid-run: work first, then the instruction.
    const windowed: UiItem[] = [items[1]!, { ...items[2]!, midTurn: undefined } as UiItem, ...items.slice(3)]
    const { runs } = buildRecordModel(windowed, { running: false })
    expect(runs.map((r) => [r.turn, r.turns])).toEqual([
      [0, 0],
      [0, 1]
    ])
  })
})

describe('addTurnUsage', () => {
  const turn = (patch: Partial<StepUsageTotals>): StepUsageTotals => ({ ...emptyStepUsageTotals(), ...patch })

  it('sums what was billed and keeps the later turn’s window', () => {
    const a = turn({ steps: 2, inputTokens: 1_000, billedInputTokens: 1_800, outputTokens: 300, peakInputTokens: 1_000, estimatedCost: 0.02, stepsWithEstimate: 2 })
    const b = turn({ steps: 1, inputTokens: 1_400, billedInputTokens: 1_400, outputTokens: 100, peakInputTokens: 1_400, estimatedCost: 0.01, stepsWithEstimate: 1 })
    const sum = addTurnUsage(a, b)
    expect(sum.steps).toBe(3)
    expect(sum.billedInputTokens).toBe(3_200)
    expect(sum.outputTokens).toBe(400)
    expect(sum.estimatedCost).toBeCloseTo(0.03)
    expect(sum.inputTokens).toBe(1_400)
    expect(sum.peakInputTokens).toBe(1_400)
  })

  it('keeps the window of a turn that ran no step', () => {
    const a = turn({ steps: 1, inputTokens: 900 })
    expect(addTurnUsage(a, emptyStepUsageTotals()).inputTokens).toBe(900)
  })
})
