import { open, readFile, readdir, stat, unlink } from 'fs/promises'
import { basename, join } from 'path'
import { atomicWriteFileAsync } from '../../storage/atomicWrite'
import { ChatMessageSchema, contentToText, type ChatMessage } from '../../../shared/ipc'
import { logger } from '../../../shared/logger'
import { appendLine, runSerialized, settled } from './jsonl'

/**
 * messages.jsonl — the run's transcript, one ChatMessage per line, oldest
 * first. It is the model's history and the renderer's source of truth, so it
 * is only ever appended to; the two exceptions are a user rewind (which cuts
 * it) and repairing a legacy file, both through `rewriteTranscript`.
 */
export const MESSAGES_FILE = 'messages.jsonl'
/** Heads rotated out by the previous writer; still stitched in by readers. */
const LEGACY_ARCHIVE_PREFIX = 'messages.archive.'

export function transcriptPath(dir: string): string {
  return join(dir, MESSAGES_FILE)
}

/** User messages carry their send time; nothing else does. */
export function withUserSendTime(message: ChatMessage, at = new Date().toISOString()): ChatMessage {
  if (message.role !== 'user' || message.at) return message
  return { ...message, at }
}

/** Queue one message; resolves once it is written (or its write failed — see jsonl.takeFailure). */
export function appendMessage(dir: string, message: ChatMessage): Promise<void> {
  return appendLine(transcriptPath(dir), `${JSON.stringify(withUserSendTime(message))}\n`)
}

/** Wait for queued messages of this run to reach disk. */
export function transcriptSettled(dir: string): Promise<void> {
  return settled(transcriptPath(dir))
}

async function legacyArchives(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((name) => name.startsWith(LEGACY_ARCHIVE_PREFIX) && name.endsWith('.jsonl'))
      .sort()
  } catch {
    return []
  }
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/** Transcript sources oldest first: legacy archives, then the live file. */
async function sourcePaths(dir: string): Promise<string[]> {
  return [...(await legacyArchives(dir)).map((name) => join(dir, name)), transcriptPath(dir)]
}

function parseLines(text: string, runId: string, skip: number): ChatMessage[] {
  const out: ChatMessage[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      logger.warn('Skipping unparseable messages.jsonl line', { scope: 'store', correlationId: runId })
      continue
    }
    const parsed = ChatMessageSchema.safeParse(json)
    if (!parsed.success) {
      logger.warn('Skipping malformed messages.jsonl row', { scope: 'store', correlationId: runId })
      continue
    }
    if (skipped < skip) {
      skipped++
      continue
    }
    out.push(parsed.data)
  }
  return out
}

/**
 * The whole transcript, oldest first. `skip` drops that many leading messages
 * without keeping them (a compaction watermark: folded bodies never need to
 * be materialized). A run with no transcript file reads as empty; every other
 * read error THROWS — the previous reader returned [] and callers wrote that
 * emptiness back over the real history.
 */
export async function readTranscript(dir: string, opts?: { skip?: number }): Promise<ChatMessage[]> {
  await settled(transcriptPath(dir))
  const parts: string[] = []
  for (const path of await sourcePaths(dir)) {
    try {
      parts.push(await readFile(path, 'utf8'))
    } catch (err) {
      if (!isMissing(err)) throw err
    }
  }
  return parseLines(parts.join(''), basename(dir), Math.max(0, Math.floor(opts?.skip ?? 0)))
}

/**
 * Replace the transcript with `messages` (rewind, legacy repair). Serialized
 * behind queued appends so no buffered line is lost; legacy archives go once
 * the replacement — which carries their content — is in place.
 */
export function rewriteTranscript(dir: string, messages: ChatMessage[]): Promise<void> {
  const path = transcriptPath(dir)
  return runSerialized(path, async () => {
    const body = messages.map((m) => JSON.stringify(m)).join('\n')
    await atomicWriteFileAsync(path, body ? `${body}\n` : '')
    for (const name of await legacyArchives(dir)) {
      await unlink(join(dir, name)).catch(() => undefined)
    }
  })
}

// ---------------------------------------------------------------------------
// Bounded reads for the renderer.

const WINDOW_BYTE_BUDGET = 4 * 1024 * 1024
const WINDOW_DEFAULT_LIMIT = 400
const WINDOW_MAX_LIMIT = 2000

export type TranscriptWindow = {
  messages: ChatMessage[]
  hasEarlier: boolean
  earlierCursor: string | null
}

type Source = { path: string; size: number }

async function nonEmptySources(dir: string): Promise<Source[]> {
  const out: Source[] = []
  for (const path of await sourcePaths(dir)) {
    try {
      const st = await stat(path)
      if (st.isFile() && st.size > 0) out.push({ path, size: st.size })
    } catch (err) {
      if (!isMissing(err)) throw err
    }
  }
  return out
}

type ByteWindow = { buf: Buffer; start: number }

/** Up to `budget` bytes ending at `end`, trimmed to whole lines. */
async function readByteWindow(path: string, end: number, budget: number): Promise<ByteWindow | null> {
  if (end <= 0) return null
  const start = Math.max(0, end - budget)
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(end - start)
    const { bytesRead } = await handle.read(buf, 0, buf.length, start)
    if (bytesRead <= 0) return null
    let from = 0
    if (start > 0) {
      const firstNewline = buf.indexOf(0x0a)
      if (firstNewline === -1 || firstNewline >= bytesRead) return null
      from = firstNewline + 1
    }
    const lastNewline = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
    if (lastNewline < from) return null
    return { buf: buf.subarray(from, lastNewline + 1), start: start + from }
  } finally {
    await handle.close()
  }
}

function parseByteWindow(window: ByteWindow): Array<{ message: ChatMessage; offset: number }> {
  const out: Array<{ message: ChatMessage; offset: number }> = []
  const { buf } = window
  let lineStart = 0
  while (lineStart < buf.length) {
    const newline = buf.indexOf(0x0a, lineStart)
    const lineEnd = newline === -1 ? buf.length : newline
    if (lineEnd > lineStart) {
      try {
        const parsed = ChatMessageSchema.safeParse(JSON.parse(buf.toString('utf8', lineStart, lineEnd)))
        if (parsed.success) out.push({ message: parsed.data, offset: window.start + lineStart })
      } catch {
        // An unparseable line is skipped, as every transcript reader does.
      }
    }
    if (newline === -1) break
    lineStart = newline + 1
  }
  return out
}

function parseCursor(cursor: string): { index: number; offset: number } | null {
  const sep = cursor.indexOf(':')
  if (sep <= 0) return null
  const index = Number(cursor.slice(0, sep))
  const offset = Number(cursor.slice(sep + 1))
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(offset) || offset <= 0) return null
  return { index, offset }
}

/**
 * At most `limit` of the most recent messages, reading byte windows from the
 * tail instead of the whole file. `cursor` (from a previous window) pages back
 * through earlier messages; offsets are stable because the transcript is
 * append-only. A stale cursor (a rewind cut the file) yields an empty window
 * with `hasEarlier: false`, so the caller re-hydrates from the tail.
 */
export async function readTranscriptWindow(
  dir: string,
  opts?: { limit?: number; cursor?: string | null }
): Promise<TranscriptWindow> {
  await settled(transcriptPath(dir))
  const sources = await nonEmptySources(dir)
  const limit = Math.max(1, Math.min(opts?.limit ?? WINDOW_DEFAULT_LIMIT, WINDOW_MAX_LIMIT))
  let index = sources.length - 1
  let endOffset: number | undefined
  if (opts?.cursor) {
    const cursor = parseCursor(opts.cursor)
    if (!cursor || cursor.index >= sources.length) {
      return { messages: [], hasEarlier: false, earlierCursor: null }
    }
    index = cursor.index
    endOffset = cursor.offset
  }
  const messages: ChatMessage[] = []
  let firstIndex = -1
  let firstOffset = -1
  for (let i = index; i >= 0 && messages.length < limit; i--) {
    const source = sources[i]!
    const end = i === index && endOffset != null ? Math.min(endOffset, source.size) : source.size
    const window = await readByteWindow(source.path, end, WINDOW_BYTE_BUDGET)
    if (!window) continue
    const parsed = parseByteWindow(window)
    if (parsed.length === 0) continue
    const take = parsed.slice(Math.max(0, parsed.length - (limit - messages.length)))
    messages.unshift(...take.map((item) => item.message))
    firstIndex = i
    firstOffset = take[0]!.offset
  }
  const hasEarlier = firstIndex > 0 || firstOffset > 0
  return { messages, hasEarlier, earlierCursor: hasEarlier ? `${firstIndex}:${firstOffset}` : null }
}

const TOOL_RESULT_SCAN_WINDOW = 256 * 1024

function toolResultFromLine(line: string, toolCallId: string, encodedId: string): string | null {
  // Cheap pre-filter before a full parse: most lines are not this result.
  if (!line || !line.includes(encodedId)) return null
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return null
  }
  const parsed = ChatMessageSchema.safeParse(json)
  if (!parsed.success || parsed.data.role !== 'tool' || parsed.data.toolCallId !== toolCallId) {
    return null
  }
  const content = parsed.data.content
  return typeof content === 'string' ? content : contentToText(content)
}

/** Newest-first scan of one file in growing tail windows. */
async function scanForToolResult(path: string, toolCallId: string): Promise<string | null> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
  try {
    const encodedId = JSON.stringify(toolCallId).slice(1, -1)
    const { size } = await handle.stat()
    // Bytes read but not yet scanned: the possibly partial first line of the
    // window after this one, which continues into the bytes before it.
    let carry = Buffer.alloc(0)
    for (let end = size; end > 0; ) {
      const start = Math.max(0, end - TOOL_RESULT_SCAN_WINDOW)
      const buf = Buffer.alloc(end - start)
      await handle.read(buf, 0, buf.length, start)
      const combined = Buffer.concat([buf, carry])
      end = start
      let from = 0
      if (start > 0) {
        const firstNewline = combined.indexOf(0x0a)
        if (firstNewline === -1) {
          carry = combined
          continue
        }
        carry = Buffer.from(combined.subarray(0, firstNewline))
        from = firstNewline + 1
      }
      const lines = combined.subarray(from).toString('utf8').split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const hit = toolResultFromLine(lines[i]!, toolCallId, encodedId)
        if (hit !== null) return hit
      }
    }
    return null
  } finally {
    await handle.close()
  }
}

/**
 * Full persisted output of one tool call (the renderer receives a preview and
 * expands lazily). Scans newest first — recent output sits near the tail —
 * and continues into legacy archives, which the previous reader never looked
 * at, so output rotated out of the live file could not be expanded.
 */
export async function readToolResult(dir: string, toolCallId: string): Promise<string | null> {
  await settled(transcriptPath(dir))
  const paths = await sourcePaths(dir)
  for (let i = paths.length - 1; i >= 0; i--) {
    const hit = await scanForToolResult(paths[i]!, toolCallId)
    if (hit !== null) return hit
  }
  return null
}
