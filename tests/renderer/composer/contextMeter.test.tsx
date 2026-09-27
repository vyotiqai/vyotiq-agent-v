/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  ContextMeter,
  ContextMeterPanel,
  cacheHitPct
} from '@renderer/features/chat/components/composer/ContextMeter'
import type { ContextUsageState } from '@shared/utils/contextUsage'

const baseUsage: ContextUsageState = {
  step: 3,
  used: 45000,
  estimatedTokens: 44000,
  inputTokens: 45000,
  window: 128000,
  contentWindow: 89600,
  compactionTrigger: 62720,
  source: 'provider',
  layers: { system: 5000, history: 32000, tools: 7000, buffer: 19200 },
  stepUsage: {
    inputTokens: 45000,
    billedInputTokens: 120000,
    peakInputTokens: 45000,
    outputTokens: 1200,
    cachedInputTokens: 20000,
    billedCachedInputTokens: 50000,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
    steps: 3,
    stepsWithCacheReport: 3,
    billedCost: 0,
    billedCostSaved: 0,
    stepsWithCostReport: 0,
    generationMs: 0
  },
  updatedAt: '2026-01-01T12:00:00.000Z'
}

describe('ContextMeter', () => {
  it('opens a context details popover on click', () => {
    render(<ContextMeter usage={baseUsage} />)

    const trigger = screen.getByRole('button', { name: /context window 50% full/i })
    expect(trigger.getAttribute('aria-label')).toContain('50%')

    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: /context details/i })
    // The one popover surface, not a hand-made card.
    expect(dialog.classList.contains('vy-menu')).toBe(true)
    expect(dialog.classList.contains('rounded-xl')).toBe(false)
    expect(screen.getByText(/^Context$/)).toBeTruthy()
    expect(screen.getByText(/used of/)).toBeTruthy()
    expect(screen.getAllByText(/45k/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/90k/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/^Breakdown$/)).toBeTruthy()
    expect(screen.getByText(/^This run$/)).toBeTruthy()
    expect(screen.getByText(/^Completed steps$/)).toBeTruthy()
    expect(screen.getByText(/Auto-compact at 63k/i)).toBeTruthy()
    expect(screen.getByText(/Current step 3/)).toBeTruthy()
    expect(screen.queryByText(/^Telemetry$/i)).toBeNull()
    expect(screen.queryByText(/^Layers$/i)).toBeNull()
  })

  it('shows cache write in run stats when creation tokens are present', () => {
    render(
      <ContextMeter
        usage={{
          ...baseUsage,
          stepUsage: {
            ...baseUsage.stepUsage,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 8000
          }
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /context/i }))
    expect(screen.getByText(/^Cache write$/)).toBeTruthy()
    expect(screen.getByText(/^8k$/)).toBeTruthy()
  })

  it('notes estimated source in the panel subtitle', () => {
    render(
      <ContextMeter
        usage={{
          ...baseUsage,
          estimatedTokens: 5600,
          inputTokens: 5600,
          used: 5600,
          source: 'estimate'
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /context/i }))
    expect(screen.getByText(/estimated/i)).toBeTruthy()
  })

  it('shows task-boundary tip without warning chrome on the trigger', () => {
    render(
      <ContextMeter
        usage={{
          ...baseUsage,
          used: 70_451,
          contentWindow: 850_000,
          window: 1_000_000,
          stepUsage: {
            ...baseUsage.stepUsage,
            steps: 49,
            inputTokens: 70_451,
            billedInputTokens: 2_313_786,
            cachedInputTokens: 69_632,
            billedCachedInputTokens: 2_183_936
          }
        }}
      />
    )
    const trigger = screen.getByRole('button', { name: /context/i })
    expect(trigger.className).not.toMatch(/bg-warning/)
    expect(trigger.getAttribute('aria-label')).toMatch(/Long-run tip available/i)
    expect(trigger.getAttribute('aria-label')).toMatch(/70k/)
    fireEvent.click(trigger)
    expect(screen.getByText(/Long run — \/clear/i)).toBeTruthy()
  })

  it('surfaces overage when used exceeds the content budget', () => {
    render(
      <ContextMeter
        usage={{
          ...baseUsage,
          used: 909_000,
          contentWindow: 850_000,
          window: 1_000_000,
          stepUsage: {
            ...baseUsage.stepUsage,
            cachedInputTokens: 0,
            cacheCreationInputTokens: 0
          }
        }}
      />
    )
    const trigger = screen.getByRole('button', { name: /context/i })
    expect(trigger.className).toMatch(/text-danger|bg-danger/)
    expect(trigger.getAttribute('aria-label')).toMatch(/107%/)
    fireEvent.click(trigger)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toMatch(/over budget/i)
    // Status is never hue alone: the tint carries a warning glyph.
    expect(alert.querySelector('svg')).toBeTruthy()
    expect(alert.classList.contains('bg-danger-soft')).toBe(true)
  })

  it('shows content-budget headroom aligned with used of budget', () => {
    render(
      <ContextMeter
        usage={{
          ...baseUsage,
          used: 10_000,
          inputTokens: 10_000,
          window: 1_000_000,
          contentWindow: 850_000,
          compactionTrigger: 170_000,
          layers: { system: 2400, history: 4300, tools: 3500, buffer: 840_000 },
          stepUsage: {
            ...baseUsage.stepUsage,
            steps: 3,
            inputTokens: 10_000,
            billedInputTokens: 27_000,
            peakInputTokens: 10_000
          }
        }}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /context/i }))
    expect(screen.getByText(/used of/)).toBeTruthy()
    expect(screen.getAllByText(/10k/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/850k/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/840k headroom/i)).toBeTruthy()
    expect(screen.queryByText(/990k headroom/i)).toBeNull()
  })

  it('has no compact action — the instance meter is read-only', () => {
    render(<ContextMeter usage={baseUsage} />)
    fireEvent.click(screen.getByRole('button', { name: /context/i }))
    expect(screen.queryByRole('button', { name: /compact history/i })).toBeNull()
  })
})

describe('ContextMeterPanel', () => {
  it('renders compact action when handler is provided', () => {
    const calls: number[] = []
    render(
      <ContextMeterPanel
        usage={baseUsage}
        onCompact={() => calls.push(1)}
        compactMessage="Done"
      />
    )
    const compact = screen.getByRole('button', { name: /compact history/i })
    // The Button primitive: its focus ring and outlined geometry.
    expect(compact.className).toContain('focus-visible:vy-focus-ring')
    expect(compact.className).toContain('border-border')
    fireEvent.click(compact)
    expect(calls).toEqual([1])
    expect(screen.getByRole('status').textContent).toBe('Done')
  })

  it('disables compact while the agent is running', () => {
    render(<ContextMeterPanel usage={baseUsage} onCompact={() => {}} compactDisabled />)
    const compact = screen.getByRole('button', { name: /compact history/i }) as HTMLButtonElement
    expect(compact.disabled).toBe(true)
  })
})

describe('ContextMeter breakdown', () => {
  const detailUsage: ContextUsageState = {
    ...baseUsage,
    window: 1_000_000,
    contentWindow: 850_000,
    compactionTrigger: 595_000,
    used: 80_100,
    estimatedTokens: 80_000,
    inputTokens: 80_100,
    layers: { system: 5_000, history: 42_400, tools: 32_700, buffer: 0 },
    detail: {
      messages: 42_400,
      systemPrompt: 4_500,
      skills: 4_400,
      system: { harness: 3_800, memory: 700, volatile: 500, total: 5_000 },
      tools: {
        builtin: { tokens: 21_200, count: 45 },
        mcp: { tokens: 11_500, count: 12 },
        mcpByServer: [
          { serverId: 'github', tokens: 7_000, toolCount: 8 },
          { serverId: 'search', tokens: 4_500, toolCount: 4 }
        ],
        deferredBuiltin: { tokens: 3_300, count: 6 },
        deferredMcp: { tokens: 2_400, count: 5 },
        total: 32_700
      },
      autocompactBuffer: 850_000 - 595_000,
      free: 595_000 - 80_100
    }
  }

  it('renders every breakdown row with tokens and window shares', () => {
    render(<ContextMeter usage={detailUsage} />)
    fireEvent.click(screen.getByRole('button', { name: /context window/i }))
    expect(screen.getByText(/^Record$/)).toBeTruthy()
    expect(screen.getByText(/^System tools$/)).toBeTruthy()
    expect(screen.getByText(/^MCP tools$/)).toBeTruthy()
    expect(screen.getByText(/^System prompt$/)).toBeTruthy()
    expect(screen.getByText(/^Skills$/)).toBeTruthy()
    expect(screen.getByText(/^Autocompact buffer$/)).toBeTruthy()
    expect(screen.getByText(/^Free space$/)).toBeTruthy()
    expect(screen.getByText(/^Deferred sys tools$/)).toBeTruthy()
    expect(screen.getByText(/^Deferred MCP tools$/)).toBeTruthy()
    expect(screen.getByText('42k')).toBeTruthy()
    expect(screen.getByText('21k')).toBeTruthy()
    expect(screen.getByText('12k')).toBeTruthy()
    expect(screen.getByText('4.5k')).toBeTruthy()
    expect(screen.getByText('4.4k')).toBeTruthy()
    expect(screen.getByText('255k')).toBeTruthy()
    expect(screen.getByText('515k')).toBeTruthy()
    // Deferred rows show an em dash instead of a window share.
    expect(screen.getAllByText('—').length).toBe(2)
    expect(screen.getByText('4.2%')).toBeTruthy()
  })

  it('colours categories with the accent and greys, never a status hue', () => {
    render(<ContextMeter usage={detailUsage} />)
    fireEvent.click(screen.getByRole('button', { name: /context window/i }))
    for (const label of ['Record', 'System tools', 'MCP tools', 'System prompt', 'Skills']) {
      const row = screen.getByText(new RegExp(`^${label}$`)).parentElement!
      const swatch = row.querySelector('[aria-hidden]')!
      expect(swatch.className).not.toMatch(/\bbg-(warning|success|danger)\b/)
    }
  })

  it('expands MCP tools into per-server rows', () => {
    render(<ContextMeter usage={detailUsage} />)
    fireEvent.click(screen.getByRole('button', { name: /context window/i }))
    expect(screen.queryByText('github')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /MCP tools/i }))
    expect(screen.getByText('github')).toBeTruthy()
    expect(screen.getByText('search')).toBeTruthy()
    expect(screen.getByText('8 tools')).toBeTruthy()
    expect(screen.getByText('4 tools')).toBeTruthy()
    expect(screen.getByText('7k')).toBeTruthy()
    expect(screen.getAllByText('4.5k').length).toBeGreaterThanOrEqual(1)
    fireEvent.click(screen.getByRole('button', { name: /MCP tools/i }))
    expect(screen.queryByText('github')).toBeNull()
  })

  it('falls back to the legacy 3-layer split without detail', () => {
    render(<ContextMeter usage={baseUsage} />)
    fireEvent.click(screen.getByRole('button', { name: /context window/i }))
    expect(screen.getByText(/^System$/)).toBeTruthy()
    expect(screen.getByText(/^History$/)).toBeTruthy()
    expect(screen.getByText(/^Tools$/)).toBeTruthy()
    expect(screen.queryByText(/^Record$/)).toBeNull()
    expect(screen.queryByText(/^Skills$/)).toBeNull()
  })
})

describe('cacheHitPct', () => {
  it('returns null without a hit', () => {
    expect(
      cacheHitPct({
        inputTokens: 1000,
        billedInputTokens: 1000,
        peakInputTokens: 1000,
        outputTokens: 0,
        cachedInputTokens: 0,
        billedCachedInputTokens: 0,
        cacheCreationInputTokens: 100,
        reasoningTokens: 0,
        steps: 1,
        stepsWithCacheReport: 1,
        billedCost: 0,
        billedCostSaved: 0,
        stepsWithCostReport: 0,
        generationMs: 0
      })
    ).toBeNull()
  })

  it('rounds hit share of input', () => {
    expect(
      cacheHitPct({
        inputTokens: 45000,
        billedInputTokens: 45000,
        peakInputTokens: 45000,
        outputTokens: 0,
        cachedInputTokens: 20000,
        billedCachedInputTokens: 20000,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
        steps: 1,
        stepsWithCacheReport: 1,
        billedCost: 0,
        billedCostSaved: 0,
        stepsWithCostReport: 0,
        generationMs: 0
      })
    ).toBe(44)
  })
})
