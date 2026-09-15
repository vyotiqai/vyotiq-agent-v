/**
 * Published model prices used to ESTIMATE run/session cost when the provider
 * does not report billing in the stream response.
 *
 * All rates are USD per 1M tokens, verified against each provider's official
 * pricing page on 2026-09-14 (see per-rule `source` comments).
 *
 * Estimates are labeled as estimates in the UI (`est.`) and never presented as
 * a provider bill. Unknown models resolve to `null` — we show token counts
 * instead of inventing cost.
 *
 * Conservative choices (documented per provider):
 * - Anthropic cache write uses the default 5-minute TTL rate (1h TTL not used).
 * - DeepSeek uses PEAK rates (upper bound; off-peak is ~50% lower).
 * - Gemini cached reads are billed at the full input rate (implicit-cache
 *   discounts and per-hour storage fees are excluded); `thoughts` tokens are
 *   billed at the verified thoughts rate where published.
 */

export interface ModelPrice {
  /** USD per 1M uncached input tokens. */
  input: number
  /** USD per 1M cached (prompt-cache read) tokens. Defaults to `input` rate. */
  cachedInput?: number
  /** USD per 1M cache-creation (write) tokens. Defaults to `input` rate. */
  cacheWrite?: number
  /** USD per 1M output tokens. */
  output: number
  /**
   * USD per 1M reasoning/thinking tokens when the provider bills them
   * separately from `output` (Gemini `thoughtsTokenCount`).
   */
  reasoning?: number
  /** Whether `reasoningTokens` is separate from `outputTokens` in usage. */
  reasoningSeparate?: boolean
}

interface PriceRule {
  /** Provider this rule applies to, or 'any' (OpenRouter-style ids). */
  provider: string
  /** Lowercase model-id prefixes, matched longest-first. */
  prefixes: string[]
  price: ModelPrice
  /** Above this many input tokens (incl. cache) the longContext rate applies. */
  longContextThreshold?: number
  longContext?: ModelPrice
  source: string
}

/**
 * Verified 2026-09-14 against:
 * - https://platform.claude.com/docs/en/about-claude/pricing (Anthropic)
 * - https://platform.openai.com/docs/pricing (OpenAI)
 * - https://ai.google.dev/gemini-api/docs/pricing (Google)
 * - https://docs.x.ai/docs/models (xAI)
 * - https://api-docs.deepseek.com/quick_start/pricing (DeepSeek)
 * - https://mistral.ai/pricing/api (Mistral)
 * - https://console.groq.com/docs/models (Groq)
 */
const RULES: PriceRule[] = [
  // ── Anthropic (cache write = 5m TTL; input excludes cached tokens) ──
  {
    provider: 'anthropic',
    prefixes: ['claude-fable-5-1', 'claude-mythos-5-1'],
    price: { input: 10, cachedInput: 0.25, cacheWrite: 12.5, output: 50 },
    source: 'platform.claude.com pricing, 2026-09-14'
  },
  {
    provider: 'anthropic',
    prefixes: ['claude-fable-5', 'claude-mythos-5'],
    price: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
    source: 'platform.claude.com pricing, 2026-09-14'
  },
  {
    provider: 'anthropic',
    prefixes: [
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-5'
    ],
    price: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 },
    source: 'platform.claude.com pricing, 2026-09-14'
  },
  {
    provider: 'anthropic',
    prefixes: ['claude-opus-4-1', 'claude-opus-4'],
    price: { input: 15, cachedInput: 1.5, cacheWrite: 18.75, output: 75 },
    source: 'platform.claude.com pricing, 2026-09-14'
  },
  {
    provider: 'anthropic',
    prefixes: ['claude-sonnet-5'],
    price: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
    source: 'platform.claude.com pricing, 2026-09-14'
  },
  {
    provider: 'anthropic',
    prefixes: ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4'],
    price: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
    source: 'platform.claude.com pricing, 2026-09-14'
  },
  {
    provider: 'anthropic',
    prefixes: ['claude-haiku-4-5'],
    price: { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 },
    source: 'platform.claude.com pricing, 2026-09-14'
  },
  {
    provider: 'anthropic',
    prefixes: ['claude-haiku-3-5'],
    price: { input: 0.8, cachedInput: 0.08, cacheWrite: 1, output: 4 },
    source: 'platform.claude.com pricing, 2026-09-14'
  },

  // ── OpenAI (cached input rate verified per model) ──
  {
    provider: 'openai',
    prefixes: ['gpt-6-astra'],
    price: { input: 10, cachedInput: 1.25, output: 30 },
    source: 'platform.openai.com/docs/pricing, 2026-09-14'
  },
  {
    provider: 'openai',
    prefixes: ['gpt-5.6-sol', 'gpt-5.6-terra'],
    price: { input: 1.25, cachedInput: 0.125, output: 10 },
    source: 'platform.openai.com/docs/pricing, 2026-09-14'
  },
  {
    provider: 'openai',
    prefixes: ['gpt-5.6-luna'],
    price: { input: 0.5, cachedInput: 0.05, output: 4 },
    source: 'platform.openai.com/docs/pricing, 2026-09-14'
  },
  {
    provider: 'openai',
    prefixes: ['gpt-5.3-codex'],
    price: { input: 1.25, cachedInput: 0.125, output: 10 },
    source: 'platform.openai.com/docs/pricing, 2026-09-14'
  },

  // ── Google Gemini (thoughts billed separately where published; cached reads
  //    conservatively billed at full input rate) ──
  {
    provider: 'gemini',
    prefixes: ['gemini-3.8-flash'],
    price: {
      input: 0.75,
      output: 3.75,
      reasoning: 0.18,
      reasoningSeparate: true
    },
    source: 'ai.google.dev/gemini-api/docs/pricing, 2026-09-14'
  },
  {
    provider: 'gemini',
    prefixes: ['gemini-3.7-flash', 'gemini-3.6-flash'],
    price: {
      input: 0.75,
      output: 3.75,
      reasoning: 0.15,
      reasoningSeparate: true
    },
    source: 'ai.google.dev/gemini-api/docs/pricing, 2026-09-14'
  },
  {
    provider: 'gemini',
    prefixes: ['gemini-3.5-flash'],
    price: { input: 1.5, output: 9, reasoningSeparate: true },
    source: 'ai.google.dev/gemini-api/docs/pricing, 2026-09-14'
  },
  {
    provider: 'gemini',
    prefixes: ['gemini-3.5-flash-lite'],
    price: { input: 0.3, output: 2.5, reasoningSeparate: true },
    source: 'ai.google.dev/gemini-api/docs/pricing, 2026-09-14'
  },
  {
    provider: 'gemini',
    prefixes: ['gemini-3.1-flash-lite'],
    price: { input: 0.25, output: 1.5, reasoningSeparate: true },
    source: 'ai.google.dev/gemini-api/docs/pricing, 2026-09-14'
  },
  {
    provider: 'gemini',
    prefixes: ['gemini-3-flash-preview'],
    price: { input: 0.5, output: 3, reasoningSeparate: true },
    source: 'ai.google.dev/gemini-api/docs/pricing, 2026-09-14'
  },
  {
    provider: 'gemini',
    prefixes: ['gemini-3.1-pro-preview', 'gemini-3.1-pro'],
    price: { input: 2, output: 12, reasoningSeparate: true },
    longContextThreshold: 200_000,
    longContext: { input: 4, output: 18, reasoningSeparate: true },
    source: 'ai.google.dev/gemini-api/docs/pricing, 2026-09-14'
  },
  {
    provider: 'gemini',
    prefixes: ['gemini-2.5-pro'],
    price: { input: 1.25, output: 10, reasoningSeparate: true },
    longContextThreshold: 200_000,
    longContext: { input: 2.5, output: 15, reasoningSeparate: true },
    source: 'ai.google.dev/gemini-api/docs/pricing, 2026-09-14'
  },
  {
    provider: 'gemini',
    prefixes: ['gemini-2.5-flash'],
    price: { input: 0.3, output: 2.5, reasoningSeparate: true },
    source: 'ai.google.dev/gemini-api/docs/pricing, 2026-09-14'
  },
  {
    provider: 'gemini',
    prefixes: ['gemini-2.5-flash-lite'],
    price: { input: 0.1, output: 0.4, reasoningSeparate: true },
    source: 'ai.google.dev/gemini-api/docs/pricing, 2026-09-14'
  },

  // ── xAI ──
  {
    provider: 'xai',
    prefixes: ['grok-4.6'],
    price: { input: 2, output: 6 },
    source: 'docs.x.ai/docs/models, 2026-09-14'
  },

  // ── DeepSeek (PEAK rates — conservative upper bound) ──
  {
    provider: 'deepseek',
    prefixes: ['deepseek-flash'],
    price: { input: 0.3, cachedInput: 0.006, output: 1.2 },
    source: 'api-docs.deepseek.com/quick_start/pricing, 2026-09-14 (peak)'
  },
  {
    provider: 'deepseek',
    prefixes: ['deepseek-v4-pro'],
    price: { input: 1.32, cachedInput: 0.044, output: 3.96 },
    source: 'api-docs.deepseek.com/quick_start/pricing, 2026-09-14 (peak)'
  },

  // ── Mistral ──
  {
    provider: 'mistral',
    prefixes: ['mistral-medium'],
    price: { input: 1.5, output: 7.5 },
    source: 'mistral.ai/pricing/api, 2026-09-14'
  },
  {
    provider: 'mistral',
    prefixes: ['mistral-large'],
    price: { input: 0.5, output: 1.5 },
    source: 'mistral.ai/pricing/api, 2026-09-14'
  },
  {
    provider: 'mistral',
    prefixes: ['mistral-small'],
    price: { input: 0.15, output: 0.6 },
    source: 'mistral.ai/pricing/api, 2026-09-14'
  },
  {
    provider: 'mistral',
    prefixes: ['codestral'],
    price: { input: 0.3, output: 0.9 },
    source: 'mistral.ai/pricing/api, 2026-09-14'
  },
  {
    provider: 'mistral',
    prefixes: ['ministral-3b'],
    price: { input: 0.1, output: 0.1 },
    source: 'mistral.ai/pricing/api, 2026-09-14'
  },
  {
    provider: 'mistral',
    prefixes: ['ministral-8b'],
    price: { input: 0.15, output: 0.15 },
    source: 'mistral.ai/pricing/api, 2026-09-14'
  },
  {
    provider: 'mistral',
    prefixes: ['ministral-14b'],
    price: { input: 0.2, output: 0.2 },
    source: 'mistral.ai/pricing/api, 2026-09-14'
  },
  {
    provider: 'mistral',
    prefixes: ['zai-glm-5-2'],
    price: { input: 1.4, cachedInput: 0.14, output: 4.4 },
    source: 'mistral.ai/pricing/api, 2026-09-14'
  },

  // ── z.ai GLM (opencode routes GLM to z.ai at published rates) ──
  {
    provider: 'opencode',
    prefixes: ['glm-5.3-flash'],
    price: { input: 0.15, cachedInput: 0.03, output: 0.5 },
    source: 'docs.z.ai/guides/overview/pricing, 2026-09-14'
  },
  {
    provider: 'opencode',
    prefixes: ['glm-5.3', 'glm-5.2'],
    price: { input: 1.4, cachedInput: 0.26, output: 4.4 },
    source: 'docs.z.ai/guides/overview/pricing, 2026-09-14'
  },

  // ── Groq ──
  {
    provider: 'groq',
    prefixes: ['gpt-oss-120b', 'openai/gpt-oss-120b'],
    price: { input: 0.15, output: 0.6 },
    source: 'console.groq.com/docs/models, 2026-09-14'
  },
  {
    provider: 'groq',
    prefixes: ['gpt-oss-20b', 'openai/gpt-oss-20b'],
    price: { input: 0.075, output: 0.3 },
    source: 'console.groq.com/docs/models, 2026-09-14'
  },
  {
    provider: 'groq',
    prefixes: ['qwen3.6-27b', 'qwen/qwen3.6-27b'],
    price: { input: 0.6, output: 3 },
    source: 'console.groq.com/docs/models, 2026-09-14'
  },
  {
    provider: 'groq',
    prefixes: ['qwen3.8-27b', 'qwen/qwen3.8-27b'],
    price: { input: 0.8, output: 4 },
    source: 'console.groq.com/docs/models, 2026-09-14'
  },

  // ── Ollama (local inference — free) ──
  {
    provider: 'ollama',
    prefixes: [''],
    price: { input: 0, output: 0 },
    source: 'local inference, no per-token billing'
  }
]

/** All rules sorted by descending prefix length so dated ids match newest rule. */
const SORTED_RULES: PriceRule[] = [...RULES].sort((a, b) => {
  const aLen = Math.max(...a.prefixes.map((p) => p.length))
  const bLen = Math.max(...b.prefixes.map((p) => p.length))
  return bLen - aLen
})

function lookup(
  provider: string,
  modelId: string
): { rule: PriceRule; prefix: string } | null {
  for (const rule of SORTED_RULES) {
    if (rule.provider !== provider) continue
    for (const prefix of rule.prefixes) {
      if (modelId.startsWith(prefix)) return { rule, prefix }
    }
  }
  return null
}

/** A model price plus long-context tier info, as resolved for one model id. */
export interface ResolvedModelPrice {
  price: ModelPrice
  /** Above this many input tokens (incl. cache) the longContext rate applies. */
  longContextThreshold?: number
  longContext?: ModelPrice
  /** Provenance of the rates (pricing page + verification date). */
  source: string
}

function toResolved(rule: PriceRule): ResolvedModelPrice {
  return {
    price: rule.price,
    ...(rule.longContextThreshold !== undefined
      ? { longContextThreshold: rule.longContextThreshold }
      : {}),
    ...(rule.longContext !== undefined ? { longContext: rule.longContext } : {}),
    source: rule.source
  }
}

/**
 * Resolve the published price for a provider + model id.
 *
 * Handles dated model ids via prefix matching and OpenRouter-style
 * `vendor/model` ids (the bare model part is matched against every provider
 * so an OpenRouter run without a provider-reported cost can still be
 * estimated). Unknown providers/models (custom endpoints, enterprise-only
 * catalogs) resolve to `null` — never a guessed price.
 */
export function resolveModelPrice(
  provider: string,
  modelId: string
): ResolvedModelPrice | null {
  const id = modelId.trim().toLowerCase()
  if (id.length === 0) return null

  const direct = lookup(provider, id)
  if (direct) return toResolved(direct.rule)

  if (provider === 'openrouter') {
    const bare = id.slice(id.indexOf('/') + 1)
    for (const rule of SORTED_RULES) {
      for (const prefix of rule.prefixes) {
        if (prefix.length > 0 && bare.startsWith(prefix)) return toResolved(rule)
      }
    }
  }
  return null
}

/** Token usage fields needed to estimate a step's cost. */
export interface PricedTokenUsage {
  inputTokens?: number
  /** Whether `inputTokens` already includes `cachedInputTokens`. */
  inputTokensIncludesCache?: boolean
  outputTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
  reasoningTokens?: number
}

/**
 * Estimate the USD cost of one usage record at published prices.
 * Returns `null` when input/output token counts are unknown.
 *
 * Math (per 1M tokens):
 * - uncached input = inputTokens (Anthropic) or inputTokens - cachedInputTokens
 * - cached reads bill at `cachedInput` (default: full input rate)
 * - cache writes bill at `cacheWrite` (default: full input rate)
 * - reasoning bills at `reasoning` only when the provider reports it separately
 *   from output (Gemini thoughts); OpenAI/Anthropic reasoning is already
 *   included in `outputTokens`.
 */
export function estimateStepCost(
  usage: PricedTokenUsage,
  resolved: ResolvedModelPrice
): number | null {
  const input = usage.inputTokens
  const output = usage.outputTokens
  if (input === undefined || !Number.isFinite(input) || input < 0) return null
  if (output === undefined || !Number.isFinite(output) || output < 0) return null

  const cached =
    usage.cachedInputTokens !== undefined &&
    Number.isFinite(usage.cachedInputTokens) &&
    usage.cachedInputTokens > 0
      ? usage.cachedInputTokens
      : 0
  const cacheWrite =
    usage.cacheCreationInputTokens !== undefined &&
    Number.isFinite(usage.cacheCreationInputTokens) &&
    usage.cacheCreationInputTokens > 0
      ? usage.cacheCreationInputTokens
      : 0

  const { price, longContextThreshold, longContext } = resolved
  const billedPrice =
    longContextThreshold !== undefined &&
    longContext !== undefined &&
    input > longContextThreshold
      ? longContext
      : price

  // When input includes cached tokens (OpenAI-compatible, Gemini), the
  // uncached share is the difference; otherwise input is already uncached.
  const uncachedInput = usage.inputTokensIncludesCache
    ? Math.max(0, input - cached)
    : input

  let cost =
    (uncachedInput / 1_000_000) * billedPrice.input +
    (cached / 1_000_000) * (billedPrice.cachedInput ?? billedPrice.input) +
    (cacheWrite / 1_000_000) * (billedPrice.cacheWrite ?? billedPrice.input) +
    (output / 1_000_000) * billedPrice.output

  if (billedPrice.reasoningSeparate) {
    const reasoning =
      usage.reasoningTokens !== undefined &&
      Number.isFinite(usage.reasoningTokens) &&
      usage.reasoningTokens > 0
        ? usage.reasoningTokens
        : 0
    cost +=
      (reasoning / 1_000_000) * (billedPrice.reasoning ?? billedPrice.output)
  }

  return cost
}
