/**
 * The voice model's call (D-44, D-45): the provider and model from
 * Settings → Voice, through the same provider layer the agent uses, so any
 * chat provider with a key works. Its spend goes into Usage like the other
 * side calls.
 */
import type { ModelInfo, Settings } from '../../shared/ipc'
import { ProviderIdSchemaAny, type ProviderIdAny, type ThinkingEffort } from '../../shared/ipc/schemas/providers'
import type { ThinkingConfig } from '../../shared/domain/reasoning'
import { DEFAULT_VOICE_RESPONDER, type VoiceResponder } from '../../shared/ipc/schemas/voice'
import { providerNeedsKey, resolveProviderChatBaseUrl } from '../../shared/providers'
import { estimateStepCost } from '../../shared/pricing/modelPrices'
import { logger } from '../../shared/logger'
import { getProvider } from '../agent/providers'
import type { TokenUsage } from '../agent/providers/types'
import { resolveModelInfo } from '../agent/modelResolve'
import { resolveRunModelPrice } from '../agent/pricing'
import { recordAuxUsage } from '../agent/usageLedger'
import { getSecret } from '../settings/secrets'
import { getSettings } from '../settings/settings'
import { workspaceUsageDir } from '../storage/paths'
import type { ResponderChat } from './responder'

/** Spoken replies are short; this caps a runaway one. */
const MAX_OUTPUT_TOKENS = 400

type Resolved = { provider: ProviderIdAny; model: string; apiKey: string | null; baseUrl: string | undefined }

/** The voice model and how to reach it, or null when its provider can't be used (no key). */
export function resolveResponder(settings: Settings = getSettings()): Resolved | null {
  const ref: VoiceResponder = settings.voice?.responder ?? DEFAULT_VOICE_RESPONDER
  const parsed = ProviderIdSchemaAny.safeParse(ref.provider)
  if (!parsed.success || !ref.model.trim()) return null
  const provider = parsed.data
  try {
    const apiKey = getSecret(provider)
    const baseUrl = resolveProviderChatBaseUrl(provider, settings, apiKey)
    if (providerNeedsKey(provider, baseUrl ?? settings.ollamaBaseUrl) && !apiKey?.trim()) return null
    return { provider, model: ref.model.trim(), apiKey, baseUrl }
  } catch {
    return null
  }
}

/** Cheapest first: the voice wants its first word, not depth. */
const EFFORT_LADDER: readonly ThinkingEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * How much the voice model thinks before it speaks. Off where the model
 * allows it; where it can't be turned off, the lowest effort it lists.
 * Without this, glm-5.3-flash ran at its listed default effort, `max`.
 * Measured 2026-10-14 over OpenRouter, three turns each: first word in
 * 1.8–4.3 s (67–143 reasoning tokens) with no effort sent, 0.75–1.5 s
 * (3–15 tokens) at the lowest.
 */
export function responderThinking(info: ModelInfo | undefined): ThinkingConfig {
  if (!info?.supportsThinking || info.thinkingCanDisable !== false) return { enabled: false }
  const listed = info.supportedThinkingEfforts
  const lowest = listed?.length ? (EFFORT_LADDER.find((e) => listed.includes(e)) ?? listed[0]!) : 'low'
  return { enabled: true, effort: lowest, display: 'omitted' }
}

/** A cold catalog is a network fetch; the turn won't wait longer than this for it. */
const MODEL_INFO_WAIT_MS = 1500
const modelInfos = new Map<string, Promise<ModelInfo | undefined>>()

/**
 * The voice model's catalog entry, looked up once per provider and model
 * (the catalog itself is cached). Undefined when it can't be found in time:
 * the turn goes on as before rather than wait.
 */
export function responderModelInfo(r: Resolved): Promise<ModelInfo | undefined> {
  const key = `${r.provider}\n${r.baseUrl ?? ''}\n${r.model}`
  let pending = modelInfos.get(key)
  if (!pending) {
    pending = resolveModelInfo(r.provider, r.model, r.apiKey, r.baseUrl, AbortSignal.timeout(15_000)).then(
      (info) => info,
      (err: unknown) => {
        modelInfos.delete(key)
        logger.warn('Voice model details unavailable; its thinking is left at the provider default', {
          scope: 'voice',
          reason: err instanceof Error ? err.message : String(err)
        })
        return undefined
      }
    )
    modelInfos.set(key, pending)
  }
  return pending
}

/** Look the voice model up before the first turn needs it. */
export function prepareResponderModel(): void {
  const r = resolveResponder()
  if (r) void responderModelInfo(r)
}

/** Tests only. */
export function resetResponderModelInfoForTests(): void {
  modelInfos.clear()
}

function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms)
    void p.then((v) => {
      clearTimeout(t)
      resolve(v)
    })
  })
}

/** A `ResponderChat` for the session, or null when the voice model can't be used. */
export function makeResponderChat(): ResponderChat | null {
  const r = resolveResponder()
  if (!r) return null
  return async function* (req) {
    const provider = getProvider(r.provider)
    const modelInfo = await within(responderModelInfo(r), MODEL_INFO_WAIT_MS)
    for await (const chunk of provider.streamChat({
      model: r.model,
      apiKey: r.apiKey,
      baseUrl: r.baseUrl,
      signal: req.signal,
      // The fixed instructions stay byte-stable for the provider's cache; the status changes every turn.
      systemStable: req.system,
      systemVolatile: req.status,
      messages: req.messages,
      tools: req.tools,
      ...(req.tools.length > 0 ? { toolChoice: 'auto' as const } : {}),
      // Reasoning a model can't switch off counts against this cap too: keep room for the words.
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      // Speed over depth: a spoken answer can't wait for reasoning.
      thinking: responderThinking(modelInfo),
      ...(modelInfo ? { modelInfo } : {}),
      routing: 'latency'
    })) {
      if (chunk.type === 'text' && chunk.text) yield { type: 'text', text: chunk.text }
      else if (chunk.type === 'tool_call' && chunk.toolCall) {
        yield { type: 'tool_call', name: chunk.toolCall.name, arguments: chunk.toolCall.arguments }
      } else if (chunk.type === 'done') yield { type: 'done', ...(chunk.usage ? { usage: chunk.usage } : {}) }
      else if (chunk.type === 'error') yield { type: 'error', message: chunk.error ?? 'The voice model failed' }
    }
  }
}

/** The voice model's spend, into the workspace's Usage (never a task's: it isn't one). */
export async function recordResponderUsage(workspacePath: string | null, usage: TokenUsage): Promise<void> {
  const r = resolveResponder()
  if (!workspacePath || !r) return
  try {
    const price = usage.billedCost == null ? await resolveRunModelPrice(r.provider, r.model, r.baseUrl) : null
    const estimated = price ? (estimateStepCost(usage, price) ?? undefined) : undefined
    recordAuxUsage(workspaceUsageDir(workspacePath), {
      site: 'voice_reply',
      ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.cachedInputTokens != null ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      ...(usage.reasoningTokens != null ? { reasoningTokens: usage.reasoningTokens } : {}),
      ...(usage.billedCost != null ? { billedCost: usage.billedCost } : {}),
      ...(estimated !== undefined ? { estimatedCost: estimated } : {})
    })
  } catch (err) {
    logger.warn('Could not record the voice reply spend', { scope: 'voice', err })
  }
}
