import type { ToolDefinition } from '../providers/types'
import { AGENT_TOOLS } from '../types'
import { estimateTextTokens } from './estimate'

/**
 * Core browse + diagnostics tools that are always present and never routed
 * through the optional-builtin pin flow. The remaining browser_* tools plus
 * merge_agent_instance are admitted out-of-band via request_mcp_tools pins.
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

/** Builtins the request_mcp_tools pin flow can admit (bookkeeping only — the step catalog already carries them). */
export const OPTIONAL_BUILTIN_NAMES = new Set([
  ...AGENT_TOOLS.map((t) => t.name).filter(
    (name) => name.startsWith('browser_') && !CORE_OPTIONAL_ALWAYS.has(name)
  ),
  'merge_agent_instance'
])

export function isOptionalBuiltinName(name: string): boolean {
  return OPTIONAL_BUILTIN_NAMES.has(name)
}

function estimateToolDefTokens(tool: ToolDefinition): number {
  try {
    return estimateTextTokens(JSON.stringify(tool))
  } catch {
    return 200
  }
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
}

/**
 * Build the step tool catalog: every builtin and connected MCP tool, always.
 * Never defers, never evicts, never returns overflow.
 */
export function buildStepToolCatalog(tools: ToolDefinition[]): StepToolCatalog {
  const estimate = tools.reduce((n, t) => n + estimateToolDefTokens(t), 0)
  return {
    ok: true,
    tools,
    estimate,
    fingerprint: toolCatalogFingerprint(tools)
  }
}
