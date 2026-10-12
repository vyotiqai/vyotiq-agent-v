/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { emptyStepUsageTotals, type StepUsageTotals } from '@shared/utils/runTelemetry'
import { ReceiptLine, costLabel, receiptParts } from '@renderer/features/task/record/Receipt'

afterEach(cleanup)

function usage(partial: Partial<StepUsageTotals>): StepUsageTotals {
  return { ...emptyStepUsageTotals(), ...partial }
}

/** One completed step: 2k in (1.7k cached) + 80 out over 2.5s, $0.012 billed. */
const reported = usage({
  steps: 1,
  stepsWithCacheReport: 1,
  stepsWithCostReport: 1,
  billedCost: 0.012,
  billedInputTokens: 2000,
  billedCachedInputTokens: 1700,
  outputTokens: 80,
  generationMs: 2500
})

describe('receiptParts', () => {
  it('words tokens and cache the way the chat footer words them', () => {
    const parts = receiptParts(reported, 24_000)
    const text = parts.map((p) => p.text)
    expect(text).toContain('380 tok (in+out)')
    expect(text).toContain('85% cache hit')
    expect(text.join(' · ')).not.toContain('cached')
    expect(text.join(' · ')).not.toContain(' tokens')
  })

  it('keeps the wall time, speed and cost wording it already had', () => {
    expect(receiptParts(reported, 24_000).map((p) => p.text)).toEqual([
      '24s',
      '380 tok (in+out)',
      '32 output tok/s',
      '85% cache hit',
      '$0.012'
    ])
  })
})

describe('ReceiptLine', () => {
  it('prints time and cost, keeps tokens, speed and cache for its hover, and every meaning on the sr-only text', () => {
    const startedAt = Date.parse('2026-09-25T10:00:00.000Z')
    const { container } = render(
      <ReceiptLine
        usage={reported}
        startedAt={startedAt}
        endedAt={startedAt + 24_000}
        live={false}
      />
    )
    const line = container.querySelector<HTMLElement>('[data-receipt]')!
    // What the run took and cost; the harness telemetry is the line's hover.
    const shown = [...line.querySelectorAll('[title]')].filter((el) => el !== line).map((el) => el.getAttribute('title'))
    expect(shown).toEqual(['Wall time', 'Billed by the provider'])
    expect(line.getAttribute('title')).toBe('380 tok (in+out) · 32 output tok/s · 85% cache hit')

    const meanings = [...container.querySelectorAll('.sr-only')].map((el) => el.textContent)
    expect(meanings).toEqual([
      'Wall time: ',
      'Billed by the provider: ',
      'Fresh input + output tokens: 380 tok (in+out); Output speed: 32 output tok/s; Prompt cache hits: 85% cache hit'
    ])
    // The sr-only text never joins the caption glyphs or the separators.
    expect(line.querySelectorAll('[aria-hidden="true"]').length).toBe(1)
  })

  it('keeps the hover title on each part alongside its sr-only meaning', () => {
    const parts = receiptParts(reported, 24_000)
    expect(parts.map((p) => p.title)).toEqual([
      'Wall time',
      'Fresh input + output tokens',
      'Output speed',
      'Prompt cache hits',
      'Billed by the provider'
    ])
  })
})

describe('costLabel', () => {
  it('marks an estimate, but not an estimate of nothing', () => {
    expect(costLabel({ cost: 0.012, estimated: true })).toBe('~$0.012')
    expect(costLabel({ cost: 0.012, estimated: false })).toBe('$0.012')
    // A free model's run: "~$0" on every row said nothing.
    expect(costLabel({ cost: 0, estimated: true })).toBe('$0')
  })
})
