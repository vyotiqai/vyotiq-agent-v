import type { ToolDefinition } from '../providers/types'
import { AGENT_TOOLS } from '../types'
import { estimateTextTokens } from './estimate'

/**
 * Core browse + diagnostics tools that are always present and never routed
 * through the optional-builtin pin flow. The remaining browser_* tools plus
 * merge_agent_instance stay off the wire until a run asks for them
 * (request_mcp_tools with their names) or calls one — see
 * `wireBuiltinTools`. "Preload every MCP tool" sends them every step again.
 */
const CORE_OPTIONAL_ALWAYS = new Set([
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_fill',
  'browser_scroll',
  'browser_tabs',
  'diagnostics'
])

/** Builtins held back until a run asks for or calls one (~1.6k tokens a step together). */
export const OPTIONAL_BUILTIN_NAMES = new Set([
  ...AGENT_TOOLS.map((t) => t.name).filter(
    (name) => name.startsWith('browser_') && !CORE_OPTIONAL_ALWAYS.has(name)
  ),
  'merge_agent_instance',
  // Acting in the app (§24.15): loaded the first time the agent asks for or calls it.
  'app_control'
])

export function isOptionalBuiltinName(name: string): boolean {
  return OPTIONAL_BUILTIN_NAMES.has(name)
}

/**
 * The builtins that go on the wire this step: everything but the optional
 * ones the run has not admitted. `eager` (Preload every MCP tool) sends all.
 * Admission is append-only within a run, like MCP's, because the tool array
 * leads the request and any change voids the prompt cache.
 */
export function wireBuiltinTools<T extends { name: string }>(
  tools: readonly T[],
  admitted: ReadonlySet<string>,
  loading: 'on-demand' | 'eager'
): { wire: T[]; deferred: T[] } {
  if (loading === 'eager') return { wire: [...tools], deferred: [] }
  const wire: T[] = []
  const deferred: T[] = []
  for (const t of tools) {
    if (isOptionalBuiltinName(t.name) && !admitted.has(t.name)) deferred.push(t)
    else wire.push(t)
  }
  return { wire, deferred }
}

/**
 * One static line naming the held-back builtins. Static on purpose: it says
 * the same whether or not one was loaded, so admitting a tool never rewrites
 * the system prompt as well as the tool array.
 */
export function deferredBuiltinsLine(names: readonly string[], canRequest: boolean): string {
  if (names.length === 0) return ''
  const how = canRequest
    ? 'Load the ones you need with `request_mcp_tools` (`tools: [...]`), or call one directly: it runs, and stays loaded for the rest of the run.'
    : 'Call one directly: it runs, and stays loaded for the rest of the run.'
  return `<more_builtin_tools>\nMore built-in tools, held back to keep the window free unless already in your tool list: ${names.join(', ')}. ${how}\n</more_builtin_tools>`
}

/**
 * Per-definition estimate cache. A catalog rebuild measures every def twice —
 * once for the wire catalog, once for the meter's wire/deferred split — and the
 * expensive half is `JSON.stringify` over a nested JSON-Schema, which the
 * tokenizer's own text cache cannot skip because it only sees the result.
 * Keyed on the definition object, so a rebuilt catalog re-measures and a
 * discarded one is collected.
 */
const toolDefTokens = new WeakMap<ToolDefinition, number>()

/** BPE token estimate of one wire tool definition (JSON shape). */
export function estimateToolDefTokens(tool: ToolDefinition): number {
  const cached = toolDefTokens.get(tool)
  if (cached !== undefined) return cached
  let tokens: number
  try {
    tokens = estimateTextTokens(JSON.stringify(tool))
  } catch {
    tokens = 200
  }
  toolDefTokens.set(tool, tokens)
  return tokens
}

/** Stable fingerprint of the step tool catalog (names only, order-sensitive). */
export function toolCatalogFingerprint(tools: ReadonlyArray<{ name: string }>): string {
  return tools.map((t) => t.name).join('|')
}

export type StepToolCatalog = {
  ok: true
  tools: ToolDefinition[]
  estimate: number
  fingerprint: string
  /** Per-tool token estimates (same measurement as `estimate`). */
  perTool: { name: string; tokens: number }[]
}

/**
 * Build the step tool catalog: every builtin and connected MCP tool, always.
 * Never defers, never evicts, never returns overflow.
 */
export function buildStepToolCatalog(tools: ToolDefinition[]): StepToolCatalog {
  let estimate = 0
  const perTool = tools.map((t) => {
    const tokens = estimateToolDefTokens(t)
    estimate += tokens
    return { name: t.name, tokens }
  })
  return {
    ok: true,
    tools,
    estimate,
    fingerprint: toolCatalogFingerprint(tools),
    perTool
  }
}
