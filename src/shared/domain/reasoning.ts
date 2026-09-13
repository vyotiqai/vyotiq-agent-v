import { z } from 'zod'
import type { ChatMessage, ProviderId } from '../ipc'
import {
  ThinkingApiSchema,
  ThinkingEffortSchema,
  ThinkingModeSchema,
  type ThinkingApi,
  type ThinkingEffort,
  type ThinkingMode
} from '../ipc/schemas/providers'
import { normalizeModelIdForHeuristics } from './serviceTier'
import { opencodeGoTransportFor } from './opencodeGoCatalog'

export {
  ThinkingApiSchema,
  ThinkingEffortSchema,
  ThinkingModeSchema,
  type ThinkingApi,
  type ThinkingEffort,
  type ThinkingMode
}
export { normalizeModelIdForHeuristics }

export const ThinkingConfigSchema = z.object({
  enabled: z.boolean(),
  effort: ThinkingEffortSchema.optional(),
  maxTokens: z.number().int().positive().optional(),
  display: z.enum(['summarized', 'omitted']).optional()
})
export type ThinkingConfig = z.infer<typeof ThinkingConfigSchema>

const AnthropicThinkingBlockSchema = z.object({
  type: z.enum(['thinking', 'redacted_thinking']),
  thinking: z.string().optional(),
  data: z.string().optional()
})

const OpenAiResponsesStateSchema = z.object({
  kind: z.literal('openai_responses'),
  responseId: z.string().optional(),
  outputItems: z.array(z.unknown())
})

const GeminiInteractionsStateSchema = z.object({
  kind: z.literal('gemini_interactions'),
  interactionId: z.string().optional(),
  thoughtSteps: z.array(z.unknown()).optional()
})

const AnthropicReasoningStateSchema = z.object({
  kind: z.literal('anthropic'),
  blocks: z.array(AnthropicThinkingBlockSchema)
})

/**
 * Stored Mistral-style ThinkChunk for multi-turn replay.
 * `text` is flattened for UI / reasoningContent; `thinking` preserves full inner
 * parts (TextChunk / ToolReference / Reference) when the API sent them.
 */
export const OpenAiCompatThinkChunkSchema = z.object({
  text: z.string(),
  signature: z.string().optional(),
  closed: z.boolean().optional(),
  /** Full inner `thinking[]` parts; omit for legacy flat-only state. */
  thinking: z.array(z.record(z.string(), z.unknown())).optional()
})
export type OpenAiCompatThinkChunk = z.infer<typeof OpenAiCompatThinkChunkSchema>

const OpenAiCompatReasoningStateSchema = z.object({
  kind: z.literal('openai_compat'),
  reasoningContent: z.string().optional(),
  reasoningDetails: z.unknown().optional(),
  /**
   * Wire shape used when the model emitted reasoning.
   * `think_chunks` = Mistral-style ThinkChunk arrays in `content`.
   * `reasoning_content` = DeepSeek/OpenAI-compat string field.
   */
  reasoningFormat: z.enum(['think_chunks', 'reasoning_content']).optional(),
  /** Structured ThinkChunks when `reasoningFormat` is `think_chunks` (preserves signature / layout). */
  thinkChunks: z.array(OpenAiCompatThinkChunkSchema).optional()
})

export const ProviderReasoningStateSchema = z.discriminatedUnion('kind', [
  OpenAiResponsesStateSchema,
  GeminiInteractionsStateSchema,
  AnthropicReasoningStateSchema,
  OpenAiCompatReasoningStateSchema
])
export type ProviderReasoningState = z.infer<typeof ProviderReasoningStateSchema>

export type AnthropicThinkingBlock = z.infer<typeof AnthropicThinkingBlockSchema>

/**
 * Ollama model family without tag / cloud size suffix.
 * `gpt-oss:120b-cloud` → `gpt-oss`; `deepseek-v3.1:671b-cloud` → `deepseek-v3.1`.
 */
export function ollamaModelFamily(id: string): string {
  const core = normalizeModelIdForHeuristics(id).toLowerCase()
  const colon = core.indexOf(':')
  return colon >= 0 ? core.slice(0, colon) : core
}

/**
 * Strip a trailing Ollama Cloud source tag (`:cloud` or `-cloud`).
 * `gpt-oss:120b-cloud` → `gpt-oss:120b`; `glm-5.1:cloud` → `glm-5.1`.
 */
export function ollamaIdWithoutCloudSuffix(id: string): string {
  const trimmed = id.trim()
  return /[:-]cloud$/i.test(trimmed) ? trimmed.slice(0, -6) : trimmed
}

/** Cloud vs local pulled ids refer to the same family SKU. */
export function ollamaModelIdsMatch(a: string, b: string): boolean {
  if (a === b) return true
  return (
    ollamaIdWithoutCloudSuffix(a).toLowerCase() === ollamaIdWithoutCloudSuffix(b).toLowerCase()
  )
}

export function findOllamaCatalogModel<T extends { id: string }>(
  models: readonly T[],
  id: string
): T | undefined {
  const exact = models.find((m) => m.id === id)
  if (exact) return exact
  return models.find((m) => ollamaModelIdsMatch(m.id, id))
}

/** GPT-OSS on Ollama uses `think: "low"|"medium"|"high"` and cannot fully disable. */
export function isOllamaGptOssModel(id: string): boolean {
  return /^gpt-oss/i.test(ollamaModelFamily(id))
}

/**
 * Ollama chat / OpenAI-compat think|reasoning_effort levels (OpenAPI enum).
 * Catalog rows do not publish per-model lists — use this protocol set when
 * live `capabilities` includes `thinking`.
 */
export const OLLAMA_THINKING_EFFORTS: ThinkingEffort[] = ['low', 'medium', 'high', 'max']

/** GPT-OSS rejects `none` and `max`; only low|medium|high. */
export const OLLAMA_GPT_OSS_THINKING_EFFORTS: ThinkingEffort[] = ['low', 'medium', 'high']

/**
 * Offline seed defaults when a model is known to think but catalog has not
 * been fetched yet. GPT-OSS cannot disable and has no `max`.
 */
export function ollamaThinkingHeuristicFields(id?: string): {
  thinkingMode: ThinkingMode
  thinkingCanDisable: boolean
  supportedThinkingEfforts: ThinkingEffort[]
  thinkingDefaultEffort: ThinkingEffort
} {
  if (id && isOllamaGptOssModel(id)) {
    return {
      thinkingMode: 'effort',
      thinkingCanDisable: false,
      supportedThinkingEfforts: [...OLLAMA_GPT_OSS_THINKING_EFFORTS],
      thinkingDefaultEffort: 'medium'
    }
  }
  return {
    thinkingMode: 'effort',
    thinkingCanDisable: true,
    supportedThinkingEfforts: [...OLLAMA_THINKING_EFFORTS],
    thinkingDefaultEffort: 'medium'
  }
}

/** Map product effort → Ollama `think` string levels. */
export function normalizeEffortForOllamaThink(
  effort?: ThinkingEffort,
  allowed?: readonly ThinkingEffort[]
): 'low' | 'medium' | 'high' | 'max' {
  let candidate: ThinkingEffort
  switch (effort) {
    case 'minimal':
      candidate = 'low'
      break
    case 'xhigh':
    case 'max':
      candidate = allowed?.includes('max') ? 'max' : 'high'
      break
    case 'low':
    case 'medium':
    case 'high':
      candidate = effort
      break
    default:
      candidate = 'medium'
  }
  const e = coerceEffortToAllowed(candidate, allowed, 'medium')
  if (e === 'low' || e === 'medium' || e === 'high' || e === 'max') return e
  if (e === 'minimal') return 'low'
  return 'high'
}

/**
 * DeepSeek chat models that use first-party `thinking: { type }` + `reasoning_effort`
 * (also expected on OpenAI-compat hosts serving those SKUs, e.g. DeepInfra).
 */
export function isDeepSeekNativeThinkingModel(id: string): boolean {
  const core = normalizeModelIdForHeuristics(id).toLowerCase()
  return /deepseek-v4|deepseek-reasoner|deepseek-r1|deepseek-v3(\.\d+)?/i.test(core)
}

/**
 * Shared reasoner id families (OpenAI / Anthropic / Gemini / DeepSeek / xAI / local compat).
 * Used by custom + first-party providers; mistral keeps a narrower allowlist.
 */
export function sharedThinkingModelMatch(id: string): boolean {
  const core = normalizeModelIdForHeuristics(id).toLowerCase()
  const family = ollamaModelFamily(id)
  // OpenAI-family (incl. o1 Responses)
  if (/^o1(-|$)|^o[34](-|$)|^gpt-5|^gpt-5\.|gpt-4\.1-mini.*high/i.test(core)) return true
  // Anthropic: covers claude-sonnet-* and legacy claude-3-7-sonnet-*
  if (/claude-.*(opus|sonnet|haiku|fable|mythos)/i.test(core)) return true
  // Gemini
  if (/gemini-(2\.5|3(\.\d+)?|3-pro|3\.5)/i.test(core)) return true
  // DeepSeek (v4 / reasoner / r1 / v3.x)
  if (isDeepSeekNativeThinkingModel(id)) return true
  // xAI
  if (/grok-[34]/i.test(core)) return true
  // Local / OpenAI-compat reasoners
  if (/gpt-oss|qwen3|qwq|magistral|kimi/i.test(core)) return true
  if (/(^|[^a-z])r1([^a-z]|$)|reason|think/i.test(core)) return true
  if (/^gpt-oss|^qwen3|^qwq|^magistral|^kimi/i.test(family)) return true
  if (/(r1|reason|think|qwq)/i.test(family)) return true
  // Current Ollama Cloud thinking families (docs.ollama.com/search?c=thinking)
  if (/^glm-|\/glm-/i.test(core) || /^glm-/i.test(family)) return true
  if (/^gemma4|^gemma-4/i.test(core) || /^gemma4|^gemma-4/i.test(family)) return true
  if (/^minimax/i.test(core) || /^minimax/i.test(family)) return true
  // Mistral reasoning SKUs (also used by shared / openrouter paths)
  if (/^mistral-small|^magistral|mistral-medium-3/i.test(core)) return true
  return false
}

function mistralThinkingModelMatch(id: string): boolean {
  const core = normalizeModelIdForHeuristics(id).toLowerCase()
  // Docs: reasoning_effort on mistral-small / mistral-medium-3.5; magistral (deprecated native).
  if (/^magistral/i.test(core)) return true
  if (/^mistral-small/i.test(core)) return true
  if (/mistral-medium-3/i.test(core)) return true
  return false
}

/**
 * Catalog `supportsThinking: false` only blocks unknown ids.
 * Known reasoner families still allow thinking (incomplete host catalogs).
 * Catalog true / missing do not block.
 */
export function catalogThinkingAllowed(
  modelId: string,
  supportsThinking: boolean | undefined | null
): boolean {
  if (supportsThinking === false) return sharedThinkingModelMatch(modelId)
  return true
}

/** Heuristic: whether a model id likely supports extended thinking. */
export function modelSupportsThinking(id: string, providerId?: ProviderId): boolean {
  const lower = id.toLowerCase()
  switch (providerId) {
    case 'custom':
      // Prefer catalog `supportsThinking`; shared families only for known reasoners.
      return sharedThinkingModelMatch(id)
    case 'openrouter':
      return sharedThinkingModelMatch(id) || /thinking|reason/i.test(lower)
    case 'groq':
      return sharedThinkingModelMatch(id)
    case 'mistral':
      return mistralThinkingModelMatch(id)
    case 'ollama':
      // Shared families + documented Ollama think tags (v3.2+ covered by deepseek-v3(\.\d+)?).
      return sharedThinkingModelMatch(id)
    case 'openai':
    case 'anthropic':
    case 'gemini':
    case 'deepseek':
    case 'xai':
    case undefined:
      return sharedThinkingModelMatch(id)
    case 'opencode':
      // The models.dev `opencode-go` registry marks every Go model
      // reasoning-capable (`reasoning: true`, all 29 entries).
      return true
    default: {
      const _exhaustive: never = providerId
      void _exhaustive
      return sharedThinkingModelMatch(id)
    }
  }
}

/** Map provider + model to the official thinking API surface. */
export function thinkingApiFor(
  id: string,
  providerId: ProviderId,
  opts?: { affirmed?: boolean }
): ThinkingApi | undefined {
  // When catalog already set supportsThinking, skip the second heuristic gate.
  if (!opts?.affirmed && !modelSupportsThinking(id, providerId)) return undefined
  switch (providerId) {
    case 'openai':
      return 'responses'
    case 'gemini':
      return 'interactions'
    case 'anthropic':
      return 'messages'
    case 'deepseek':
    case 'openrouter':
    case 'groq':
    case 'xai':
    case 'mistral':
    case 'ollama':
    case 'custom':
      return 'chat_completions'
    case 'opencode': {
      // Each Go model uses the thinking surface of its routed endpoint.
      const transport = opencodeGoTransportFor(id)
      if (transport === 'responses') return 'responses'
      if (transport === 'messages') return 'messages'
      return 'chat_completions'
    }
    default: {
      const _exhaustive: never = providerId
      void _exhaustive
      return undefined
    }
  }
}

/**
 * Anthropic adaptive thinking + output_config.effort (4.6+, 5.x, Fable/Mythos).
 * Prefer ModelInfo.thinkingMode === 'adaptive' when catalog provides it.
 */
export function anthropicUsesAdaptiveThinking(modelId: string): boolean {
  const m = modelId.toLowerCase()
  if (/claude-(fable-5|mythos|opus-5|sonnet-5)/i.test(m)) return true
  // Opus/Sonnet 4.6, 4.7, 4.8 (hyphen or dotted)
  if (/claude-(opus|sonnet)-4[.-]([6-9]|\d{2,})/i.test(m)) return true
  if (/claude-(opus|sonnet)-4-[6-9]/i.test(m)) return true
  return false
}

/** Anthropic manual budget_tokens mode for older Claude models (pre-4.6). */
export function anthropicUsesManualThinking(modelId: string): boolean {
  if (!modelSupportsThinking(modelId, 'anthropic')) return false
  return !anthropicUsesAdaptiveThinking(modelId)
}

/** Clamp product effort to Anthropic output_config.effort (no minimal). */
export function normalizeEffortForAnthropic(effort?: ThinkingEffort): string {
  if (!effort || effort === 'minimal') return 'low'
  return effort
}

/** Map product effort → legacy Anthropic budget_tokens. */
export function anthropicBudgetTokensForEffort(effort?: ThinkingEffort): number {
  switch (effort) {
    case 'minimal':
    case 'low':
      return 2_048
    case 'high':
      return 16_384
    case 'xhigh':
    case 'max':
      return 32_768
    case 'medium':
    default:
      return 8_192
  }
}

/** DeepSeek reasoning_effort: low | high | max (+ none via thinking disabled). */
export function normalizeEffortForDeepSeek(effort?: ThinkingEffort): string {
  switch (effort) {
    case 'minimal':
    case 'low':
      return 'low'
    case 'xhigh':
    case 'max':
      return 'max'
    case 'medium':
    case 'high':
    default:
      return 'high'
  }
}

/** Pick effort allowed by catalog; fall back to preferred then medium. */
export function coerceEffortToAllowed(
  effort: ThinkingEffort | undefined,
  allowed: readonly ThinkingEffort[] | undefined,
  fallback: ThinkingEffort = 'medium'
): ThinkingEffort {
  const preferred = effort ?? fallback
  if (!allowed || allowed.length === 0) return preferred
  if (allowed.includes(preferred)) return preferred
  const order: ThinkingEffort[] = ['medium', 'high', 'low', 'minimal', 'xhigh', 'max']
  for (const e of order) {
    if (allowed.includes(e)) return e
  }
  return allowed[0]!
}

export function parseProviderReasoningState(value: unknown): ProviderReasoningState | undefined {
  const parsed = ProviderReasoningStateSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** CJK ideographs + kana. */
const CJK_CHAR = '[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af]'
/** ASCII path/identifier char glued directly to a CJK char, either order. */
const SCRIPT_SUTURE = new RegExp(
  `[A-Za-z0-9\\\\/:._~\\-]${CJK_CHAR}|${CJK_CHAR}[A-Za-z0-9\\\\/:._~\\-]`
)

/**
 * Detect a script-corrupted reasoning block: a mostly-Latin stream with ≥2
 * distinct points where CJK characters are sutured directly onto ASCII
 * identifier characters (the signature of a mid-stream script glitch).
 * Majority-CJK streams are never flagged, so legitimate CJK reasoning passes.
 */
export function isScriptCorruptedReasoning(text: string | undefined | null): boolean {
  if (!text) return false
  const cjk = text.match(new RegExp(CJK_CHAR, 'g'))
  if (!cjk || cjk.length === 0) return false
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0
  if (cjk.length > latin) return false
  let sutures = 0
  let lastEnd = -2
  const re = new RegExp(SCRIPT_SUTURE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    // Count non-adjacent suture points only (one glitch burst = one point).
    if (m.index > lastEnd + 1) sutures++
    lastEnd = m.index + m[0].length - 2
    if (m.index === re.lastIndex) re.lastIndex++
    if (sutures >= 2) return true
  }
  return false
}

/**
 * Display text derived from the stored provider reasoning payload — the single
 * copy the agent persists. Mirrors each mapper's replay field:
 *
 * - openai_compat: `reasoningContent`, else flattened `thinkChunks[].text`
 *   (ThinkChunk.text is itself the flattening of `thinking[]` inners, so the
 *   flat field and the chunks never disagree in content).
 * - anthropic: `thinking` blocks (redacted blocks have no display text).
 * - openai_responses / gemini_interactions: encrypted / opaque provider payloads;
 *   they carry no recoverable text, so nothing is derived (assistant `thinking`
 *   remains authoritative for those messages when present).
 *
 * Returns undefined when the state yields no text, so callers can fall back.
 */
export function thinkingFromReasoningState(
  state: ProviderReasoningState | undefined
): string | undefined {
  if (!state) return undefined
  switch (state.kind) {
    case 'openai_compat': {
      const flat = state.reasoningContent?.trim()
      if (flat) return state.reasoningContent
      if (Array.isArray(state.thinkChunks) && state.thinkChunks.length > 0) {
        const text = state.thinkChunks
          .map((c) => c.text ?? '')
          .join('')
          .trim()
        if (text) return text
      }
      return undefined
    }
    case 'anthropic': {
      const text = state.blocks
        .filter((b): b is { type: 'thinking'; thinking: string } =>
          b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim() !== '')
        .map((b) => b.thinking)
        .join('\n\n')
        .trim()
      return text || undefined
    }
    case 'openai_responses':
    case 'gemini_interactions':
      return undefined
  }
}

/**
 * Quarantine a script-corrupted reasoning payload: replace the glitched
 * openai_compat block with a clean stub so neither the wire nor display
 * re-serves the corruption (replayed reasoning self-conditions later steps).
 * Anthropic thinking blocks are structured provider output and pass through
 * unchanged — sanitizing them would desync the required thinking-block chain.
 */
export function quarantineReasoningState(
  state: ProviderReasoningState | undefined
): ProviderReasoningState | undefined {
  if (!state || state.kind !== 'openai_compat') return state
  const corrupted =
    isScriptCorruptedReasoning(state.reasoningContent) ||
    (Array.isArray(state.thinkChunks) &&
      state.thinkChunks.some((c) => isScriptCorruptedReasoning(c.text)))
  if (!corrupted) return state
  return { kind: 'openai_compat' }
}

/** OpenAI Responses API: supports none, minimal, low, medium, high, xhigh (not max). */
export function normalizeEffortForOpenAiResponses(
  effort?: ThinkingEffort,
  enabled = true
): string {
  if (!enabled) return 'none'
  if (!effort || effort === 'medium') return 'medium'
  if (effort === 'max') return 'xhigh'
  return effort
}

/** Gemini Interactions API: minimal, low, medium, high only. */
export function normalizeEffortForGeminiInteractions(effort?: ThinkingEffort): string {
  switch (effort) {
    case 'minimal':
      return 'minimal'
    case 'low':
      return 'low'
    case 'high':
    case 'xhigh':
    case 'max':
      return 'high'
    default:
      return 'medium'
  }
}

/** Groq / xAI OpenAI-compat chat effort normalization. */
export function normalizeEffortForOpenAiCompatReasoning(
  effort: ThinkingEffort | undefined,
  providerId: 'groq' | 'xai'
): string {
  const e = effort ?? 'medium'
  if (providerId === 'xai') {
    if (e === 'minimal' || e === 'low') return 'low'
    if (e === 'xhigh' || e === 'max') return 'high'
    if (e === 'medium' || e === 'high') return e
    return 'medium'
  }
  // Groq
  if (e === 'minimal') return 'none'
  if (e === 'xhigh' || e === 'max') return 'high'
  if (e === 'low' || e === 'medium' || e === 'high') return e
  return 'default'
}

/**
 * Mistral chat `reasoning_effort`: none | minimal | low | medium | high | xhigh.
 * Product `max` maps to `xhigh`. Use `none` when thinking is disabled.
 */
export function normalizeEffortForMistral(effort?: ThinkingEffort): string {
  if (!effort || effort === 'medium') return 'medium'
  if (effort === 'max') return 'xhigh'
  return effort
}

/** Collect trailing tool results for provider continuation turns. */
export function trailingToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const trailing: ChatMessage[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'tool') break
    trailing.unshift(m)
  }
  return trailing
}

/**
 * Messages to send when chaining `previous_response_id` / `previous_interaction_id`.
 *
 * Tool-only suffixes stay tool results. If anything after the last reasoning
 * assistant is not a tool result (typically a new user turn), return that full
 * suffix so the provider sees the follow-up instead of an empty tool list.
 * When no assistant carries reasoning state, fall back to trailing tools.
 */
export function statefulContinuationMessages(messages: ChatMessage[]): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    if (!parseProviderReasoningState(m.reasoningState)) continue
    return messages.slice(i + 1)
  }
  return trailingToolMessages(messages)
}
