/** Shared last-wins-by-id tool call dedupe (Gemini re-emits mid-stream updates). */
import { randomUUID } from 'crypto'
import type { ToolCall } from './providers/types'

export function dedupeToolCalls(calls: ToolCall[]): ToolCall[] {
  const seen = new Map<string, ToolCall>()
  calls.forEach((call, index) => {
    // Without an id there is nothing that reliably identifies a call, and two
    // genuine calls can share name+arguments — key on position so they survive.
    const key = call.id?.trim() || `@${index}:${call.name}`
    seen.set(key, call)
  })
  return [...seen.values()]
}

/**
 * Providers sometimes emit empty tool-call ids (DeepSeek OpenAI-compat). Fill
 * stable ids before persist/execute so chrome, messages, and tool results link.
 */
export function ensureToolCallIds(
  calls: ToolCall[],
  opts?: { step?: number; prefix?: string }
): ToolCall[] {
  const prefix = opts?.prefix ?? 'call'
  const step = opts?.step
  return calls.map((call, index) => {
    const trimmed = call.id?.trim()
    if (trimmed) return trimmed === call.id ? call : { ...call, id: trimmed }
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
    const id =
      step != null ? `${prefix}_${step}_${index}_${suffix}` : `${prefix}_${index}_${suffix}`
    return { ...call, id }
  })
}
