import type { ChatMessage, ModelInfo, ModelRef, ProviderId, ProviderIdAny, Settings } from '../../shared/ipc'
import { catalogProviderId } from '../../shared/ipc'
import { providerLabel, resolveProviderChatBaseUrl } from '../../shared/providers'
import { catalogThinkingAllowed } from '../../shared/reasoning'
import { isAbortError } from '../../shared/errors'
import { logger } from '../../shared/logger'
import { resolveModelPrice, type ResolvedModelPrice } from '../../shared/pricing/modelPrices'
import { getSecret, hasStoredSecretBlob, secretStatus } from '@main/settings/secrets'
import { getProvider } from './providers'
import { isRetriableNetworkError } from './providers/fetchWithRetry'
import { preflightChatProviderAuth } from './providers/preflight'
import type { LlmProvider } from './providers/types'
import { resolveModelInfo } from './modelResolve'
import { contextWindowFor } from './context/budget'
import { stripUnsupportedModalitiesFromMessages, wireCapsFromModel } from './context/stripImages'
import { isQuotaExhaustedMessage } from './quotaGate'
import { isLocalEndpointDownError, isLocalEndpointDownMessage } from './streamRetry'

/**
 * Model fallback: when the task's provider is DOWN, a step moves to the next
 * model in Settings → Providers → Fallback models and retries there.
 *
 * What counts as down (`classifyOutageFailure`): 5xx and 529 overloaded, 408,
 * connection refused / reset, DNS failures, connect and idle timeouts. What
 * never does:
 * - 429s and usage-limit / quota messages. Hours of retries on those are
 *   deliberate (quotaGate.ts, loopStopReason.test.ts) — the plan resets and the
 *   task carries on on its own model.
 * - 4xx request errors, 401/403 auth and 402 billing. Those are the user's to
 *   fix, and the run surfaces them as it always did.
 * - An open circuit. The fetch layer opens it on 429s too, so it cannot tell a
 *   quota wait from an outage; real outages have already switched by then.
 *
 * When: the stream retry has no attempt ceiling, so "after the retries" means
 * after `FALLBACK_AFTER_OUTAGE_ATTEMPTS` consecutive outage-class stream
 * attempts on the same model within one step — each of which already spent the
 * fetch layer's own five tries. A failure the loop would not retry at all (a
 * local endpoint that refuses connections) switches at once.
 *
 * How long: the rest of this invoke (the turn). The next turn — a new message,
 * Continue, a goal relaunch — starts on the task's model again. Within a long
 * turn, the first step that starts `PRIMARY_RETRY_AFTER_MS` after the switch
 * tries the task's model again. Within one step the order is cyclic (fallbacks,
 * then the task's model), at most one lap, so a step never ping-pongs.
 *
 * History: a fallback request carries no provider reasoning replay except what
 * the fallback itself produced this turn (Anthropic thinking blocks, Responses
 * chain ids and the like mean nothing to another model), and no continuation
 * id. The task's model gets its requests byte-for-byte as before, so its prompt
 * cache is untouched; the fallback simply starts cold.
 */

export const FALLBACK_AFTER_OUTAGE_ATTEMPTS = 2
export const PRIMARY_RETRY_AFTER_MS = 10 * 60_000

/** A model the loop can stream from: the task's own, or a resolved fallback. */
export type ModelTarget = {
  /** Endpoint id (`custom:<slug>` for an added endpoint): key, base URL, catalog. */
  runProviderId: ProviderIdAny
  /** Adapter whose request shaping applies. */
  providerId: ProviderId
  model: string
  provider: LlmProvider
  apiKey: string | null
  baseUrl: string | undefined
  modelInfo: ModelInfo
  price: ResolvedModelPrice | null
  /** The catalog lets this model think (the user's thinking setting still applies). */
  thinkingAllowed: boolean
}

/** A switch the record shows as one line. */
export type ModelSwitch = {
  from: ModelTarget
  to: ModelTarget
  reason?: string
  restored?: boolean
  message: string
}

/** What a step's request needs from whichever model serves it. */
export type FallbackNeeds = {
  tools: boolean
  images: boolean
  /** Estimated prompt tokens of the assembled request. */
  promptTokens: number
  signal: AbortSignal
}

export type ModelFallbackDeps = {
  getProvider: (id: ProviderIdAny) => LlmProvider
  getSecret: (id: ProviderIdAny) => string | null
  hasStoredSecretBlob: (id: ProviderIdAny) => boolean
  encryptionAvailable: () => boolean
  resolveModelInfo: (
    provider: ProviderIdAny,
    model: string,
    apiKey: string | null,
    baseUrl: string | undefined,
    signal: AbortSignal
  ) => Promise<ModelInfo>
  now: () => number
}

const defaultDeps: ModelFallbackDeps = {
  getProvider,
  getSecret: (id) => getSecret(id),
  hasStoredSecretBlob: (id) => hasStoredSecretBlob(id),
  encryptionAvailable: () => secretStatus().encryptionAvailable,
  resolveModelInfo,
  now: () => Date.now()
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

/** Rate limits and usage limits: waits, never outages. */
const LIMIT_RE = /rate.?limit|too many requests|usage limit|quota|insufficient (credits|balance)|billing/i
const OVERLOADED_RE = /overloaded|over capacity|at capacity/i
const UNAVAILABLE_RE =
  /service unavailable|temporarily unavailable|bad gateway|gateway time-?out|internal server error|upstream (connect )?error|server error/i

function networkReason(text: string): string | null {
  if (/ECONNREFUSED|connection refused/i.test(text)) return 'connection refused'
  if (/ECONNRESET|socket hang up|other side closed|connection reset/i.test(text)) return 'connection reset'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns/i.test(text)) return 'DNS lookup failed'
  if (/ETIMEDOUT|timed out|timeout/i.test(text)) return 'timed out'
  if (/fetch failed|terminated|network/i.test(text)) return 'connection failed'
  return null
}

/**
 * Why a provider `error` chunk means the provider is down, or null when it
 * does not (a limit, a request or key problem, or anything unrecognized).
 */
export function classifyOutageFailure(input: {
  errorCode?: string
  message?: string
  httpStatus?: number
}): string | null {
  const message = input.message ?? ''
  const status = input.httpStatus
  if (status === 429 || isQuotaExhaustedMessage(message) || LIMIT_RE.test(message)) return null
  if (status != null) {
    if (status === 529) return 'overloaded'
    if (status >= 500 && status < 600) return OVERLOADED_RE.test(message) ? 'overloaded' : `HTTP ${status}`
    if (status === 408) return 'timed out'
    return null
  }
  if (isLocalEndpointDownMessage(message)) return 'connection refused'
  switch (input.errorCode) {
    case 'PROVIDER_NETWORK':
      return networkReason(message) ?? 'connection failed'
    case 'PROVIDER_TIMEOUT':
      return 'timed out'
    case 'PROVIDER_HTTP':
    case 'PROVIDER_STREAM':
      // Status-less in-band frames: only the unmistakable outage wording.
      if (OVERLOADED_RE.test(message)) return 'overloaded'
      if (UNAVAILABLE_RE.test(message)) return 'unavailable'
      return input.errorCode === 'PROVIDER_STREAM' ? networkReason(message) : null
    default:
      return null
  }
}

/** The same for a thrown stream failure (connect errors, dead local endpoints). */
export function classifyThrownOutage(err: unknown): string | null {
  if (isAbortError(err)) return null
  const texts: string[] = []
  let current: unknown = err
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth++) {
    const { code, message } = current as { code?: unknown; message?: unknown }
    if (typeof code === 'string') texts.push(code)
    if (typeof message === 'string') texts.push(message)
    current = (current as { cause?: unknown }).cause
  }
  const text = texts.join(' ')
  if (LIMIT_RE.test(text)) return null
  if (isLocalEndpointDownError(err)) return 'connection refused'
  if (!isRetriableNetworkError(err)) return null
  return networkReason(text) ?? 'connection failed'
}

// ---------------------------------------------------------------------------
// History for a fallback request
// ---------------------------------------------------------------------------

/**
 * The conversation as a fallback model should get it: provider reasoning
 * replay dropped except state `keep` accepts (what the fallback produced
 * itself), and parts the model cannot take replaced by text markers. Messages
 * without replay state are passed through unchanged.
 */
export function historyForFallback(
  messages: readonly ChatMessage[],
  modelInfo: ModelInfo,
  keep: (state: unknown) => boolean = () => false
): ChatMessage[] {
  const stripped = messages.map((m) => {
    if (m.reasoningState === undefined || keep(m.reasoningState)) return m
    const { reasoningState: _dropped, ...rest } = m
    return rest
  })
  return stripUnsupportedModalitiesFromMessages(stripped, wireCapsFromModel(modelInfo))
}

/** True when any message carries an image part. */
export function messagesHaveImages(messages: readonly ChatMessage[]): boolean {
  return messages.some(
    (m) => typeof m.content !== 'string' && m.content.some((p) => p.type === 'image_url')
  )
}

// ---------------------------------------------------------------------------
// The per-invoke controller
// ---------------------------------------------------------------------------

export type ModelFallback = {
  /** The model the next attempt streams from. */
  current(): ModelTarget
  isPrimary(): boolean
  /** Start of a step: resets the step's counters; may switch back to the task's model. */
  beginStep(): ModelSwitch | null
  /**
   * One failed attempt on `current()`. Returns the switch when the step should
   * retry on another model now; null keeps the existing retry behaviour.
   * `immediate` is for failures the loop would not retry on its own.
   */
  onOutage(reason: string, needs: FallbackNeeds, opts?: { immediate?: boolean }): Promise<ModelSwitch | null>
  /** True once after a switch: the next attempt need not wait out the backoff. */
  takeSkipWait(): boolean
  /** Messages for a request to `current()` — unchanged on the task's model. */
  requestMessages(messages: ChatMessage[]): ChatMessage[]
  /** Reasoning state a fallback produced, so its own replay survives the strip. */
  noteReasoningState(state: unknown): void
}

type Slot = { ref: ModelRef; target: ModelTarget | null; unusable: boolean }

function sameRef(a: ModelRef, b: { provider: ProviderIdAny; model: string }): boolean {
  return a.provider === b.provider && a.model === b.model
}

export function createModelFallback(opts: {
  settings: Settings
  primary: ModelTarget
  deps?: Partial<ModelFallbackDeps>
}): ModelFallback {
  const deps: ModelFallbackDeps = { ...defaultDeps, ...opts.deps }
  const { settings, primary } = opts
  const config = settings.modelFallback
  const slots: Slot[] = [{ ref: { provider: primary.runProviderId, model: primary.model }, target: primary, unusable: false }]
  if (config?.enabled) {
    for (const ref of config.models ?? []) {
      if (slots.some((s) => sameRef(s.ref, ref))) continue
      slots.push({ ref, target: null, unusable: false })
    }
  }

  let index = 0
  let switchedAt = 0
  let failuresOnCurrent = 0
  let switchesThisStep = 0
  let skipWait = false
  const fallbackReasoning = new WeakSet<object>()

  const label = (t: ModelTarget): string => providerLabel(t.runProviderId, settings.customProviders)

  /** Credentials and catalog for a fallback slot; null when it cannot serve this step. */
  async function resolveSlot(slot: Slot, needs: FallbackNeeds): Promise<ModelTarget | null> {
    if (slot.unusable) return null
    if (!slot.target) {
      const runProviderId = slot.ref.provider
      let apiKey: string | null = null
      let baseUrl: string | undefined
      try {
        apiKey = deps.getSecret(runProviderId)
        baseUrl = resolveProviderChatBaseUrl(runProviderId, settings, apiKey)
      } catch (err) {
        slot.unusable = true
        logger.warn('Fallback model skipped: its provider could not be resolved', { scope: 'agent', provider: runProviderId, err })
        return null
      }
      const preflight = preflightChatProviderAuth({
        providerId: runProviderId,
        customProviders: settings.customProviders,
        apiKey,
        baseUrl: baseUrl ?? settings.ollamaBaseUrl,
        encryptionAvailable: deps.encryptionAvailable(),
        hasStoredBlob: deps.hasStoredSecretBlob(runProviderId)
      })
      if (preflight) {
        slot.unusable = true
        logger.warn('Fallback model skipped: its provider has no usable key', {
          scope: 'agent',
          provider: runProviderId,
          code: preflight.code
        })
        return null
      }
      let modelInfo: ModelInfo
      try {
        modelInfo = await deps.resolveModelInfo(runProviderId, slot.ref.model, apiKey, baseUrl, needs.signal)
      } catch (err) {
        if (isAbortError(err)) throw err
        logger.warn('Fallback model skipped: its catalog could not be read', { scope: 'agent', provider: runProviderId, err })
        return null
      }
      slot.target = {
        runProviderId,
        providerId: catalogProviderId(runProviderId),
        model: slot.ref.model,
        provider: deps.getProvider(runProviderId),
        apiKey,
        baseUrl,
        modelInfo,
        price: resolveModelPrice(runProviderId, slot.ref.model),
        thinkingAllowed: catalogThinkingAllowed(slot.ref.model, modelInfo.supportsThinking)
      }
    }
    const t = slot.target
    if (t === primary) return t
    if (needs.tools && t.modelInfo.supportsTools === false) return null
    if (needs.images && !wireCapsFromModel(t.modelInfo).image) return null
    if (needs.promptTokens > contextWindowFor(t.modelInfo, t.providerId)) return null
    return t
  }

  function switchTo(next: number, reason: string | undefined, restored: boolean): ModelSwitch {
    const from = slots[index]!.target!
    const to = slots[next]!.target!
    index = next
    failuresOnCurrent = 0
    switchedAt = deps.now()
    skipWait = true
    const message = restored
      ? `Back on ${to.model} — trying ${label(to)} again`
      : `Switched to ${to.model} — ${label(from)} unavailable (${reason})`
    logger.warn(`Model fallback: ${message}`, { scope: 'agent', provider: to.runProviderId, model: to.model })
    return { from, to, ...(reason ? { reason } : {}), ...(restored ? { restored: true } : {}), message }
  }

  return {
    current: () => slots[index]!.target!,
    isPrimary: () => index === 0,
    beginStep() {
      failuresOnCurrent = 0
      switchesThisStep = 0
      skipWait = false
      if (index !== 0 && deps.now() - switchedAt >= PRIMARY_RETRY_AFTER_MS) {
        return switchTo(0, undefined, true)
      }
      return null
    },
    async onOutage(reason, needs, outageOpts) {
      if (slots.length < 2) return null
      failuresOnCurrent += 1
      if (!outageOpts?.immediate && failuresOnCurrent < FALLBACK_AFTER_OUTAGE_ATTEMPTS) return null
      if (switchesThisStep >= slots.length) return null
      for (let step = 1; step < slots.length; step++) {
        const next = (index + step) % slots.length
        const target = await resolveSlot(slots[next]!, needs)
        if (!target) continue
        switchesThisStep += 1
        return switchTo(next, reason, false)
      }
      return null
    },
    takeSkipWait() {
      const skip = skipWait
      skipWait = false
      return skip
    },
    requestMessages(messages) {
      if (index === 0) return messages
      const target = slots[index]!.target!
      return historyForFallback(messages, target.modelInfo, (state) =>
        typeof state === 'object' && state !== null && fallbackReasoning.has(state)
      )
    },
    noteReasoningState(state) {
      if (index !== 0 && typeof state === 'object' && state !== null) fallbackReasoning.add(state)
    }
  }
}
