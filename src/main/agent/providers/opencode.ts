import type {
  LlmProvider,
  ListModelsRequest,
  ProviderChatRequest,
  StreamChunk
} from './types'
import type { ModelInfo } from '../../../shared/ipc'
import { randomUUID } from 'crypto'
import { createOpenAiCompatibleProvider } from './openai'
import { streamOpenAiResponses } from './openaiResponses'
import { streamAnthropicMessages } from './anthropic'
import {
  clampEffortToOpenCodeGoLadder,
  getCachedOpenCodeGoEffortLadder,
  getCachedOpenCodeGoMeta,
  mergeOpenCodeGoMeta,
  normalizeOpenCodeGoModelId,
  opencodeGoEffortLadderFor,
  opencodeGoFloorEffort,
  opencodeGoTransportFor,
  loadOpenCodeGoCatalog,
  type OpenCodeTransport
} from '../../../shared/domain/opencodeGoCatalog'

export const OPENCODE_GO_BASE = 'https://opencode.ai/zen/go/v1'

/**
 * Chat-completions transport opts. `enablePromptCache` forwards the loop's
 * promptCacheKey (runId) as `prompt_cache_key` so the gateway keeps cache
 * affinity across steps — without it live runs bounce between cache shards
 * (measured 2026-08-31: 3.8–10% overall hit rate, binary 0%/100% alternation,
 * run 72d5df60). Hosts that reject the field retry once without it
 * (shouldRetryOmitCacheKey).
 *
 * `stripReasoningReplay: true` drops prior-turn reasoning from history.
 * These hosts regenerate thinking from context; feeding each step its own
 * replayed reasoning self-conditions ritual thinking and makes one corrupted
 * block persist for the whole run (measured 2026-08-31, run 6265fa90: ritual
 * openers in 21/24 steps — 98% of thinking bytes — and a mid-stream
 * script-glitch replayed verbatim into every later step). Display text is
 * unaffected; only the wire history changes.
 *
 * `sessionHeader: 'x-opencode-session'` sends the stable per-conversation
 * session id on every chat request — the gateway refuses to route requests
 * without it ("Request is missing x-opencode-session and cannot be routed
 * efficiently", docs: "Send a stable session ID … for each conversation so we
 * can optimize routing and prompt caching").
 */
export const OPENCODE_CHAT_OPTS = {
  defaultBaseUrl: OPENCODE_GO_BASE,
  enablePromptCache: true,
  stripReasoningReplay: true,
  sessionHeader: 'x-opencode-session',
  // /v1/models is public (live-verified 2026-09-11: HTTP 200 without auth), so
  // the catalog loads before a key is saved — PUBLIC_CATALOG_PROVIDERS in
  // providers/index.ts relies on this flag. Chat keeps its own key gate below.
  optionalApiKey: true
} as const

const opencodeChat = createOpenAiCompatibleProvider('opencode', OPENCODE_CHAT_OPTS)

/** Endpoint family for a model id — shared with reasoning/thinking wiring. */
export function opencodeEndpointFor(model: string): OpenCodeTransport {
  return opencodeGoTransportFor(model)
}

/**
 * Exported for tests — merge live catalog rows with runtime registry thinking
 * ladders. The registry (models.dev `opencode-go`) is fetched live, so this is
 * async; callers await it.
 */
export async function mergeGoMeta(m: ModelInfo): Promise<ModelInfo> {
  const bare: ModelInfo = { ...m, id: normalizeOpenCodeGoModelId(m.id) }
  try {
    await loadOpenCodeGoCatalog()
  } catch {
    // Registry outage must not hide the live gateway catalog: list bare ids
    // without registry-derived ladders/context instead of failing the whole
    // list (which would fall back to empty seeds).
    return bare
  }
  const merged = mergeOpenCodeGoMeta(bare)
  // Registry ladders are authoritative where declared (models.dev
  // reasoning_options). These models reject unlisted reasoning_effort levels;
  // disable support follows the registry's toggle / effort: none rungs.
  const ladder = await opencodeGoEffortLadderFor(merged.id)
  if (!ladder || merged.supportsThinking !== true) return merged
  return {
    ...merged,
    thinkingMode: merged.thinkingMode ?? 'effort',
    thinkingCanDisable: getCachedOpenCodeGoMeta(merged.id)?.thinkingCanDisable ?? false,
    supportedThinkingEfforts: [...ladder]
  }
}

/**
 * Resolve the outgoing ThinkingConfig for a Go request. Chat-mount ladders
 * apply where declared (models.dev reasoning_options); Responses/Messages
 * request normalizers own the mapping for their transports. Disable is honored
 * where the registry declares a disable affordance (toggle / effort `none`);
 * on pure-ladder chat models an explicit disable is impossible — the mount
 * rejects unlisted effort levels ("[1210] cannot be disabled") and still thinks
 * when the field is omitted (live-verified) — so a disable request becomes the
 * model's floor effort with display omitted.
 */
export function opencodeThinkingFor(
  model: string,
  thinking: ProviderChatRequest['thinking']
): ProviderChatRequest['thinking'] {
  const shape = opencodeEndpointFor(model)
  const ladder = shape === 'chat' ? getCachedOpenCodeGoEffortLadder(model) : undefined
  if (thinking?.enabled === false) {
    if (getCachedOpenCodeGoMeta(model)?.thinkingCanDisable) return thinking
    return ladder
      ? { enabled: true, effort: opencodeGoFloorEffort(ladder), display: 'omitted' }
      : thinking
  }
  return {
    enabled: true,
    effort: ladder
      ? clampEffortToOpenCodeGoLadder(thinking?.effort ?? 'medium', ladder)
      : (thinking?.effort ?? 'medium'),
    display: thinking?.display ?? 'summarized'
  }
}

let sessionFallbackId: string | undefined

/**
 * Stable per-conversation session id for OpenCode Go's required
 * `x-opencode-session` routing header. The loop forwards its runId as
 * promptCacheKey, so normal runs reuse it; requests that arrive without one
 * fall back to a per-process UUID so the header is always present and stable.
 */
export function opencodeSessionKeyFor(req: ProviderChatRequest): string {
  const fromReq = req.promptCacheKey?.trim()
  if (fromReq) return fromReq
  if (!sessionFallbackId) sessionFallbackId = randomUUID()
  return sessionFallbackId
}

export const opencodeProvider: LlmProvider = {
  id: 'opencode',
  async *streamChat(req: ProviderChatRequest): AsyncGenerator<StreamChunk> {
    if (!req.apiKey) {
      yield { type: 'error', error: 'OpenCode Go API key not set' }
      return
    }
    // All three transports carry the same x-opencode-session value; setting
    // promptCacheKey here means the chat-completions header builder and the
    // responses/messages extraHeaders below all resolve it without a second
    // mechanism.
    const session = opencodeSessionKeyFor(req)
    const reqWithThinking: ProviderChatRequest = {
      ...req,
      thinking: opencodeThinkingFor(req.model, req.thinking),
      promptCacheKey: session
    }
    const sessionHeaders: Record<string, string> = { 'x-opencode-session': session }
    const shape = opencodeEndpointFor(req.model)
    if (shape === 'responses') {
      yield* streamOpenAiResponses(
        reqWithThinking,
        `${OPENCODE_GO_BASE}/responses`,
        sessionHeaders,
        'opencode'
      )
      return
    }
    if (shape === 'messages') {
      yield* streamAnthropicMessages(
        reqWithThinking,
        `${OPENCODE_GO_BASE}/messages`,
        sessionHeaders
      )
      return
    }
    yield* opencodeChat.streamChat(reqWithThinking)
  },
  async listModels(req: ListModelsRequest): Promise<ModelInfo[]> {
    // Errors propagate so listProviderModels surfaces actionable warnings and
    // applies its generic seed fallback instead of failing silently here.
    const live = await opencodeChat.listModels(req)
    return Promise.all(live.map((m) => mergeGoMeta(m)))
  }
}
