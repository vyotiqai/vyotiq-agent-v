/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import type { DoneWhenCheck } from '@shared/doneWhenChecks'
import { buildRecordModel } from '@renderer/features/task/recordModel'
import { checksByRun } from '@renderer/features/task/record/Checks'
import { receiptParts } from '@renderer/features/task/record/Receipt'
import { TaskRecord } from '@renderer/features/task/TaskRecord'

afterEach(cleanup)

const T0 = Date.parse('2026-09-24T10:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

function check(partial: Partial<DoneWhenCheck> & Pick<DoneWhenCheck, 'id' | 'text'>): DoneWhenCheck {
  return { source: 'plan', verdict: null, createdAt: at(5), ...partial }
}

const items: UiItem[] = [
  { kind: 'message', id: 'user-0', role: 'user', content: 'Fix the swap', at: at(0) },
  {
    kind: 'tool',
    id: 't1',
    at: at(20),
    tool: {
      id: 'call-1',
      name: 'check_done_when',
      status: 'done',
      summary: '1/2 met',
      content: 'c1 met.',
      argsPreview: JSON.stringify({ checks: [{ id: 'c1', verdict: 'met', evidence: '6 passed' }] })
    }
  },
  { kind: 'message', id: 'a1', role: 'assistant', content: 'The watcher now closes before the swap.', at: at(30) }
]

const checks = [
  check({ id: 'c1', text: 'The updater suite passes', verdict: 'met', evidence: 'pnpm vitest run — 6 passed' }),
  check({ id: 'c2', text: 'No retry added around the swap' })
]

describe('done-when checks in the record', () => {
  it('keeps verdict calls out of the work', () => {
    const [run] = buildRecordModel(items, { running: false }).runs
    expect(run!.after).toEqual([])
    expect(run!.result?.text).toBe('The watcher now closes before the swap.')
  })

  it('puts each check under the run that had started when it was made', () => {
    const runs = [
      { n: 1, at: T0 },
      { n: 2, at: T0 + 60_000 }
    ]
    const byRun = checksByRun(runs, [
      check({ id: 'c1', text: 'A', createdAt: at(10) }),
      check({ id: 'c2', text: 'B', createdAt: at(70) }),
      check({ id: 'c3', text: 'Brief', source: 'brief', createdAt: at(-5) })
    ])
    expect(byRun.get(1)!.map((c) => c.id)).toEqual(['c1', 'c3'])
    expect(byRun.get(2)!.map((c) => c.id)).toEqual(['c2'])
  })

  it('shows open checks under the brief while the run is live', () => {
    const model = buildRecordModel(items.slice(0, 2), { running: true })
    render(<TaskRecord model={model} options={{ running: true }} checks={checks} messageCount={1} />)
    expect(screen.getByRole('region', { name: 'Done when' })).toBeTruthy()
    expect(screen.getByText('checked at the end')).toBeTruthy()
    expect(screen.getByText('pnpm vitest run — 6 passed')).toBeTruthy()
    expect(document.querySelector('[data-checked]')).toBeNull()
  })

  it('moves them under the result once the run ends, and counts them in the receipt', () => {
    const model = buildRecordModel(items, { running: false })
    render(<TaskRecord model={model} options={{ running: false }} checks={checks} messageCount={2} />)
    expect(screen.queryByRole('region', { name: 'Done when' })).toBeNull()
    expect(screen.getByText(/Checked · 1 of 2 done-when checks met/)).toBeTruthy()
    expect(screen.getByText('· 1 not checked')).toBeTruthy()
    expect(document.querySelector('[data-check="c2"]')?.getAttribute('data-check-verdict')).toBe('open')
    expect(screen.getByText('1/2 checks met')).toBeTruthy()
  })

  it('adds a checks part to the receipt beside the wall time', () => {
    const parts = receiptParts(null, 90_000, checks)
    expect(parts.map((p) => p.text)).toEqual(['1m 30s', '1/2 checks met'])
  })
})
