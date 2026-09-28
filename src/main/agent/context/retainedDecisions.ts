import type { ChatMessage } from '../../../shared/ipc'
import { contentToText } from '../../../shared/ipc'

const USER_ANSWERED_RE = /^User answered:[ \t]*([\s\S]*)$/i

/** Decisions carried on a compaction record (its schema caps at the same count). */
export const RETAINED_DECISIONS_MAX = 8

/** Longest decision kept — pinFoldFacts clips at the same length. */
const DECISION_MAX_CHARS = 240
/** Prompt share of a clipped decision; the answer keeps the rest. */
const DECISION_PROMPT_MAX_CHARS = 120

/**
 * Where the prompt ends in a `- <prompt>: <answer>` bullet. The first `?: `
 * wins (prompts end in a question mark), else the first `: `. Taking the first
 * rather than the last never lets answer text leak into the prompt side.
 */
export function askQuestionPromptEnd(decision: string): number {
  const q = decision.indexOf('?: ')
  if (q >= 0) return q + 1
  return decision.indexOf(': ')
}

/** Fit one decision in DECISION_MAX_CHARS, clipping the prompt before the answer. */
function clipDecision(decision: string): string {
  const flat = decision.replace(/\s+/g, ' ').trim()
  if (flat.length <= DECISION_MAX_CHARS) return flat
  const end = askQuestionPromptEnd(flat)
  if (end > DECISION_PROMPT_MAX_CHARS) {
    const prompt = `${flat.slice(0, DECISION_PROMPT_MAX_CHARS - 1).trimEnd()}…`
    const joined = `${prompt}${flat.slice(end)}`
    if (joined.length <= DECISION_MAX_CHARS) return joined
    return `${joined.slice(0, DECISION_MAX_CHARS - 1)}…`
  }
  return `${flat.slice(0, DECISION_MAX_CHARS - 1)}…`
}

/**
 * Split a formatted ask_question tool result into one decision per answer.
 * Only real answers count: skips, supersedes, failures and stubs return [],
 * as do `(no answer)` bullets — none of them is something the user decided.
 */
export function parseAskQuestionResult(text: string): string[] {
  const trimmed = text.trim()
  const match = trimmed.match(USER_ANSWERED_RE)
  if (!match) return []
  const rest = match[1] ?? ''
  const body = rest.trim()
  if (!body) return []
  // Older single-question shape: `User answered: <value>` on the same line.
  // The whole value is one decision, even when it spans lines or holds bullets.
  if (/^[^\r\n]*\S/.test(rest)) return [clipDecision(body)]
  const bullets: string[] = []
  for (const raw of body.split(/\r?\n/)) {
    const bullet = raw.match(/^[-*]\s+(.+)$/)
    if (bullet?.[1]) {
      bullets.push(bullet[1].trim())
    } else if (raw.trim() && bullets.length > 0) {
      // Indented continuation of a multi-line answer.
      bullets[bullets.length - 1] += ` ${raw.trim()}`
    }
  }
  return bullets.filter((b) => !/:\s*\(no answer\)$/i.test(b)).map(clipDecision)
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
    if (m.role !== 'tool' || m.toolName !== 'ask_question' || m.ok === false) continue
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
  // Newest kept: a later answer can replace an earlier one.
  const lines = decisions.slice(-RETAINED_DECISIONS_MAX).map((d) => `- ${d}`)
  const earlier =
    decisions.length > RETAINED_DECISIONS_MAX
      ? [`- (+${decisions.length - RETAINED_DECISIONS_MAX} earlier)`]
      : []
  return [
    'Retained user decisions (do not re-ask; execute these next — do not stop at inspecting files):',
    ...earlier,
    ...lines
  ].join('\n')
}
