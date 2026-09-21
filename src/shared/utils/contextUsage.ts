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

/** Token + count pair for one group of tool definitions. */
export type ContextToolGroupTokens = { tokens: number; count: number }

/** Per-MCP-server slice of the active tool catalog. */
export type ContextToolGroupDetail = { serverId: string; tokens: number; toolCount: number }

/** Stable/volatile system-zone split (measured on the composed strings). */
export type ContextSystemDetail = {
  /** Harness + mode + contract + plan + rules + style + prior-session fold + join residual. */
  harness: number
  /** Durable <memory> section. */
  memory: number
  /** Volatile tail: workspace snapshot, session env, active goal, task list, run notices. */
  volatile: number
  /** == layers.system. */
  total: number
}

/** Builtin/MCP/deferred split of the step tool catalog. */
export type ContextToolsDetail = {
  builtin: ContextToolGroupTokens
  mcp: ContextToolGroupTokens
  mcpByServer: ContextToolGroupDetail[]
  /** Builtins present in the full catalog but excluded from the wire by mode/index policy. */
  deferredBuiltin: ContextToolGroupTokens
  /** MCP tools excluded from the wire: load-on-demand, or not Agent mode. */
  deferredMcp: ContextToolGroupTokens
  /** Per-server split of `deferredMcp` — what a run would pay to load each. */
  deferredMcpByServer?: ContextToolGroupDetail[]
  /** Active (sent) tool tokens — == layers.tools. */
  total: number
}

/**
 * Measured context breakdown as emitted in `context_usage` / `step_usage`
 * events. Derived window fields (autocompact buffer, free space) are computed
 * on the consumer side from `contentWindow` / `compactionTrigger` / `used`.
 */
export type ContextBreakdownDetailWire = {
  /** == layers.history (before provider-delta reconciliation). */
  messages: number
  /** Stable+volatile system minus the skills section. */
  systemPrompt: number
  /** <available_skills> section (progressive-disclosure level-1 list). */
  skills: number
  system: ContextSystemDetail
  tools: ContextToolsDetail
}

/** Consumer-side detail with derived window fields. */
export type ContextBreakdownDetail = ContextBreakdownDetailWire & {
  /** Space above the auto-compact threshold (contentWindow − compactionTrigger). */
  autocompactBuffer: number
  /** Usable tokens before auto-compact fires (compactionTrigger − used). */
  free: number
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
  detail?: ContextBreakdownDetail
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

/** Derived window fields for the detail rows (buffer + free space). */
export function deriveDetailWindowFields(
  detail: ContextBreakdownDetailWire,
  used: number,
  contentWindow: number,
  compactionTrigger: number
): ContextBreakdownDetail {
  const trigger = Math.max(0, compactionTrigger)
  const autocompactBuffer = trigger > 0 ? Math.max(0, contentWindow - trigger) : 0
  const free = trigger > 0 ? Math.max(0, trigger - used) : Math.max(0, contentWindow - used)
  return { ...detail, autocompactBuffer, free }
}

/**
 * Re-align a carried/emitted detail with freshly reconciled layers: apply the
 * same billed-vs-estimate delta the layers absorbed into history to
 * detail.messages so rows keep summing to the billed total.
 */
export function reconcileContextDetail(
  detail: ContextBreakdownDetailWire,
  rawHistory: number,
  layers: ContextLayerBreakdown,
  used: number,
  contentWindow: number,
  compactionTrigger: number
): ContextBreakdownDetail {
  const delta = layers.history - rawHistory
  const messages = Math.max(0, detail.messages + delta)
  return deriveDetailWindowFields({ ...detail, messages }, used, contentWindow, compactionTrigger)
}

export function contextUsageFromEvent(
  event: AgentEvent,
  stepUsage: StepUsageTotals = emptyStepUsageTotals(),
  /** Prior layer split when the event omits layers (estimate or provider). */
  previousLayers?: ContextLayerBreakdown | null,
  /** Prior detail when the event omits one (provider-source or older main). */
  previousDetail?: ContextBreakdownDetail | null
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
  const contentWindow = event.contentWindow ?? event.contextWindow
  let detail: ContextBreakdownDetail | undefined
  if (event.detail) {
    detail = reconcileContextDetail(
      event.detail,
      event.detail.messages,
      layers,
      used,
      contentWindow,
      event.compactionTrigger
    )
  } else if (previousDetail) {
    detail = reconcileContextDetail(
      previousDetail,
      rawLayers.history,
      layers,
      used,
      contentWindow,
      event.compactionTrigger
    )
  }
  return {
    step: event.step,
    used,
    estimatedTokens: event.estimatedTokens,
    inputTokens: event.inputTokens,
    window: event.contextWindow,
    contentWindow,
    compactionTrigger: event.compactionTrigger,
    source: event.source,
    layers,
    ...(detail ? { detail } : {}),
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
    const ctx = contextUsageFromEvent(row.event, stepUsage, latest?.layers, latest?.detail)
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
  const compactionTrigger = proactiveCompactThresholdTokens(contentWindow, triggerRatio)
  const detail = usage.detail
    ? deriveDetailWindowFields(
        usage.detail,
        usage.used,
        contentWindow,
        compactionTrigger
      )
    : undefined
  return {
    ...usage,
    window: modelWindow,
    contentWindow,
    compactionTrigger,
    layers,
    ...(detail ? { detail } : {})
  }
}
