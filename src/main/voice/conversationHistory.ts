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
  // Hand-offs not yet followed. A `followed` without an id is a run that was already working
  // (voice mode opened on its task), never a hand-off's: every hand-off's carries its id.
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
      const id = e.handOffId && open.has(e.handOffId) ? e.handOffId : null
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

/**
 * Summaries already read, by file: a list reads again only a file whose size
 * or time changed (the one still being written), not up to 200 of them each
 * time the dialog opens.
 */
const summaries = new Map<string, { size: number; mtimeMs: number; summary: VoiceConversationSummary }>()
/** Past this many, the cache starts over; a few workspaces' worth. */
const MAX_CACHED_SUMMARIES = 1000

async function summaryOf(dir: string, id: string): Promise<VoiceConversationSummary | null> {
  const file = fileFor(dir, id)
  if (!file) return null
  const info = await lstat(file).catch(() => null)
  if (!info || !info.isFile()) return null
  const hit = summaries.get(file)
  if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.summary
  const read = await readVoiceConversation(dir, id)
  if (!read) return null
  if (summaries.size >= MAX_CACHED_SUMMARIES) summaries.clear()
  summaries.set(file, { size: info.size, mtimeMs: info.mtimeMs, summary: read.summary })
  return read.summary
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
  const read = await Promise.all(ids.map((id) => summaryOf(dir, id).catch(() => null)))
  return read.filter((c): c is VoiceConversationSummary => c != null)
}
