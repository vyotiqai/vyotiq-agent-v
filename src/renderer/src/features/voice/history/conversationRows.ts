import type { VoiceConversationEntry } from '@shared/ipc/schemas/voiceConversations'
import { HAND_OFF_FAILED } from '../view/parts'

/*
  A kept voice conversation as the history view reads it (docs/voice-mode.md
  §24.8): the exchange, with each hand-off carrying what became of it, and the
  turns that weren't turns (no words, the agent's echo, noise) and errors kept
  out of the way as one count.
*/

export type HandOffOutcome =
  | { kind: 'sent'; runId: string }
  | { kind: 'not_sent'; reason: string }
  /** No `followed` or `not_sent` came back: the session ended first. */
  | { kind: 'unknown' }

export type ConversationRow =
  /** A break of {@link GAP_MS} or more: the time it picked up again. */
  | { kind: 'gap'; id: string; at: string }
  /** `unanswered`: heard and left unanswered on purpose, as the live view marks it. */
  | { kind: 'you'; id: string; at: string; text: string; stop: boolean; unanswered?: true }
  /** One reply, its sentences joined: the voice you talk to, or the task speaking. */
  | { kind: 'voice' | 'agent'; id: string; at: string; text: string }
  | { kind: 'hand_off'; id: string; at: string; brief: string; outcome: HandOffOutcome }
  /** A run took your words with no hand-off before it (added to running work). */
  | { kind: 'followed'; id: string; at: string; runId: string }
  | { kind: 'answered'; id: string; at: string; what: 'approval' | 'question'; text: string; decision?: string; tool?: string }
  | { kind: 'stop_agent'; id: string; at: string; by: 'you' | 'voice' }
  /** Something the voice did in the app (§24.15), and how it went. */
  | { kind: 'app_action'; id: string; at: string; action: string; ok: boolean; message: string }

export type ConversationQuiet = {
  dropped: number
  errors: { side: string; code: string }[]
}

/** Past this, the next row says when it picked up again. */
export const GAP_MS = 5 * 60_000

export function conversationRows(entries: readonly VoiceConversationEntry[]): { rows: ConversationRow[]; quiet: ConversationQuiet } {
  const rows: ConversationRow[] = []
  const quiet: ConversationQuiet = { dropped: 0, errors: [] }
  const handOffs = new Map<string, Extract<ConversationRow, { kind: 'hand_off' }>>()
  const yours = new Map<string, Extract<ConversationRow, { kind: 'you' }>>()
  let lastAt: number | null = null
  let reply: { row: Extract<ConversationRow, { kind: 'voice' | 'agent' }>; contextId: string } | null = null
  entries.forEach((e, i) => {
    const id = `${i}`
    const at = Date.parse(e.at)
    const push = (row: ConversationRow): void => {
      if (lastAt != null && Number.isFinite(at) && at - lastAt >= GAP_MS) rows.push({ kind: 'gap', id: `gap-${i}`, at: e.at })
      if (Number.isFinite(at)) lastAt = at
      rows.push(row)
    }
    switch (e.kind) {
      case 'you': {
        const row: Extract<ConversationRow, { kind: 'you' }> = { kind: 'you', id, at: e.at, text: e.text, stop: e.stop === true }
        yours.set(e.turnId, row)
        push(row)
        return
      }
      case 'unanswered': {
        // Words that were never a turn come with their text; a turn it stayed quiet on is marked where it is.
        if (e.text) push({ kind: 'you', id, at: e.at, text: e.text, stop: false, unanswered: true })
        else {
          const row = yours.get(e.turnId)
          if (row) row.unanswered = true
        }
        return
      }
      case 'voice':
      case 'agent': {
        // A reply's sentences read as one line while nothing falls between them.
        const last = rows.at(-1)
        if (reply && last === reply.row && reply.contextId === e.contextId && last.kind === e.kind) {
          reply.row.text = `${reply.row.text} ${e.text}`
          return
        }
        const row: Extract<ConversationRow, { kind: 'voice' | 'agent' }> = { kind: e.kind, id, at: e.at, text: e.text }
        reply = { row, contextId: e.contextId }
        push(row)
        return
      }
      case 'hand_off': {
        const row: Extract<ConversationRow, { kind: 'hand_off' }> = { kind: 'hand_off', id, at: e.at, brief: e.brief, outcome: { kind: 'unknown' } }
        handOffs.set(e.handOffId, row)
        push(row)
        return
      }
      case 'followed': {
        const target =
          (e.handOffId ? handOffs.get(e.handOffId) : undefined) ??
          [...handOffs.values()].reverse().find((h) => h.outcome.kind === 'unknown')
        if (target && target.outcome.kind === 'unknown') {
          target.outcome = { kind: 'sent', runId: e.runId }
          return
        }
        push({ kind: 'followed', id, at: e.at, runId: e.runId })
        return
      }
      case 'not_sent': {
        const target = handOffs.get(e.handOffId)
        if (target) target.outcome = { kind: 'not_sent', reason: e.reason }
        return
      }
      case 'answered':
        push({
          kind: 'answered',
          id,
          at: e.at,
          what: e.what,
          text: e.text,
          ...(e.decision ? { decision: e.decision } : {}),
          ...(e.tool ? { tool: e.tool } : {})
        })
        return
      case 'stop_agent':
        push({ kind: 'stop_agent', id, at: e.at, by: e.by })
        return
      case 'app_action':
        push({ kind: 'app_action', id, at: e.at, action: e.action, ok: e.ok, message: e.message })
        return
      case 'dropped':
        quiet.dropped++
        return
      case 'error':
        quiet.errors.push({ side: e.side, code: e.code })
        return
      case 'start':
      case 'task':
      case 'end':
        return
    }
  })
  return { rows, quiet }
}

/** Why a hand-off didn't go, as the live view says it (§24.8 A-54). */
export function notSentText(reason: string): string {
  return (HAND_OFF_FAILED as Readonly<Record<string, string>>)[reason] ?? `Not sent: ${reason}`
}
