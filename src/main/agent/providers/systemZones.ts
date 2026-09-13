/**
 * Resolve stable vs volatile system zones for prompt-cache-friendly wire shapes.
 *
 * Anthropic already marks `systemStable` with cache_control and leaves volatile unmarked.
 * OpenAI-compat / Gemini / DeepSeek match an exact leading prefix — if the clock, snapshot,
 * or loop hints sit inside the leading system string, history after it never cache-hits
 * (see token-cost case study: flat ~2.5k cached / step). Prefer:
 *   leading system = stable instructions only
 *   trailing message = volatile session data (after history)
 */

import { wrapPromptSection } from '../promptSections'

export type ResolvedSystemZones = {
  /** Cacheable instruction prefix (harness, rules, skills metadata, …). */
  stable?: string
  /** Per-step data (clock, snapshot, memory, loop hints). */
  volatile?: string
}

export function resolveSystemZones(req: {
  system?: string
  systemStable?: string
  systemVolatile?: string
}): ResolvedSystemZones {
  const hasSplit = req.systemStable !== undefined || req.systemVolatile !== undefined
  if (hasSplit) {
    const stable = req.systemStable?.trim()
    const volatile = req.systemVolatile?.trim()
    return {
      ...(stable ? { stable } : {}),
      ...(volatile ? { volatile } : {})
    }
  }
  const combined = req.system?.trim()
  return combined ? { stable: combined } : {}
}

/**
 * Trailing live-context message. Uses `user` (not a second `system`) so strict
 * OpenAI-compat hosts that require a single leading system message still accept it.
 */
export function volatileSessionMessage(volatile: string): {
  role: 'user'
  content: string
} {
  return {
    role: 'user',
    content: wrapPromptSection('live_session', volatile)
  }
}

/** GPT-5.6+ supports explicit prompt_cache_breakpoint / prompt_cache_options. */
export function supportsExplicitPromptCache(modelId: string): boolean {
  // Official docs: GPT-5.6 and later model families.
  return /^gpt-5\.(?:[6-9]|\d{2,})(?:$|[^0-9])/i.test(modelId.trim())
}

const EXPLICIT_CACHE_BP = { mode: 'explicit' as const }

/**
 * Mark a Chat Completions message with an explicit cache breakpoint on its last text part.
 * Returns false for tool rows / unsupported shapes (caller should walk earlier messages).
 */
export function markOpenAiChatCacheBreakpoint(msg: Record<string, unknown>): boolean {
  if (msg.role === 'tool') return false
  const content = msg.content
  if (typeof content === 'string') {
    msg.content = [{ type: 'text', text: content, prompt_cache_breakpoint: EXPLICIT_CACHE_BP }]
    return true
  }
  if (!Array.isArray(content)) return false
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i]
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (p.type === 'text' && typeof p.text === 'string') {
      p.prompt_cache_breakpoint = EXPLICIT_CACHE_BP
      return true
    }
  }
  return false
}

/**
 * Mark a Responses API input item with an explicit cache breakpoint.
 * Skips function_call / function_call_output — breakpoints there are accepted but do not
 * write cache (OpenAI community reports, Jul 2026 GA).
 */
export function markResponsesCacheBreakpoint(item: Record<string, unknown>): boolean {
  if (item.type === 'function_call' || item.type === 'function_call_output') return false
  const content = item.content
  if (typeof content === 'string') {
    item.content = [
      { type: 'input_text', text: content, prompt_cache_breakpoint: EXPLICIT_CACHE_BP }
    ]
    return true
  }
  if (!Array.isArray(content)) return false
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i]
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (
      (p.type === 'input_text' || p.type === 'text') &&
      typeof p.text === 'string'
    ) {
      p.prompt_cache_breakpoint = EXPLICIT_CACHE_BP
      return true
    }
  }
  return false
}

/**
 * Place a second explicit breakpoint on the last cacheable history item (index ≥ 1),
 * so system+history can hit cache while trailing volatile session context stays uncached.
 * Index 0 is assumed to already carry the stable-prefix breakpoint.
 */
export function attachTrailingHistoryCacheBreakpoint(
  items: Array<Record<string, unknown>>,
  mark: (item: Record<string, unknown>) => boolean
): boolean {
  for (let i = items.length - 1; i >= 1; i--) {
    if (mark(items[i]!)) return true
  }
  return false
}
