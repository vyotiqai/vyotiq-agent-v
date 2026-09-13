import type { ChatMessage } from '../../../shared/ipc'
import { contentToText } from '../../../shared/ipc'

const USER_ANSWERED_RE = /^User answered:\s*([\s\S]*)$/i

/** Split a formatted ask_question tool result into one decision per answer. */
export function parseAskQuestionResult(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const match = trimmed.match(USER_ANSWERED_RE)
  if (!match) return [trimmed.slice(0, 240)]
  const body = (match[1] ?? '').trim()
  if (!body) return []
  const bullets: string[] = []
  for (const raw of body.split(/\r?\n/)) {
    const bullet = raw.trim().match(/^[-*]\s+(.+)$/)
    if (bullet?.[1]) bullets.push(bullet[1].trim().slice(0, 240))
  }
  if (bullets.length > 0) return bullets
  return [body.replace(/\s+/g, ' ').slice(0, 240)]
}

/**
 * Pull user decisions (ask_question answers) out of a message set so they can
 * survive LLM compaction folds. AppData ba335d72: step 73→74 dropped ~51k
 * history tokens without a summary — then the model re-explored instead of
 * executing the answered choice.
 *
 * Multi-question forms from formatQuestionAnswers are
 * `User answered:\n- Prompt?: answer` — every bullet is a decision.
 */
export function extractAskQuestionDecisions(messages: readonly ChatMessage[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'tool' || m.toolName !== 'ask_question') continue
    const text = contentToText(m.content).trim()
    if (!text) continue
    for (const line of parseAskQuestionResult(text)) {
      if (!line || seen.has(line)) continue
      seen.add(line)
      out.push(line)
    }
  }
  return out
}

/** Merge operator focus with ask_question answers for the summarizer. */
export function mergeCompactionFocus(
  operatorFocus: string | undefined,
  decisions: readonly string[]
): string | undefined {
  const parts: string[] = []
  if (decisions.length > 0) {
    parts.push(
      'Preserve these user decisions verbatim in Key Decisions:\n' +
        decisions.map((d) => `- ${d}`).join('\n')
    )
  }
  const trimmed = operatorFocus?.trim()
  if (trimmed) parts.push(trimmed)
  return parts.length ? parts.join('\n\n') : undefined
}

/** System/loop notice that keeps answered decisions after history fold. */
export function loopHintForRetainedDecisions(
  decisions?: readonly string[]
): string | undefined {
  if (!decisions?.length) return undefined
  const lines = decisions.slice(0, 8).map((d) => `- ${d}`)
  const more = decisions.length > 8 ? `\n- (+${decisions.length - 8} more)` : ''
  return [
    'Retained user decisions (do not re-ask; execute these next — do not stop at inspecting files):',
    ...lines
  ].join('\n') + more
}
