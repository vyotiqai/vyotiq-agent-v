import { createHash } from 'crypto'

// Continuation-prompt LRU shared by the OpenAI Responses and Gemini transports:
// request id -> sha256(model + '\0' + stable system zone). A matching key means
// the stable system zone is unchanged, so the cached prompt prefix stays valid.
//
// Main-process only: node:crypto cannot be bundled into the renderer, and every
// consumer (openaiResponses / geminiInteractions transports) runs in main.
export const continuationPromptKeys = new Map<string, string>()
const MAX_CONTINUATION_KEYS = 256

export function stablePromptKey(req: {
  model: string
  systemStable?: string
}): string | undefined {
  if (req.systemStable === undefined) return undefined
  const stable = req.systemStable.trim()
  return createHash('sha256').update(req.model).update('\0').update(stable).digest('hex')
}

/** Drop an id the host has disowned so later turns cannot re-offer it. */
export function forgetContinuationPrompt(id: string): void {
  continuationPromptKeys.delete(id)
}

export function rememberContinuationPrompt(id: string, key: string): void {
  continuationPromptKeys.delete(id)
  continuationPromptKeys.set(id, key)
  if (continuationPromptKeys.size > MAX_CONTINUATION_KEYS) {
    const oldest = continuationPromptKeys.keys().next().value
    if (oldest) continuationPromptKeys.delete(oldest)
  }
}