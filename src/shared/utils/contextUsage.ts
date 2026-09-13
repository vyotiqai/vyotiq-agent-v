import type { AgentEvent, PersistedEvent } from '../ipc'
import { isAgentEvent } from './eventUtils'
import {
  contentWindowFromRaw,
  proactiveCompactThresholdTokens,
  remainingContentTokens
} from '../domain/contextBudget'
import {
  emptyStepUsageTotals,
  mergeStepUsageTotals,
  stepUsageFromEvent,
  type StepUsageTotals
} from './runTelemetry'

export type ContextLayerBreakdown = {
  system: number
  history: number
  tools: number
  buffer: number
}

export type ContextUsageState = {
  step: number
  used: number
  estimatedTokens: number
  inputTokens?: number
  window: number
  contentWindow: number
  compactionTrigger: number
  source: 'estimate' | 'provider'
  layers: ContextLayerBreakdown
  stepUsage: StepUsageTotals
  updatedAt: string
  /** True when context still exceeds the model window after compaction. */
  overflow?: boolean
}

const EMPTY_LAYERS: ContextLayerBreakdown = {
  system: 0,
  history: 0,
  tools: 0,
  buffer: 0
}

/**
 * Align layer splits with the billed total and derive buffer from the content budget.
 * Provider input often differs from local estimates; absorb the delta into history.
 */
export function reconcileContextLayers(
  layers: ContextLayerBreakdown,
  used: number,
  rawWindow: number,
  contentWindow?: number
): ContextLayerBreakdown {
  const system = Math.max(0, layers.system)
  const tools = Math.max(0, layers.tools)
  let history = Math.max(0, layers.history)
  const contentSum = system + history + tools
  const billed = Math.max(0, Number.isFinite(used) ? used : 0)

  if (contentSum > 0 && billed > 0 && billed !== contentSum) {
    history = Math.max(0, history + (billed - contentSum))
  } else if (contentSum <= 0 && billed > 0) {
    history = billed
  }

  const measured = system + history + tools
  const budget =
    contentWindow && contentWindow > 0 ? contentWindow : contentWindowFromRaw(rawWindow)
  return {
    system,
    history,
    tools,
    buffer: remainingContentTokens(budget, measured > 0 ? measured : billed)
  }
}

export function contextUsageFromEvent(
  event: AgentEvent,
  stepUsage: StepUsageTotals = emptyStepUsageTotals(),
  /** Prior layer split when the event omits layers (estimate or provider). */
  previousLayers?: ContextLayerBreakdown | null
): ContextUsageState | null {
  if (event.type !== 'context_usage') return null
  const used = event.inputTokens ?? event.estimatedTokens
  const rawLayers = event.layers ?? previousLayers ?? EMPTY_LAYERS
  const layers = reconcileContextLayers(
    rawLayers,
    used,
    event.contextWindow,
    event.contentWindow
  )
  return {
    step: event.step,
    used,
    estimatedTokens: event.estimatedTokens,
    inputTokens: event.inputTokens,
    window: event.contextWindow,
    contentWindow: event.contentWindow ?? event.contextWindow,
    compactionTrigger: event.compactionTrigger,
    source: event.source,
    layers,
    stepUsage,
    updatedAt: new Date().toISOString(),
    ...(event.overflow ? { overflow: true } : {})
  }
}

export function summarizeContextUsageFromEvents(
  events: PersistedEvent[]
): ContextUsageState | null {
  let stepUsage = emptyStepUsageTotals()
  let latest: ContextUsageState | null = null

  for (const row of events) {
    if (!isAgentEvent(row.event)) continue
    const usage = stepUsageFromEvent(row.event)
    if (usage) stepUsage = mergeStepUsageTotals(stepUsage, usage)
    const ctx = contextUsageFromEvent(row.event, stepUsage, latest?.layers)
    if (ctx) {
      latest = { ...ctx, stepUsage, updatedAt: row.at }
    }
  }

  return latest
}

/**
 * Re-align window / content budget / buffer / compaction trigger to the real
 * model window while keeping measured usage layers. Fixes meters that hydrated
 * from older runs that stored the 128k fallback.
 */
export function alignContextUsageToModelWindow(
  usage: ContextUsageState,
  modelWindow: number
): ContextUsageState {
  if (!Number.isFinite(modelWindow) || modelWindow <= 0 || modelWindow === usage.window) {
    return usage
  }
  const contentWindow = contentWindowFromRaw(modelWindow)
  const oldContent =
    usage.contentWindow > 0 ? usage.contentWindow : contentWindowFromRaw(usage.window)
  const triggerRatio = usage.compactionTrigger / Math.max(1, oldContent)
  const layers = reconcileContextLayers(usage.layers, usage.used, modelWindow, contentWindow)
  return {
    ...usage,
    window: modelWindow,
    contentWindow,
    compactionTrigger: proactiveCompactThresholdTokens(contentWindow, triggerRatio),
    layers
  }
}
