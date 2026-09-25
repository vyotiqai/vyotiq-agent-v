import type { ChatMessage, ModelInfo } from '../../../shared/ipc'
import { contentToText } from '../../../shared/ipc'
import { isAbortError } from '../../../shared/errors'
import { logger } from '../../../shared/logger'
import {
  isRetriableHttpStatus,
  isRetriableProviderMessage,
  RetriableStreamError
} from '../providers/fetchWithRetry'
import type {
  LlmProvider,
  ProviderChatRequest,
  TokenUsage,
  ToolDefinition
} from '../providers/types'
import {
  compactionSystemPrompt,
  parseCompactionJson,
  toCompactionJsonSchema,
  type CompactionData,
  type CompactionOutputFormat
} from '../schemas/compaction'
import { collectStructuredResponse } from '../schemas/structured'
import { circuitKeyProvider, isCircuitOpenError } from '../circuitBreaker'
import { runWithStreamRetry } from '../streamRetry'
import {
  estimateMessagesTokensAsync,
  estimateTextTokensAsync
} from './estimate'
import { exceedsHardLimit } from '../../../shared/domain/contextBudget'
import { stripLeadingOrphanToolMessages } from './foldWatermark'
import { stripPinnedFactsAppendix } from './pinFoldFacts'
import { KEEP_RECENT_TURNS, type CompactionRecord } from './types'

/**
 * A provider failure compaction cannot recover from — non-retriable HTTP
 * status (auth, billing, unknown model). Thrown so callers stop the entire
 * fallback ladder instead of walking fork → structured → freeform → flattened
 * retry against a dead endpoint (2026-09-02: a modal 404 "unknown inference
 * model" fired 13 compaction calls in ~4s and surfaced as the unrelated
 * "The model returned no summary.").
 */
export class CompactionHardFailureError extends Error {
  readonly httpStatus?: number

  constructor(message: string, httpStatus?: number) {
    super(message)
    this.name = 'CompactionHardFailureError'
    this.httpStatus = httpStatus
  }
}

/** Count user turns in a message list (manual + auto keep-recent). */
export function countUserTurns(messages: readonly ChatMessage[]): number {
  let n = 0
  for (const m of messages) {
    if (m.role === 'user') n++
  }
  return n
}

/**
 * True when the unchunked message-shape fork path is safe to call. The fork
 * sends the full pre-compaction history in a single request; when that history
 * would exceed the model window the provider 400s at its hard limit and kills
 * the run (observed: e7d7d807 — request resolved to 1,068,578 tokens on a
 * 1,048,576-token raw window). When the window or model info is missing we
 * cannot prove overflow, so we allow the fork and rely on the chunked fallback
 * only when overflow is provable.
 */
export async function shouldUseForkCompaction(
  messages: readonly ChatMessage[],
  window?: number,
  modelInfo?: ModelInfo
): Promise<boolean> {
  if (window == null || modelInfo == null) return true
  return !exceedsHardLimit(window, await estimateMessagesTokensAsync(messages, modelInfo))
}

/**
 * Keep-recent for on-demand compact. Always leaves at least one older user turn
 * foldable when multiple exist — unlike auto assemble, which may keep the full
 * working set when `userTurns < keepRecentTurns` and history fits the budget.
 */
export function manualKeepRecentTurns(userTurns: number, configuredKeep: number): number {
  const keep = Math.max(1, configuredKeep)
  if (userTurns <= 1) return 1
  return Math.min(keep, userTurns - 1)
}

/** Last-resort suffix keep so a non-empty prefix can still be summarized. */
export function forceCompactKeepTail(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length < 2) return messages
  const keepCount = Math.max(2, Math.floor(messages.length / 2))
  const start = Math.max(0, messages.length - keepCount)
  if (start <= 0) return messages
  const kept = stripLeadingOrphanToolMessages(messages.slice(start))
  if (kept.length === 0 || kept.length >= messages.length) return messages
  return kept
}

/**
 * When assembled usage is at/above the auto-compact trigger, keep-recent can
 * leave almost all history verbatim (e.g. 5 of 6 user turns → 16-message fold
 * of a 243-message run). Force a half-history suffix keep so the fold is large
 * enough to drop remaining history.
 */
export function ensureSubstantialFold(
  working: ChatMessage[],
  kept: ChatMessage[]
): ChatMessage[] {
  const folded = working.length - kept.length
  if (folded >= Math.floor(working.length / 2)) return kept
  const forced = forceCompactKeepTail(working)
  return forced.length < kept.length ? forced : kept
}

const COMPACTION_NEXT_STEPS_GUIDANCE =
  'In Next Steps and Open Bugs/Blockers, name concrete files, todos, or commands the next turn should reopen — do not assume they remain in the verbatim window.'

const FOCUS_MAX_CHARS = 2000
const VERIFY_RETRY_FOCUS_PREFIX = 'Previous summary failed verification.'

function isRequiredFactsFocus(focus: string): boolean {
  return (
    focus.startsWith(VERIFY_RETRY_FOCUS_PREFIX) ||
    focus.includes('Preserve these user decisions verbatim') ||
    focus.includes('Preserve this contract goal') ||
    focus.includes('Written files that must appear') ||
    focus.includes('Open todos to mention') ||
    focus.includes('Contract done-when:') ||
    focus.includes('Files from this history')
  )
}

/** Build system prompt for summarizer; optional operator focus is preserved (capped unless required facts). */
export function buildCompactionSystemPrompt(
  format: CompactionOutputFormat,
  focus?: string
): string {
  let prompt = `${compactionSystemPrompt(format)}\n\n${COMPACTION_NEXT_STEPS_GUIDANCE}`
  const trimmed = focus?.trim()
  if (trimmed) {
    const body = isRequiredFactsFocus(trimmed) ? trimmed : trimmed.slice(0, FOCUS_MAX_CHARS)
    prompt += `\n\nOperator focus (priority for what to preserve):\n${body}`
  }
  return prompt
}

function capRollingSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const tail = text.slice(-maxChars)
  const firstNewline = tail.indexOf('\n')
  return firstNewline > 0 ? `…${tail.slice(firstNewline)}` : `… ${tail}`
}

/** Data supplied to the dedicated summarizer after the history messages. */
function buildCompactForkUserMessage(priorSummary?: string): string {
  let body = 'Summarize the preceding session history now.'
  const prior = priorSummary?.trim()
  if (prior) {
    body = `Previous session summary (already folded; stay consistent, do not drop its files or decisions):\n${prior}\n\n---\n\n${body}`
  }
  return body
}

/** One billed compaction provider stream. */
export type CompactionUsageSample = {
  site: 'compaction_fork' | 'compaction_structured' | 'compaction_freeform'
  usage: TokenUsage
  /** 1-based; >1 is a retry that re-sent the whole prompt and was billed again. */
  attempt: number
  generationMs: number
}

/**
 * Receives every billed compaction stream as it completes.
 *
 * A sink rather than a return value on purpose: `compactMessages` has several
 * abort and failure paths that return `null` or `''`, and a compaction that was
 * billed and then abandoned is exactly the spend worth seeing. A return channel
 * would discard it.
 */
export type CompactionUsageSink = (sample: CompactionUsageSample) => void

async function collectCompactionStreamText(input: {
  provider: LlmProvider
  req: ProviderChatRequest
  logCode: 'COMPACTION_STREAM' | 'COMPACTION_FORK'
  site: CompactionUsageSample['site']
  onAuxUsage?: CompactionUsageSink
}): Promise<string> {
  let summary = ''
  let attempt = 0
  let startedAt = Date.now()
  try {
    await runWithStreamRetry({
      signal: input.req.signal,
      circuitKey: circuitKeyProvider(input.provider.id, input.req.baseUrl),
      onAttemptStart: (n) => {
        summary = ''
        // Each retry re-sends the whole prompt and is billed again.
        attempt = n
        startedAt = Date.now()
      },
      runAttempt: async () => {
        for await (const chunk of input.provider.streamChat(input.req)) {
          if (input.req.signal.aborted) return 'terminal'
          if (chunk.type === 'done' && chunk.usage) {
            input.onAuxUsage?.({
              site: input.site,
              usage: chunk.usage,
              attempt: Math.max(1, attempt),
              generationMs: Math.max(0, Date.now() - startedAt)
            })
          }
          if (chunk.type === 'text' && chunk.text) summary += chunk.text
          if (chunk.type === 'error') {
            const message = chunk.error ?? 'Provider error'
            if (chunk.httpStatus != null && !isRetriableHttpStatus(chunk.httpStatus)) {
              throw new CompactionHardFailureError(message, chunk.httpStatus)
            }
            if (isRetriableProviderMessage(message)) {
              throw new RetriableStreamError(message)
            }
            logger.warn('Compaction stream error', {
              scope: 'agent',
              code: input.logCode
            })
            summary = ''
            return 'terminal'
          }
        }
        return 'complete'
      }
    })
  } catch (err) {
    if (isAbortError(err) || input.req.signal.aborted) return ''
    if (err instanceof RetriableStreamError || isCircuitOpenError(err)) {
      logger.warn('Compaction stream error', {
        scope: 'agent',
        code: input.logCode
      })
      return ''
    }
    throw err
  }
  if (input.req.signal.aborted) return ''
  return summary.trim()
}

async function streamFreeformSummary(input: {
  provider: LlmProvider
  model: string
  apiKey?: string | null
  baseUrl?: string
  signal: AbortSignal
  historyText: string
  focus?: string
  onAuxUsage?: CompactionUsageSink
}): Promise<string> {
  return collectCompactionStreamText({
    provider: input.provider,
    logCode: 'COMPACTION_STREAM',
    site: 'compaction_freeform',
    ...(input.onAuxUsage ? { onAuxUsage: input.onAuxUsage } : {}),
    req: {
      model: input.model,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      signal: input.signal,
      tools: [],
      toolChoice: 'none',
      thinking: { enabled: false },
      system: buildCompactionSystemPrompt('markdown', input.focus),
      messages: [{ role: 'user', content: input.historyText }]
    }
  })
}

async function streamMessageSummary(input: {
  provider: LlmProvider
  model: string
  apiKey?: string | null
  baseUrl?: string
  signal: AbortSignal
  messages: ChatMessage[]
  focus?: string
  priorSummary?: string
  promptCacheKey?: string
  modelInfo?: ModelInfo
  onAuxUsage?: CompactionUsageSink
}): Promise<string> {
  return collectCompactionStreamText({
    provider: input.provider,
    logCode: 'COMPACTION_FORK',
    site: 'compaction_fork',
    ...(input.onAuxUsage ? { onAuxUsage: input.onAuxUsage } : {}),
    req: {
      model: input.model,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      signal: input.signal,
      tools: [],
      toolChoice: 'none',
      thinking: { enabled: false },
      system: buildCompactionSystemPrompt('markdown', input.focus),
      messages: [
        ...input.messages,
        { role: 'user', content: buildCompactForkUserMessage(input.priorSummary) }
      ],
      ...(input.promptCacheKey ? { promptCacheKey: input.promptCacheKey } : {}),
      ...(input.modelInfo ? { modelInfo: input.modelInfo } : {})
    }
  })
}

function formatMessagesForCompaction(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const body = contentToText(m.content)
      const tools = m.toolCalls?.map((t) => `${t.name}(${t.arguments})`).join(', ')
      return `${m.role}${tools ? ` tools=${tools}` : ''}: ${body}`
    })
    .join('\n\n')
}

/** Split messages into chunks that fit under charCap (greedy by message). */
function chunkMessagesForCap(messages: ChatMessage[], charCap: number): ChatMessage[][] {
  if (messages.length === 0) return []
  const chunks: ChatMessage[][] = []
  let current: ChatMessage[] = []
  let currentChars = 0
  for (const message of messages) {
    const piece = formatMessagesForCompaction([message])
    const pieceLen = piece.length + (current.length > 0 ? 2 : 0)
    if (current.length > 0 && currentChars + pieceLen > charCap) {
      chunks.push(current)
      current = [message]
      currentChars = piece.length
    } else {
      current.push(message)
      currentChars += pieceLen
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

async function summarizeHistoryChunk(input: {
  provider: LlmProvider
  model: string
  apiKey?: string | null
  baseUrl?: string
  signal: AbortSignal
  historyText: string
  supportsStructuredOutput?: boolean
  focus?: string
  onAuxUsage?: CompactionUsageSink
}): Promise<string> {
  let summary = ''
  const useStructured = input.supportsStructuredOutput !== false
  const system = buildCompactionSystemPrompt('json', input.focus)

  if (useStructured) {
    try {
      const result = await collectStructuredResponse<CompactionData>(
        input.provider,
        {
          model: input.model,
          apiKey: input.apiKey,
          baseUrl: input.baseUrl,
          signal: input.signal,
          tools: [],
          toolChoice: 'none',
          thinking: { enabled: false },
          system,
          messages: [{ role: 'user', content: input.historyText }],
          responseFormat: {
            type: 'json_schema',
            name: 'compaction_summary',
            schema: toCompactionJsonSchema(),
            strict: true
          }
        },
        (raw) => {
          const parsed = parseCompactionJson(raw)
          if (parsed.structured) return { ok: true, data: parsed.structured }
          return { ok: false, error: 'invalid compaction schema' }
        },
        (usage, attempt, generationMs) =>
          input.onAuxUsage?.({ site: 'compaction_structured', usage, attempt, generationMs })
      )
      // Abort leaves partial rawText — never treat it as a summary.
      if (
        input.signal.aborted ||
        (!result.ok && result.error === 'Request aborted')
      )
        return ''
      if (
        !result.ok &&
        result.streamHttpStatus != null &&
        !isRetriableHttpStatus(result.streamHttpStatus)
      ) {
        // Hard provider failure (non-retriable status): bail instead of
        // silently falling back to freeform against the same dead endpoint.
        // Transient failures keep the fallback ladder.
        throw new CompactionHardFailureError(result.error, result.streamHttpStatus)
      }
      const parsed = parseCompactionJson(result.rawText)
      if (result.ok || parsed.structured) {
        summary = parsed.markdown
      } else if (parsed.markdown) {
        // Completed stream that failed schema but still returned usable text.
        summary = parsed.markdown
      }
    } catch (err) {
      // A hard provider failure must not fall back to freeform against the
      // same dead endpoint — surface it to the caller.
      if (err instanceof CompactionHardFailureError) throw err
      if (!isAbortError(err) && !input.signal.aborted) {
        logger.warn('Structured compaction failed, falling back to freeform', {
          scope: 'agent',
          code: 'COMPACTION',
          err
        })
      }
    }
  }

  if (!summary) {
    if (input.signal.aborted) return ''
    summary = await streamFreeformSummary({
      provider: input.provider,
      model: input.model,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      signal: input.signal,
      historyText: input.historyText,
      focus: input.focus,
      ...(input.onAuxUsage ? { onAuxUsage: input.onAuxUsage } : {})
    })
  }
  return summary.trim()
}

export async function compactMessages(input: {
  provider: LlmProvider
  model: string
  apiKey?: string | null
  baseUrl?: string
  signal: AbortSignal
  messages: ChatMessage[]
  supportsStructuredOutput?: boolean
  contextWindow?: number
  /** Previous compaction summary to retain across successive folds. */
  priorSummary?: string
  /** Optional operator focus directive for what to preserve. */
  focus?: string
  /**
   * Allow the unchunked message-shape fork. Compaction always runs under its own
   * summarizer instructions, so the parent step's harness and tools are never
   * inherited — this is the whole signal the fork path ever needed.
   */
  allowMessageFork?: boolean
  promptCacheKey?: string
  modelInfo?: ModelInfo
  /**
   * Fires per billed provider stream. Compaction is genuinely multi-call —
   * one per history chunk, plus a freeform fallback, plus retries inside each —
   * so this reports every stream rather than one row per fold.
   */
  onAuxUsage?: CompactionUsageSink
}): Promise<CompactionRecord | null> {
  if (input.signal.aborted) return null

  const tokenCap = Math.max(
    4000,
    Math.floor((input.contextWindow ?? 128_000) * 0.25)
  )
  const charCap = tokenCap * 4

  // Narrative only. The prior record's pinned-facts appendix is re-derived from
  // the structured `pinnedFacts` sidecar after this fold, so carrying it here
  // would spend the rolling char budget — which keeps the *tail* — on a fact
  // list that is about to be regenerated, evicting prose to do it.
  const prior = capRollingSummary(stripPinnedFactsAppendix(input.priorSummary ?? ''), charCap)

  const mergeForkSummary = async (summary: string): Promise<CompactionRecord> => {
    const merged = prior
      ? capRollingSummary(`${prior}\n\n---\n\n${summary}`, charCap)
      : capRollingSummary(summary, charCap)
    return {
      summary: merged,
      createdAt: new Date().toISOString(),
      tokenEstimate: await estimateTextTokensAsync(merged)
    }
  }

  if (input.allowMessageFork && input.messages.length > 0) {
    // An over-window fork request 400s at the provider hard limit and kills the
    // run (observed: e7d7d807 — request resolved to 1,068,578 tokens on a
    // 1,048,576-token raw window). Skip the unchunked message-shape fork when the
    // history would exceed the window and let the chunked path below summarize it.
    if (!(await shouldUseForkCompaction(input.messages, input.contextWindow, input.modelInfo))) {
      logger.warn('Fork compaction skipped: history exceeds model window; using chunked fallback', {
        scope: 'agent',
        code: 'COMPACTION'
      })
    } else {
      const forked = await streamMessageSummary({
        provider: input.provider,
        model: input.model,
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        signal: input.signal,
        messages: input.messages,
        focus: input.focus,
        priorSummary: prior || undefined,
        promptCacheKey: input.promptCacheKey,
        modelInfo: input.modelInfo,
        ...(input.onAuxUsage ? { onAuxUsage: input.onAuxUsage } : {})
      })
      if (input.signal.aborted) return null
      if (forked) return mergeForkSummary(forked)
      logger.warn('Message-shape compaction produced no summary; falling back to structured tools=[] path', {
        scope: 'agent',
        code: 'COMPACTION'
      })
    }
  }

  const chunks = chunkMessagesForCap(input.messages, Math.max(2000, charCap - 500))
  if (chunks.length === 0) {
    return prior
      ? {
          summary: prior,
          createdAt: new Date().toISOString(),
          tokenEstimate: await estimateTextTokensAsync(prior)
        }
      : null
  }

  let mergedPrior = prior
  const parts: string[] = []

  for (let i = 0; i < chunks.length; i++) {
    if (input.signal.aborted) return null
    const chunk = chunks[i]!
    const rollingPrefix =
      i === 0 && prior
        ? `Previous session summary (already folded; stay consistent, do not drop its files or decisions):\n${prior}\n\n---\n\n`
        : i > 0 && mergedPrior
          ? `Summary so far this fold (preserve these facts):\n${mergedPrior}\n\n---\n\n`
          : ''
    const room = Math.max(2000, charCap - rollingPrefix.length)
    const historyText = `${rollingPrefix}${formatMessagesForCompaction(chunk).slice(0, room)}`
    if (!historyText.trim()) continue

    const summary = await summarizeHistoryChunk({
      provider: input.provider,
      model: input.model,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      signal: input.signal,
      historyText,
      supportsStructuredOutput: input.supportsStructuredOutput,
      focus: input.focus,
      ...(input.onAuxUsage ? { onAuxUsage: input.onAuxUsage } : {})
    })
    if (input.signal.aborted) return null
    if (!summary) continue
    parts.push(summary)
    mergedPrior = mergedPrior
      ? capRollingSummary(`${mergedPrior}\n\n---\n\n${summary}`, charCap)
      : capRollingSummary(summary, charCap)
  }

  if (input.signal.aborted) return null

  if (parts.length === 0) {
    logger.warn('Compaction produced no summary despite eligible history', {
      scope: 'agent',
      code: 'COMPACTION',
      messageCount: input.messages.length
    })
    return null
  }

  const merged = capRollingSummary(parts.length === 1 && !prior ? parts[0]! : mergedPrior, charCap)
  return {
    summary: merged,
    createdAt: new Date().toISOString(),
    tokenEstimate: await estimateTextTokensAsync(merged)
  }
}

/** Keep the last ~N user/assistant turns (tool pairs included).
 * BPE for uncached strings runs off the main thread when workers are available. */
export async function preserveRecentMessagesAsync(
  messages: ChatMessage[],
  keepTurns = KEEP_RECENT_TURNS,
  historyBudgetTokens?: number,
  model?: ModelInfo
): Promise<ChatMessage[]> {
  let userTurns = 0
  let start = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      userTurns++
      if (userTurns >= keepTurns) {
        start = i
        break
      }
    }
  }

  if (userTurns < keepTurns) {
    if (!historyBudgetTokens || !model) return messages
    if ((await estimateMessagesTokensAsync(messages, model)) <= historyBudgetTokens) return messages
    start = Math.min(start + 2, messages.length - 1)
  }

  let kept = stripLeadingOrphanToolMessages(messages.slice(start))
  while (kept.length === 0 && start > 0) {
    start--
    kept = stripLeadingOrphanToolMessages(messages.slice(start))
  }
  if (kept.length === 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'tool') return messages.slice(i)
    }
    return messages.slice(-1)
  }

  if (historyBudgetTokens && model) {
    while (
      kept.length > 2 &&
      (await estimateMessagesTokensAsync(kept, model)) > historyBudgetTokens
    ) {
      const dropIdx = kept.findIndex((m) => m.role === 'user')
      if (dropIdx < 0) break
      const nextUser = kept.findIndex((m, idx) => idx > dropIdx && m.role === 'user')
      const end = nextUser >= 0 ? nextUser : kept.length
      const next = stripLeadingOrphanToolMessages(kept.slice(end))
      if (next.length === 0) break
      kept = next
    }
  }

  return kept
}
