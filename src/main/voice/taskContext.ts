/**
 * The task the voice is on, as the voice reads it (docs/voice-mode.md §25):
 * what you asked the agent and what it answered, oldest first, never its
 * tool output. Voice mode opened on a task used to start from nothing and
 * told you it had "no record of the earlier session".
 */
import { contentDisplayText, type ChatMessage } from '../../shared/ipc'
import { stripSpokenBlock } from '../../shared/spokenSummary'
import { redactSecretsInText } from '../../shared/utils/redactSecrets'

/** Room for the task in the voice's context: enough for a long task's gist, small enough to stay fast. */
export const TASK_CONTEXT_CHARS = 9_000
/** Turns kept at most (a turn: your message, or the agent's answer to it). */
const MAX_TURNS = 16
const YOU_CHARS = 900
const AGENT_CHARS = 1_400
/** Messages read from the end of the transcript: a long run is mostly tool steps. */
export const TASK_CONTEXT_MESSAGES = 400

function clip(text: string, max: number): string {
  const flat = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** How the task's last run ended, from its status.json. */
export type TaskEnded = { status: 'running' | 'done' | 'error' | 'cancelled'; error?: string }

/**
 * The task's conversation for the voice. `goal`: what the task was started
 * with, put at the top when its first message isn't kept; `earlier`: the
 * messages given don't reach back to the start; `ended`: how its last run ended.
 */
export function formatTaskContext(
  messages: readonly ChatMessage[],
  opts: { goal?: string; earlier?: boolean; ended?: TaskEnded } = {}
): string {
  const turns: Array<{ who: 'You' | 'Agent'; text: string }> = []
  for (const m of messages) {
    if (m.role === 'user' && !m.synthetic) {
      const text = contentDisplayText(m.content)
      if (text.trim()) turns.push({ who: 'You', text: clip(text, YOU_CHARS) })
    } else if (m.role === 'assistant') {
      const text = stripSpokenBlock(contentDisplayText(m.content))
      if (!text.trim()) continue
      const entry = { who: 'Agent' as const, text: clip(text, AGENT_CHARS) }
      // A turn's last words only: the answer, not the notes on the way.
      if (turns.at(-1)?.who === 'Agent') turns[turns.length - 1] = entry
      else turns.push(entry)
    }
  }
  const out: string[] = []
  let room = TASK_CONTEXT_CHARS
  for (const turn of turns.slice(-MAX_TURNS).reverse()) {
    const line = `[${turn.who}] ${turn.text}`
    if (line.length > room) break
    out.unshift(line)
    room -= line.length + 1
  }
  const head = opts.goal?.trim()
  // The task's start fell out of what's kept: say what it was about.
  if (head && (opts.earlier || out.length < turns.length)) {
    const line = `(The task began with: ${clip(head, 300)})`
    if (line.length <= room) {
      out.unshift(line)
      room -= line.length + 1
    }
  }
  // How it ended: a run voice mode didn't follow gives the voice no other way to know.
  const ended = endedLine(opts.ended)
  if (ended && out.length > 0) out.push(ended)
  return redactSecretsInText(out.join('\n'))
}

function endedLine(ended: TaskEnded | undefined): string {
  if (!ended || ended.status === 'running') return ''
  if (ended.status === 'done') return '(Its last run finished.)'
  if (ended.status === 'cancelled') return '(Its last run was stopped before it finished.)'
  const why = ended.error?.trim()
  return why ? `(Its last run stopped with an error: ${clip(why, 300)})` : '(Its last run stopped with an error.)'
}
