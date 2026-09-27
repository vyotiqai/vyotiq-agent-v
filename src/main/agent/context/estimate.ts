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
 * The single description of a countable message: `texts` go into one batched
 * worker encode, `nonTextTokens` are heuristic and need no BPE at all. This was
 * once duplicated across a synchronous and a batched estimator, which is how the
 * two drifted; there is only one walk now.
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

  if (messages.length === 0) return 0

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

  if (spans.length === 0) return total

  const counts = await countTextsTokensAsync(texts)
  for (const span of spans) {
    let n = span.nonTextTokens
    for (let i = span.start; i < span.end; i++) n += counts[i] ?? 0
    messageTokenCache.set(span.message, { encoding, replay: countReasoningReplay, tokens: n })
    total += n
  }
  return total
}

/**
 * Per-message counts, keyed on the message object. This is the only cache: an
 * unchanged history is N map lookups plus BPE for the appended tail.
 *
 * A whole-array total used to sit on top, keyed on the array object. Assemble
 * builds a fresh array every call, so it never hit on the per-step path, and it
 * answered for an array that had been pushed to since with the stale total.
 */
const messageTokenCache = new WeakMap<
  object,
  { encoding: EncodingName; replay: boolean; tokens: number }
>()

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
