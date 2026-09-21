import type { ChatMessage } from '../../../shared/ipc'
import { attachedFileToText } from '../../../shared/ipc'
import type { ModelInfo } from '../../../shared/ipc/schemas/providers'
import { estimateImageTokensWithExpansion } from './imageTokens'
import {
  countTextTokens,
  countTextTokensAsync,
  countTextsTokensAsync,
  encodingForModel,
  type EncodingName
} from './tokenizer'

export function estimateTextTokens(text: string, model?: ModelInfo): number {
  return countTextTokens(text, encodingForModel(model))
}

export async function estimateTextTokensAsync(text: string, model?: ModelInfo): Promise<number> {
  return countTextTokensAsync(text, encodingForModel(model))
}

function dataUrlBase64Length(url: string): number {
  const comma = url.indexOf(',')
  return comma >= 0 ? url.length - comma - 1 : url.length
}

function estimateBinaryPartTokens(bytesApprox: number): number {
  // Rough multimodal heuristic — avoid BPE over full base64.
  return Math.max(256, Math.ceil(bytesApprox / 750))
}

/**
 * One message, split into what needs BPE and what does not.
 *
 * Both estimators read this: the incremental fast path counts `texts` on the
 * main thread, the cold path pushes them into a single worker batch. Keeping
 * one description of a message means the two can no longer drift — they used to
 * be two hand-maintained copies of the same branch set.
 */
function messageParts(
  message: ChatMessage,
  countReasoningReplay: boolean
): { texts: string[]; nonTextTokens: number } {
  const texts: string[] = []
  let nonTextTokens = 0

  if (typeof message.content === 'string') {
    texts.push(message.content)
  } else {
    for (const part of message.content) {
      if (part.type === 'image_url') nonTextTokens += estimateImageTokensWithExpansion(part.url)
      else if (part.type === 'file') texts.push(attachedFileToText(part))
      else if (part.type === 'audio')
        nonTextTokens += estimateBinaryPartTokens(
          Math.ceil((dataUrlBase64Length(part.url) * 3) / 4)
        )
      else if (part.type === 'file_native')
        nonTextTokens += estimateBinaryPartTokens(Math.ceil((part.data.length * 3) / 4))
      else texts.push(part.text)
    }
  }

  // Prefer reasoningState (wire replay) over UI thinking when both exist —
  // counting both double-counts the same reasoning and triggers compaction early.
  // When the provider does not replay reasoning on the wire (it strips prior-turn
  // reasoning and regenerates thinking from context), skip replay-only fields
  // entirely: counting them inflates the wire estimate severalfold above the
  // real request.
  if (countReasoningReplay) {
    if (message.reasoningState) texts.push(JSON.stringify(message.reasoningState))
    else if (message.thinking) texts.push(message.thinking)
  }

  if (message.toolCalls) {
    for (const toolCall of message.toolCalls) {
      texts.push(toolCall.name, toolCall.arguments)
    }
  }

  // toolName is not part of `content`, so it is counted separately.
  if (message.role === 'tool') texts.push(message.toolName ?? '')

  return { texts, nonTextTokens }
}

export interface EstimateMessagesOptions {
  /**
   * Count reasoning replay fields (reasoningState / thinking) in the estimate.
   * Defaults to true. Providers that strip prior-turn reasoning from the wire
   * (they regenerate thinking from context instead of replaying it) must pass
   * false: replay-only fields then inflate the wire estimate severalfold above
   * the real request (observed 46k real -> 709k estimated) and fire compaction
   * far too early.
   */
  countReasoningReplay?: boolean
}

export async function estimateMessagesTokensAsync(
  messages: readonly ChatMessage[],
  model?: ModelInfo,
  options?: EstimateMessagesOptions
): Promise<number> {
  const encoding = encodingForModel(model)
  const countReasoningReplay = options?.countReasoningReplay !== false

  // Prefix total cache: when the previously counted array's last message object is
  // still the last message and the array only grew, the prefix total is still valid
  // — only newly appended messages need counting. This turns the per-step O(N) full
  // re-walk into O(new messages), and collapses the redundant 3x assembleContext
  // calls during a compaction step (same array -> instant hit). Assumes messages are
  // immutable per www: the existing WeakMap cache already relies on this.
  if (messages.length === 0) {
    messagesTotalCache = { tail: null, length: 0, total: 0, encoding, replay: countReasoningReplay }
    return 0
  }
  if (
    messagesTotalCache &&
    messagesTotalCache.encoding === encoding &&
    messagesTotalCache.replay === countReasoningReplay &&
    messages.length >= messagesTotalCache.length &&
    // Immutable messages: when the previously-counted tail is still at index
    // cache.length-1, the whole prefix [0, cache.length) is unchanged (it moved
    // because new messages were appended), so only the appended tail is re-counted.
    messages[messagesTotalCache.length - 1] === messagesTotalCache.tail
  ) {
    let total = messagesTotalCache.total
    for (let i = messagesTotalCache.length; i < messages.length; i++) {
      total += estimateOneMessageTokens(messages[i]!, encoding, countReasoningReplay)
    }
    messagesTotalCache = {
      tail: messages[messages.length - 1],
      length: messages.length,
      total,
      encoding,
      replay: countReasoningReplay
    }
    return total
  }

  // Single worker round-trip for all uncached messages (not one await per message).
  const texts: Array<{ text: string; encoding: EncodingName }> = []
  const spans: Array<{
    message: ChatMessage
    nonTextTokens: number
    start: number
    end: number
  }> = []
  let total = 0

  for (const message of messages) {
    const cached = messageTokenCache.get(message)
    if (cached && cached.encoding === encoding && cached.replay === countReasoningReplay) {
      total += cached.tokens
      continue
    }
    const start = texts.length
    const { texts: messageTexts, nonTextTokens } = messageParts(message, countReasoningReplay)
    for (const text of messageTexts) texts.push({ text, encoding })
    spans.push({ message, nonTextTokens, start, end: texts.length })
  }

  if (spans.length === 0) {
    messagesTotalCache = {
      tail: messages[messages.length - 1],
      length: messages.length,
      total,
      encoding,
      replay: countReasoningReplay
    }
    return total
  }

  const counts = await countTextsTokensAsync(texts)
  for (const span of spans) {
    let n = span.nonTextTokens
    for (let i = span.start; i < span.end; i++) n += counts[i] ?? 0
    messageTokenCache.set(span.message, { encoding, replay: countReasoningReplay, tokens: n })
    total += n
  }
  messagesTotalCache = {
    tail: messages[messages.length - 1]!,
    length: messages.length,
    total,
    encoding,
    replay: countReasoningReplay
  }
  return total
}

const messageTokenCache = new WeakMap<
  object,
  { encoding: EncodingName; replay: boolean; tokens: number }
>()

/**
 * Tracks the last fully-counted messages array so a growing array only re-counts
 * its appended tail. Keyed by the last message object reference (assumed immutable).
 */
let messagesTotalCache: {
  tail: object | null
  length: number
  total: number
  encoding: EncodingName
  replay: boolean
} | null = null

function estimateOneMessageTokens(
  message: ChatMessage,
  encoding: EncodingName,
  countReasoningReplay: boolean
): number {
  const cached = messageTokenCache.get(message)
  if (cached && cached.encoding === encoding && cached.replay === countReasoningReplay) {
    return cached.tokens
  }

  const { texts, nonTextTokens } = messageParts(message, countReasoningReplay)
  let n = nonTextTokens
  for (const text of texts) n += countTextTokens(text, encoding)
  messageTokenCache.set(message, { encoding, replay: countReasoningReplay, tokens: n })
  return n
}

/**
 * Auto-compact trigger decision against a hard window threshold.
 *
 * Prefers the provider-reported input token count when available: the local
 * estimator counts per-message replay fields (reasoningState) that some
 * upstreams never process, so the estimated figure can exceed the real wire
 * size severalfold. When no provider figure exists (first step, or a provider
 * that reports no usage), fall back to the local estimate — safe over-triggers
 * only cost an occasional summarizer call, while under-triggers overflow.
 *
 * The provider figure survives run restarts: the durable loop checkpoint's
 * usageTotals carry the last step's provider-reported input tokens, restored
 * into providerInputTokens on resume (see loop.ts) so a resumed run does not
 * fall back to the replay-inflated estimate before the first usage report
 * arrives.
 */
export function shouldTriggerAutoCompact(
  estimatedTokens: number,
  triggerTokens: number,
  providerInputTokens?: number | null
): { trigger: boolean; source: 'provider' | 'estimate' } {
  if (providerInputTokens != null && providerInputTokens > 0) {
    return { trigger: providerInputTokens >= triggerTokens, source: 'provider' }
  }
  return { trigger: estimatedTokens >= triggerTokens, source: 'estimate' }
}
