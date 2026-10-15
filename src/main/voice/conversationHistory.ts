/**
 * Kept voice conversations, read back (docs/voice-mode.md §24.8): the list for
 * a workspace and one conversation line by line. The writer is
 * `conversationLog.ts`; this side only reads, and only inside the voice
 * folder it is given — an id is a validated file name, never a path, and a
 * link or folder there is not followed.
 */
import { lstat, open, readdir } from 'fs/promises'
import { basename, dirname, resolve } from 'path'
import {
  VOICE_CONVERSATION_ID_RE,
  VoiceConversationEntrySchema,
  type VoiceConversation,
  type VoiceConversationEntry,
  type VoiceConversationSummary
} from '../../shared/ipc/schemas/voiceConversations'

/** More than any session writes (words are the bulk; 21 turns came to ~12 KB): a file past it is read only this far. */
export const MAX_VOICE_LOG_BYTES = 4 * 1024 * 1024
const FIRST_WORDS = 120

/** `2026-10-14T16-52-00-000Z` back to an ISO time. */
function startedFromId(id: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(id)
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : ''
}

/** The file for an id, or null when the id could name anything but a file directly in `dir`. */
function fileFor(dir: string, id: string): string | null {
  if (!VOICE_CONVERSATION_ID_RE.test(id)) return null
  const root = resolve(dir)
  const file = resolve(root, `${id}.jsonl`)
  return dirname(file) === root ? file : null
}

async function readCapped(file: string): Promise<string | null> {
  const info = await lstat(file).catch(() => null)
  if (!info || !info.isFile()) return null
  const handle = await open(file, 'r')
  try {
    const size = Math.min(info.size, MAX_VOICE_LOG_BYTES)
    const buf = Buffer.alloc(size)
    const { bytesRead } = await handle.read(buf, 0, size, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export function parseVoiceLog(text: string): { entries: VoiceConversationEntry[]; skipped: number } {
  const entries: VoiceConversationEntry[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = VoiceConversationEntrySchema.safeParse(JSON.parse(line))
      if (parsed.success) entries.push(parsed.data)
      else skipped++
    } catch {
      skipped++
    }
  }
  return { entries, skipped }
}

export function summarizeVoiceLog(id: string, entries: readonly VoiceConversationEntry[]): VoiceConversationSummary {
  let turns = 0
  let firstWords = ''
  let handOffs = 0
  let notSent = 0
  let endedAt: string | null = null
  const runIds: string[] = []
  const sent: { runId: string; brief: string }[] = []
  // Hand-offs not yet followed, oldest first: a `followed` without an id takes the latest.
  const open = new Map<string, string>()
  for (const e of entries) {
    if (e.kind === 'you') {
      turns++
      if (!firstWords && !e.stop) firstWords = e.text.trim().slice(0, FIRST_WORDS)
    } else if (e.kind === 'hand_off') {
      handOffs++
      open.set(e.handOffId, e.brief)
    } else if (e.kind === 'not_sent') {
      notSent++
      open.delete(e.handOffId)
    } else if (e.kind === 'followed') {
      if (!runIds.includes(e.runId)) runIds.push(e.runId)
      const id = e.handOffId && open.has(e.handOffId) ? e.handOffId : [...open.keys()].at(-1)
      sent.push({ runId: e.runId, brief: id ? open.get(id)! : '' })
      if (id) open.delete(id)
    } else if (e.kind === 'end') endedAt = e.at
  }
  return {
    id,
    startedAt: entries[0]?.at ?? startedFromId(id),
    endedAt,
    turns,
    firstWords,
    runIds,
    sent,
    handOffs,
    notSent
  }
}

/** One conversation, or null when there is no such file in `dir`. */
export async function readVoiceConversation(dir: string, id: string): Promise<VoiceConversation | null> {
  const file = fileFor(dir, id)
  if (!file) return null
  const text = await readCapped(file).catch(() => null)
  if (text == null) return null
  const { entries, skipped } = parseVoiceLog(text)
  return { summary: summarizeVoiceLog(id, entries), entries, skipped }
}

/** Conversations looked through for a task's last one: the newest few, so a session start stays quick. */
const PAST_LOOKBACK = 20
/** What a new session takes from the last conversation on its task: its end, enough for "continue". */
const PAST_ENTRIES = 24

/**
 * The newest kept conversation on this task (`task` or `followed` names its
 * run), other than session `skipSessionId`'s own: what a new voice session picks up from. On
 * 2026-10-15 a session opened four seconds after Ajay stopped wrong work, and
 * "Continue." handed that same work back to the agent: the voice had no
 * memory of being told to stop.
 */
export async function lastConversationForRun(
  dir: string,
  runId: string,
  skipSessionId?: string
): Promise<{ id: string; entries: VoiceConversationEntry[] } | null> {
  const names = await readdir(dir).catch(() => [] as string[])
  const ids = names
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => basename(n, '.jsonl'))
    .filter((id) => VOICE_CONVERSATION_ID_RE.test(id) && !(skipSessionId && id.endsWith(`_${skipSessionId}`)))
    .sort()
    .reverse()
    .slice(0, PAST_LOOKBACK)
  for (const id of ids) {
    const conversation = await readVoiceConversation(dir, id).catch(() => null)
    if (!conversation) continue
    const onTask = conversation.entries.some((e) => (e.kind === 'task' || e.kind === 'followed') && e.runId === runId)
    if (onTask) return { id, entries: conversation.entries }
  }
  return null
}

/**
 * A kept conversation as the voice model's memory: your words, its replies
 * (a reply's sentences joined), what it handed on and what was stopped. The
 * end of it, oldest first.
 */
export function pastConversationMessages(entries: readonly VoiceConversationEntry[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = []
  let replyId: string | null = null
  const add = (role: 'user' | 'assistant', content: string, sameReply = false): void => {
    const last = out.at(-1)
    if (last && last.role === role) last.content = `${last.content}${sameReply ? ' ' : '\n'}${content}`
    else out.push({ role, content })
  }
  for (const e of entries.slice(-PAST_ENTRIES)) {
    if (e.kind === 'you') {
      replyId = null
      add('user', e.text)
    } else if (e.kind === 'voice') {
      add('assistant', e.text, replyId === e.contextId)
      replyId = e.contextId
    } else if (e.kind === 'agent') {
      add('assistant', `The agent said: ${e.text}`, replyId === e.contextId)
      replyId = e.contextId
    } else if (e.kind === 'hand_off') {
      replyId = null
      add('assistant', `(Handed to the agent: ${e.brief})`)
    } else if (e.kind === 'stop_agent') {
      replyId = null
      add('assistant', e.by === 'you' ? '(The user stopped the agent’s work.)' : '(I stopped the agent’s work, as the user asked.)')
    } else if (e.kind === 'app_action') {
      replyId = null
      add('assistant', `(In the app, ${e.action}: ${e.ok ? '' : 'didn’t happen, '}${e.message})`)
    }
  }
  // A conversation starts with you.
  while (out[0]?.role === 'assistant') out.shift()
  return out
}

/** Every kept conversation in `dir`, newest first. A missing folder is none yet. */
export async function listVoiceConversations(dir: string): Promise<VoiceConversationSummary[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const ids = names
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => basename(n, '.jsonl'))
    .filter((id) => VOICE_CONVERSATION_ID_RE.test(id))
    .sort()
    .reverse()
  const read = await Promise.all(ids.map((id) => readVoiceConversation(dir, id).catch(() => null)))
  return read.filter((c): c is VoiceConversation => c != null).map((c) => c.summary)
}
