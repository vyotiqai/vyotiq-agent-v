import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync, openSync, readSync, closeSync, fstatSync } from 'fs'
import { readFile, readdir, open, stat } from 'fs/promises'
import { join, basename } from 'path'
import { atomicWriteFile, atomicWriteFileAsync, atomicWriteJson } from '../storage/atomicWrite'
import { enqueueEventAppend, flushEventAppends, listEventArchives, listEventArchivesSync, removeEventArchives } from './eventAppendQueue'
import {
  enqueueMessageAppend,
  enqueueMessageRewrite,
  flushMessageAppends,
  listMessageArchives,
  listMessageArchivesSync,
  removeMessageArchives,
  removeMessageArchivesSync,
  takeMessageAppendFailureNotice
} from './messageAppendQueue'
import { enqueueStatusPatch, flushStatusWrites, writeStatusImmediate, clearStatusWritesForDir } from './statusWriteQueue'
import { getCachedListRuns, invalidateListRunsCache } from './runListCache'
import {
  ChatMessageSchema,
  PersistedEventSchema,
  RunLoopSchema,
  RunStatusSchema,
  contentToText,
  runDoneDedupeKey,
  runErrorDedupeKey,
  type AgentInteractionMode,
  type ChatMessage,
  type AgentEvent,
  type ListRunsResult,
  type MessageContent,
  type PersistedEvent,
  type RunStatus,
  type RunSummary
} from '../../shared/ipc'
import {
  parseProviderReasoningState,
  thinkingFromReasoningState
} from '../../shared/reasoning'
import { logger } from '../../shared/logger'
import { RUN_INTERRUPTED_ERROR } from '../../shared/runInterrupt'
import { workspaceIdFromPath } from '../../shared/utils/workspaceId'
import {
  emptyStepUsageTotals,
  mergeStepUsageTotals,
  stepUsageFromEvent,
  type StepUsageTotals
} from '../../shared/utils/runTelemetry'
import { toolResultEventForPersistence } from '../../shared/utils/toolResultIpc'
import { finalizeInterruptedTodos } from './tools/todo'
import { readGoal } from './runGoal'
import { readLenientReceiptCost } from './runStats'
import { readJsonDocCached } from './jsonDocCache'
import { finalizeTodoContentOnRunEnd, type TodoFinalizeOutcome } from '../../shared/utils/todoContent'
import { DEFAULT_PLAN_STUB, stripPlanStubChrome } from '../../shared/planStub'
import { ensureWorkspaceStorage, resolveRunDir, workspaceSessionsRoot } from '../storage/paths'
import { TOOL_STUB_RESTART_INTERRUPTED } from '../../shared/toolStubs'
import { isActive } from './runRegistry'
import { dismissLifecycleNotification } from '../notifications/bus'
import {
  finalizeInstanceWorktree,
  isSafeInstanceBranch,
  isSafeInstanceWorktreePath
} from '../git/instanceWorktree'
import { CompactionRecordSchema, type CompactionRecord } from './context/types'
import {
  applyFoldedMessagesWatermark,
  stripLeadingOrphanToolMessages
} from './context/foldWatermark'
import { writeRunReceiptBestEffort } from './runReceipt'
import { RUN_LIST_CAP } from '@shared/domain/runs'

export { flushEventAppends, takeEventAppendFailureNotice, onRunStorageLost, clearRunStorageLostHandler } from './eventAppendQueue'
export { flushMessageAppends, takeMessageAppendFailureNotice } from './messageAppendQueue'
export { flushStatusWrites } from './statusWriteQueue'

const CONTRACT_CAP = 4000

function contractCapText(text: string): string {
  const t = text.trim()
  if (!t) return ''
  if (t.length <= CONTRACT_CAP) return t
  return t.slice(0, CONTRACT_CAP) + '\n…'
}

export function readContract(runDir: string): string {
  const p = join(runDir, 'contract.md')
  if (!existsSync(p)) return ''
  try {
    return contractCapText(readFileSync(p, 'utf8'))
  } catch {
    return ''
  }
}

export async function readContractAsync(runDir: string): Promise<string> {
  const p = join(runDir, 'contract.md')
  if (!existsSync(p)) return ''
  try {
    return contractCapText(await readFile(p, 'utf8'))
  } catch {
    return ''
  }
}

export { DEFAULT_PLAN_STUB }

/** Approved/draft plan artifact; empty when missing or still the Plan-mode stub. */
export async function readPlanAsync(runDir: string): Promise<string> {
  const text = await readPlanRawAsync(runDir)
  if (!text) return ''
  const withoutStub = stripPlanStubChrome(text)
  if (withoutStub.replace(/[_*.\s]/g, '').length < 20) return ''
  return text
}

/**
 * Full plan.md contents, stub included and never truncated — the Plan-mode
 * prompt mirrors this verbatim so the model edits against the real file.
 */
export async function readPlanRawAsync(runDir: string): Promise<string> {
  const p = join(runDir, 'plan.md')
  if (!existsSync(p)) return ''
  try {
    return (await readFile(p, 'utf8')).trim()
  } catch {
    return ''
  }
}

export function saveCompaction(runDir: string, record: CompactionRecord): boolean {
  const parsed = CompactionRecordSchema.safeParse(record)
  if (!parsed.success) {
    logger.warn('Invalid compaction record; not saved', {
      scope: 'state',
      correlationId: basename(runDir),
      err: parsed.error
    })
    return false
  }
  try {
    atomicWriteJson(join(runDir, 'compaction.json'), parsed.data)
    return true
  } catch (err) {
    logger.warn('Failed to write compaction.json', {
      scope: 'state',
      correlationId: basename(runDir),
      err
    })
    return false
  }
}

export function loadCompaction(runDir: string): CompactionRecord | null {
  const p = join(runDir, 'compaction.json')
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
    const parsed = CompactionRecordSchema.safeParse(raw)
    if (!parsed.success) {
      logger.warn('Invalid compaction.json', {
        scope: 'state',
        correlationId: basename(runDir)
      })
      return null
    }
    return parsed.data
  } catch (err) {
    logger.warn('Failed to read compaction.json', {
      scope: 'state',
      correlationId: basename(runDir),
      err
    })
    return null
  }
}

export function runExists(workspacePath: string, runId: string): boolean {
  const dir = resolveRunDir(workspacePath, runId)
  return existsSync(dir) && existsSync(join(dir, 'status.json'))
}

export async function resumeRun(workspacePath: string, runId: string): Promise<string> {
  const dir = resolveRunDir(workspacePath, runId)
  if (!existsSync(dir)) {
    throw new Error('Run not found')
  }
  // chatStart may already have queued the follow-up user turn.
  await flushMessageAppends(dir)
  // Close any unfinished tool pairing from a previous crash before continuing.
  appendOrphanToolStubs(dir, runId)
  const prior = loadStatus(dir)
  await updateStatus(
    dir,
    {
      status: 'running',
      // Keep prior step count across invokes (do not reset progress metadata).
      step: prior?.step ?? 0,
      error: undefined,
      resumable: undefined,
      interruptedAt: undefined
    },
    { sync: true }
  )
  return dir
}

export function loadStatus(dir: string): RunStatus | null {
  const p = join(dir, 'status.json')
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
    const parsed = RunStatusSchema.safeParse(raw)
    if (!parsed.success) throw parsed.error
    return parsed.data
  } catch (err) {
    logger.warn('Corrupt status.json; treating as absent', {
      scope: 'state',
      correlationId: basename(dir),
      err
    })
    return null
  }
}

/** Stamp `at` on user messages that were persisted without a send time. */
export function ensureUserMessageAt(
  message: ChatMessage,
  at = new Date().toISOString()
): ChatMessage {
  if (message.role !== 'user' || message.at) return message
  return { ...message, at }
}

export function syncMessages(dir: string, messages: ChatMessage[]): void {
  const body = messages.map((m) => JSON.stringify(m)).join('\n')
  atomicWriteFile(join(dir, 'messages.jsonl'), body ? `${body}\n` : '')
  // The rewritten live file is authoritative and callers pass stitched content;
  // stale archive heads would otherwise be re-prepended by stitched readers and
  // duplicate history on every resume.
  removeMessageArchivesSync(dir)
  invalidateMessagesCache(dir)
}

/** Await pending async appends, then rewrite messages.jsonl (authoritative).
 * Uses the async atomic writer so long-transcript rewrites never block the
 * main-thread event loop mid-run. */
export async function syncMessagesAsync(dir: string, messages: ChatMessage[]): Promise<void> {
  await flushMessageAppends(dir)
  const body = messages.map((m) => JSON.stringify(m)).join('\n')
  await atomicWriteFileAsync(join(dir, 'messages.jsonl'), body ? `${body}\n` : '')
  // Same archive reconciliation as syncMessages — see the comment there.
  await removeMessageArchives(dir)
  invalidateMessagesCache(dir)
}

export function appendMessage(dir: string, message: ChatMessage): Promise<void> {
  const line = `${JSON.stringify(ensureUserMessageAt(message))}\n`
  return enqueueMessageAppend(dir, line)
}

export type CreateRunOptions = {
  mode?: AgentInteractionMode
  parentRunId?: string
  inlineInstance?: true
  pathScope?: string[]
  worktreePath?: string
  worktreeBranch?: string
}

export function createRun(
  workspacePath: string,
  runId: string,
  goal: string,
  modeOrOptions: AgentInteractionMode | CreateRunOptions = 'agent'
): string {
  const options: CreateRunOptions =
    typeof modeOrOptions === 'string' ? { mode: modeOrOptions } : modeOrOptions
  const mode = options.mode ?? 'agent'
  const dir = resolveRunDir(workspacePath, runId)
  ensureWorkspaceStorage(workspacePath)
  mkdirSync(dir, { recursive: true })
  const goalText = goal.trim() || 'chat'
  atomicWriteFile(
    join(dir, 'contract.md'),
    [
      '## Goal',
      '',
      goalText,
      '',
      '## Done when',
      '',
      '- The goal above is satisfied (check outcomes: read results, command output, or user-visible success).',
      '- Or blockers are explained clearly and no further narrow retry will help.',
      '- Update this file if scope or done-when changes.',
      ''
    ].join('\n')
  )
  const status: RunStatus = {
    status: 'running',
    step: 0,
    updatedAt: new Date().toISOString(),
    goal: goalText.slice(0, 200),
    workspacePath,
    mode,
    ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
    ...(options.inlineInstance ? { inlineInstance: true as const } : {}),
    ...(options.pathScope?.length ? { pathScope: options.pathScope } : {}),
    ...(options.worktreePath ? { worktreePath: options.worktreePath } : {}),
    ...(options.worktreeBranch ? { worktreeBranch: options.worktreeBranch } : {})
  }
  atomicWriteJson(join(dir, 'status.json'), status)
  atomicWriteFile(join(dir, 'messages.jsonl'), '')
  atomicWriteFile(join(dir, 'events.jsonl'), '')
  invalidateListRunsCache(workspacePath)
  return dir
}

/** Persist trimmed agent events to events.jsonl (full tool output stays in messages.jsonl). */
export function appendEvent(dir: string, event: unknown): void {
  enqueueEventAppend(dir, event)
}

/** Await pending event appends, then rewrite events.jsonl (authoritative). */
export async function syncEventsAsync(dir: string, events: unknown[]): Promise<void> {
  await flushEventAppends(dir)
  const body = events
    .map((event) =>
      JSON.stringify({
        at: new Date().toISOString(),
        event
      })
    )
    .join('\n')
  atomicWriteFile(join(dir, 'events.jsonl'), body ? `${body}\n` : '')
  // The rewritten live file is authoritative and callers pass the stitched
  // (archive + live) history; stale archive heads would resurrect truncated
  // events for stitched readers (rewind, step-usage totals).
  await removeEventArchives(dir)
}

export async function updateStatus(
  dir: string,
  patch: Partial<RunStatus>,
  options?: { sync?: boolean }
): Promise<void> {
  if (options?.sync) {
    await writeStatusImmediate(
      dir,
      patch,
      (path, next) => atomicWriteJson(path, next),
      (path) => {
        let current: RunStatus = {
          status: 'running',
          step: 0,
          updatedAt: new Date().toISOString()
        }
        try {
          const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
          const parsed = RunStatusSchema.safeParse(raw)
          if (parsed.success) current = parsed.data
        } catch {
          // keep default
        }
        return current
      }
    )
    return
  }
  enqueueStatusPatch(dir, patch)
}

function parseMessagesJsonl(content: string): ChatMessage[] {
  return parseMessagesJsonlSkipping(content, 0)
}

/**
 * Live messages.jsonl content plus any rotated archive heads, oldest first.
 * Rotation keeps only the recent tail in the live file, so readers must stitch
 * archives back in or resumed runs would silently lose early transcript turns.
 */
function stitchedMessagesContentSync(dir: string): string | null {
  const parts: string[] = []
  for (const name of listMessageArchivesSync(dir)) {
    try {
      parts.push(readFileSync(join(dir, name), 'utf8'))
    } catch {
      // skip unreadable archive — the live file still carries the recent tail
    }
  }
  const live = join(dir, 'messages.jsonl')
  if (!existsSync(live)) return parts.length > 0 ? parts.join('') : null
  parts.push(readFileSync(live, 'utf8'))
  return parts.join('')
}

/**
 * Size+mtime fingerprint of the transcript inputs (live file + rotated archives).
 * A handful of stat calls instead of reading and concatenating every archive.
 */
function stitchFingerprint(dir: string): string {
  const parts: string[] = []
  for (const name of listMessageArchivesSync(dir)) {
    try {
      const st = statSync(join(dir, name))
      parts.push(`${name}:${st.size}:${st.mtimeMs}`)
    } catch {
      parts.push(`${name}:?`)
    }
  }
  try {
    const st = statSync(join(dir, 'messages.jsonl'))
    parts.push(`messages.jsonl:${st.size}:${st.mtimeMs}`)
  } catch {
    parts.push('messages.jsonl:-')
  }
  return parts.join('|')
}

/**
 * Memoized stitched read.
 *
 * Compaction re-read the whole transcript on *every* attempt, and once a run is
 * in context overflow that is every step — a multi-MB read plus a per-line
 * `JSON.parse` + zod validation on the main thread, repeatedly. The transcript is
 * append-only (or rotated, which changes the archive list), so size+mtime is a
 * sound fingerprint: any real change moves it.
 */
const STITCH_CACHE_MAX_ENTRIES = 4
const stitchCache = new Map<string, { fingerprint: string; content: string | null }>()

function stitchedMessagesContentCached(dir: string): string | null {
  const fingerprint = stitchFingerprint(dir)
  const cached = stitchCache.get(dir)
  if (cached && cached.fingerprint === fingerprint) return cached.content
  const content = stitchedMessagesContentSync(dir)
  stitchCache.delete(dir)
  stitchCache.set(dir, { fingerprint, content })
  if (stitchCache.size > STITCH_CACHE_MAX_ENTRIES) {
    const oldest = stitchCache.keys().next()
    if (!oldest.done) stitchCache.delete(oldest.value)
  }
  return content
}

/** Drop the memo for one run dir (after a rewrite that re-stitched archives). */
export function invalidateMessagesCache(dir?: string): void {
  if (dir) stitchCache.delete(dir)
  else stitchCache.clear()
}

async function stitchedMessagesContentAsync(dir: string): Promise<string | null> {
  const parts: string[] = []
  for (const name of await listMessageArchives(dir)) {
    try {
      parts.push(await readFile(join(dir, name), 'utf8'))
    } catch {
      // skip unreadable archive — the live file still carries the recent tail
    }
  }
  const live = join(dir, 'messages.jsonl')
  if (!existsSync(live)) return parts.length > 0 ? parts.join('') : null
  parts.push(await readFile(live, 'utf8'))
  return parts.join('')
}

/**
 * Parse messages.jsonl but skip the first `skipCount` successfully-parsed
 * messages (fold watermark). Avoids retaining folded tool bodies as ChatMessage
 * objects — the dominant heap cost of a full reload after compaction.
 */
function parseMessagesJsonlSkipping(content: string, skipCount: number): ChatMessage[] {
  const messages: ChatMessage[] = []
  let skipped = 0
  let lineNo = 0
  for (const line of content.split('\n')) {
    if (!line) continue
    lineNo++
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      logger.warn('Skipping invalid messages.jsonl line (JSON)', {
        scope: 'state',
        line: lineNo
      })
      continue
    }
    const parsed = ChatMessageSchema.safeParse(json)
    if (!parsed.success) {
      logger.warn('Skipping invalid messages.jsonl line (schema)', {
        scope: 'state',
        line: lineNo
      })
      continue
    }
    if (skipped < skipCount) {
      skipped++
      continue
    }
    messages.push(parsed.data)
  }
  return messages
}

export function loadMessages(workspacePath: string, runId: string): ChatMessage[] {
  const dir = resolveRunDir(workspacePath, runId)
  const content = stitchedMessagesContentSync(dir)
  if (content == null) return []
  return parseMessagesJsonl(content)
}

export async function loadMessagesAsync(
  workspacePath: string,
  runId: string
): Promise<ChatMessage[]> {
  const dir = resolveRunDir(workspacePath, runId)
  await flushMessageAppends(dir)
  try {
    const content = await stitchedMessagesContentAsync(dir)
    if (content == null) return []
    return parseMessagesJsonl(content)
  } catch (err) {
    logger.warn('Failed to read messages.jsonl', { scope: 'state', runId, err })
    return []
  }
}

const MESSAGES_WINDOW_BYTE_BUDGET = 4 * 1024 * 1024
const MESSAGES_WINDOW_DEFAULT_LIMIT = 400

export interface MessagesWindow {
  messages: ChatMessage[]
  hasEarlier: boolean
  earlierCursor: string | null
}

interface TranscriptSource {
  path: string
  size: number
}

async function listTranscriptSources(dir: string): Promise<TranscriptSource[]> {
  const paths = (await listMessageArchives(dir)).map((name) => join(dir, name))
  paths.push(join(dir, 'messages.jsonl'))
  const sources: TranscriptSource[] = []
  for (const path of paths) {
    try {
      const st = await stat(path)
      if (st.isFile() && st.size > 0) sources.push({ path, size: st.size })
    } catch {
      // Pruned archive or a run with no live messages yet.
    }
  }
  return sources
}

interface MessageWindow {
  buf: Buffer
  start: number
}

/**
 * Read up to `byteBudget` bytes ending at `endOffset` (exclusive), trimmed to whole
 * lines. Reads only this window, so hydration cost stays bounded for any transcript.
 */
async function readMessageWindow(
  path: string,
  endOffset: number,
  byteBudget: number
): Promise<MessageWindow | null> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return null
  }
  const end = Math.min(endOffset, size)
  if (end <= 0) return null
  const start = Math.max(0, end - byteBudget)
  const handle = await open(path, 'r')
  try {
    const length = end - start
    const buf = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buf, 0, length, start)
    if (bytesRead <= 0) return null
    let windowStart = start
    if (windowStart > 0) {
      const firstNewline = buf.indexOf(0x0a)
      if (firstNewline === -1) return null
      windowStart += firstNewline + 1
    }
    let lastNewline = -1
    for (let i = bytesRead - 1; i >= 0; i--) {
      if (buf[i] === 0x0a) {
        lastNewline = i
        break
      }
    }
    if (lastNewline === -1) return null
    const windowEnd = start + lastNewline + 1
    if (windowEnd <= windowStart) return null
    return { buf: buf.subarray(windowStart - start, windowEnd - start), start: windowStart }
  } finally {
    await handle.close()
  }
}

interface ParsedWindowMessage {
  message: ChatMessage
  offset: number
}

function parseMessageWindow(window: MessageWindow): ParsedWindowMessage[] {
  const out: ParsedWindowMessage[] = []
  const buf = window.buf
  let lineStart = 0
  while (lineStart < buf.length) {
    const newline = buf.indexOf(0x0a, lineStart)
    const lineEnd = newline === -1 ? buf.length : newline
    if (lineEnd > lineStart) {
      try {
        const parsed = ChatMessageSchema.safeParse(JSON.parse(buf.toString('utf8', lineStart, lineEnd)))
        if (parsed.success) out.push({ message: parsed.data, offset: window.start + lineStart })
        else logger.warn('Discarding malformed message line in transcript window', { scope: 'state' })
      } catch {
        logger.warn('Discarding unparseable line in transcript window', { scope: 'state' })
      }
    }
    if (newline === -1) break
    lineStart = newline + 1
  }
  return out
}

function parseWindowCursor(cursor: string): { index: number; offset: number } | null {
  const separator = cursor.indexOf(':')
  if (separator <= 0) return null
  const index = Number(cursor.slice(0, separator))
  const offset = Number(cursor.slice(separator + 1))
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(offset) || offset <= 0) return null
  return { index, offset }
}

/**
 * Bounded transcript hydration: returns at most `limit` messages from the most
 * recent content, reading byte windows from the transcript tail instead of the
 * whole file. `cursor` (from a previous window result) pages backwards through
 * earlier messages. Byte offsets are stable for append-only transcripts; a stale
 * cursor (rewind/compaction rewrote the file) yields an empty window with
 * `hasEarlier: false` so the caller can re-hydrate from the current tail.
 */
export async function loadMessagesWindowAsync(
  workspacePath: string,
  runId: string,
  opts?: { limit?: number; cursor?: string | null }
): Promise<MessagesWindow> {
  const dir = resolveRunDir(workspacePath, runId)
  await flushMessageAppends(dir)
  const sources = await listTranscriptSources(dir)
  const limit = Math.max(1, Math.min(opts?.limit ?? MESSAGES_WINDOW_DEFAULT_LIMIT, 2000))
  let startIndex = sources.length - 1
  let startEndOffset: number | undefined
  if (opts?.cursor) {
    const parsedCursor = parseWindowCursor(opts.cursor)
    if (!parsedCursor || parsedCursor.index >= sources.length) {
      return { messages: [], hasEarlier: false, earlierCursor: null }
    }
    startIndex = parsedCursor.index
    startEndOffset = parsedCursor.offset
  }
  const messages: ChatMessage[] = []
  let firstIndex = -1
  let firstOffset = -1
  for (let i = startIndex; i >= 0 && messages.length < limit; i--) {
    const endOffset =
      i === startIndex && startEndOffset != null
        ? Math.min(startEndOffset, sources[i].size)
        : sources[i].size
    const window = await readMessageWindow(sources[i].path, endOffset, MESSAGES_WINDOW_BYTE_BUDGET)
    if (!window) continue
    const parsed = parseMessageWindow(window)
    if (parsed.length === 0) continue
    const need = limit - messages.length
    const take = need >= parsed.length ? parsed : parsed.slice(parsed.length - need)
    messages.unshift(...take.map((item) => item.message))
    firstIndex = i
    firstOffset = take[0].offset
  }
  const hasEarlier = firstIndex > 0 || firstOffset > 0
  return {
    messages,
    hasEarlier,
    earlierCursor: hasEarlier ? `${firstIndex}:${firstOffset}` : null
  }
}

/**
 * Post-fold working set without materializing folded ChatMessage bodies.
 * Falls back to a full parse only when the post-fold window is entirely orphan tools
 * (matches `applyFoldedMessagesWatermark` rewind semantics).
 */
export function loadWorkingMessagesForFold(
  workspacePath: string,
  runId: string,
  foldedMessages: number
): { messages: ChatMessage[]; foldedMessages: number } {
  const fold = Math.max(0, Math.floor(foldedMessages))
  const dir = resolveRunDir(workspacePath, runId)
  // Single stitched read for the whole decision instead of reading and
  // parsing the entire transcript twice per compaction attempt.
  const content = stitchedMessagesContentCached(dir)
  if (content == null) return { messages: [], foldedMessages: 0 }
  if (fold <= 0) {
    return { messages: parseMessagesJsonl(content), foldedMessages: 0 }
  }
  const after = parseMessagesJsonlSkipping(content, fold)
  const kept = stripLeadingOrphanToolMessages(after)
  if (kept.length > 0) {
    return {
      messages: kept,
      foldedMessages: fold + (after.length - kept.length)
    }
  }
  return applyFoldedMessagesWatermark(parseMessagesJsonl(content), fold)
}

function toolMessageText(content: MessageContent): string {
  return typeof content === 'string' ? content : contentToText(content)
}

/** Backward-scan window for tool-result lookup — recent output usually lives here. */
const TOOL_RESULT_TAIL_WINDOW_BYTES = 256 * 1024

function parseToolLine(line: string, toolCallId: string): string | null {
  if (!line) return null
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return null
  }
  if (!json || typeof json !== 'object') return null
  const row = json as { role?: unknown; toolCallId?: unknown }
  if (row.role !== 'tool' || row.toolCallId !== toolCallId) return null
  const parsed = ChatMessageSchema.safeParse(json)
  if (!parsed.success || parsed.data.role !== 'tool') return null
  return toolMessageText(parsed.data.content)
}

/**
 * Read full persisted tool output for lazy UI expansion (IPC ships a preview only).
 * Scans newest-first through growing byte-tail windows so typical expansions read
 * ~256 KB instead of re-loading the entire multi-MB transcript.
 */
export async function loadToolResultContent(
  workspacePath: string,
  runId: string,
  toolCallId: string
): Promise<string | null> {
  const dir = resolveRunDir(workspacePath, runId)
  // Best-effort: a queued-append failure (e.g. transient EPERM/EBUSY) must not
  // poison the read of already-persisted content. It stays surfaced to the run
  // via takeMessageAppendFailureNotice.
  try {
    await flushMessageAppends(dir)
  } catch (err) {
    logger.warn('Failed to flush message appends for tool result', {
      scope: 'state',
      runId,
      toolCallId,
      err
    })
  }
  const p = join(dir, 'messages.jsonl')
  if (!existsSync(p)) return null
  let fh: Awaited<ReturnType<typeof open>>
  try {
    fh = await open(p, 'r')
  } catch {
    logger.warn('Failed to open messages.jsonl for tool result', {
      scope: 'state',
      runId,
      toolCallId
    })
    return null
  }
  try {
    const { size } = await fh.stat()
    // Bytes not yet known to end at a line boundary (partial oldest line).
    let pending: Buffer = Buffer.alloc(0)
    let end = size
    while (end > 0) {
      const start = Math.max(0, end - TOOL_RESULT_TAIL_WINDOW_BYTES)
      const buf = Buffer.alloc(end - start)
      await fh.read(buf, 0, buf.length, start)
      pending = Buffer.concat([buf, pending])
      end = start

      // Only consume up to the last complete newline unless we reached file head.
      let usable = pending.length
      if (end > 0) {
        const lastNl = pending.lastIndexOf(0x0a)
        if (lastNl === -1) continue
        usable = lastNl
      }
      const segment = pending.subarray(0, usable).toString('utf8')
      pending = end > 0 ? pending.subarray(usable + 1) : Buffer.alloc(0)

      const lines = segment.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const hit = parseToolLine(lines[i], toolCallId)
        if (hit !== null) return hit
      }
    }
    if (pending.length > 0) {
      const hit = parseToolLine(pending.toString('utf8'), toolCallId)
      if (hit !== null) return hit
    }
    return null
  } catch (err) {
    logger.warn('Failed to read messages.jsonl for tool result', {
      scope: 'state',
      runId,
      toolCallId,
      err
    })
    return null
  } finally {
    await fh.close().catch(() => undefined)
  }
}

function normalizePersistedEvent(
  row: PersistedEvent,
  runId: string
): PersistedEvent {
  const event = row.event
  if (!event || typeof event !== 'object') return row
  const ev = event as Record<string, unknown>
  if (typeof ev.runId === 'string' && ev.runId.length > 0) return row
  return {
    ...row,
    event: { ...ev, runId }
  }
}

function parseEventsFromText(
  text: string,
  inferredRunId: string,
  options?: { limit?: number }
): PersistedEvent[] {
  const events: PersistedEvent[] = []
  const lines = text.split('\n')
  const limit = options?.limit
  const start =
    limit != null && limit > 0 && lines.length > limit ? Math.max(0, lines.length - limit) : 0
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]
    if (!line) continue
    try {
      const json: unknown = JSON.parse(line)
      const parsed = PersistedEventSchema.safeParse(json)
      if (!parsed.success) {
        logger.warn('Skipping invalid events.jsonl line (schema)', {
          scope: 'state',
          line: index + 1
        })
        continue
      }
      events.push(normalizePersistedEvent(parsed.data, inferredRunId))
    } catch {
      logger.warn('Skipping invalid events.jsonl line (json)', {
        scope: 'state',
        line: index + 1
      })
    }
  }
  return events
}

/**
 * Read approximately the last `byteBudget` bytes of a file so callers can parse
 * a trailing window of JSONL without loading multi-MB histories.
 */
function readFileTailSync(path: string, byteBudget: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size <= 0) return ''
    const start = Math.max(0, size - byteBudget)
    const length = size - start
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, start)
    let text = buf.toString('utf8')
    if (start > 0) {
      const firstNl = text.indexOf('\n')
      // The window starts mid-line (stale size vs. a concurrently rotated file,
      // or a clamped read of an in-flight tail line). Without a newline in the
      // buffer there is no COMPLETE line to parse — returning the partial text
      // made every load log "Skipping invalid events.jsonl line (json) line 1"
      // while a run was actively appending (33x observed on 2026-08-27).
      text = firstNl >= 0 ? text.slice(firstNl + 1) : ''
    }
    return text
  } finally {
    closeSync(fd)
  }
}

/** Heuristic: ~2KB average event line × limit, with a floor for short files. */
function eventsTailByteBudget(limit: number): number {
  return Math.max(64 * 1024, limit * 2048)
}

/** Sync read — does not block on pending appends. Prefer {@link loadEventsAsync} on hot paths. */
export function loadEvents(
  dir: string,
  runId?: string,
  options?: { limit?: number }
): PersistedEvent[] {
  const p = join(dir, 'events.jsonl')
  if (!existsSync(p)) return []
  const inferredRunId = runId ?? basename(dir)
  const limit = options?.limit
  let text: string
  if (limit != null && limit > 0) {
    text = readFileTailSync(p, eventsTailByteBudget(limit))
  } else {
    // Full history: stitch rotated archive heads (oldest first) into the live
    // file so receipts/forensics see events that rotation dropped from the tail.
    const parts: string[] = []
    for (const name of listEventArchivesSync(dir)) {
      try {
        parts.push(readFileSync(join(dir, name), 'utf8'))
      } catch {
        // skip unreadable archive — the live file still carries the recent tail
      }
    }
    parts.push(readFileSync(p, 'utf8'))
    text = parts.join('')
  }
  return parseEventsFromText(text, inferredRunId, options)
}

export async function loadEventsAsync(
  dir: string,
  runId?: string,
  options?: { limit?: number }
): Promise<PersistedEvent[]> {
  await flushEventAppends(dir)
  const p = join(dir, 'events.jsonl')
  if (!existsSync(p)) return []
  const inferredRunId = runId ?? basename(dir)
  const limit = options?.limit
  let text: string
  if (limit != null && limit > 0) {
    text = readFileTailSync(p, eventsTailByteBudget(limit))
  } else {
    // Full history: stitch rotated archive heads (oldest first) so run receipts,
    // rewind truncation, and event replays see the complete record.
    const parts: string[] = []
    for (const name of await listEventArchives(dir)) {
      try {
        parts.push(await readFile(join(dir, name), 'utf8'))
      } catch {
        // skip unreadable archive — the live file still carries the recent tail
      }
    }
    parts.push(await readFile(p, 'utf8'))
    text = parts.join('')
  }
  return parseEventsFromText(text, inferredRunId, options)
}

/**
 * Cumulative step_usage totals across the live events file AND rotated
 * archives. Rotation drops old heads out of events.jsonl, so resume cost
 * re-seeding must stitch archives back in or billed totals undercount.
 */
export async function loadStepUsageTotalsAsync(dir: string): Promise<StepUsageTotals> {
  await flushEventAppends(dir)
  const files: string[] = [...(await listEventArchives(dir)), 'events.jsonl']
  let totals = emptyStepUsageTotals()
  for (const name of files) {
    const p = join(dir, name)
    let text: string
    try {
      text = await readFile(p, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        const json: unknown = JSON.parse(line)
        const ev = (json as { event?: unknown }).event
        if (!ev || typeof ev !== 'object' || (ev as { type?: unknown }).type !== 'step_usage') {
          continue
        }
        const partial = stepUsageFromEvent(ev as AgentEvent)
        if (partial) totals = mergeStepUsageTotals(totals, partial)
      } catch {
        // skip bad line
      }
    }
  }
  return totals
}

/** Default UI restore bound — full history stays on disk. */
export const LOAD_EVENTS_UI_LIMIT = 500

const CRITICAL_HYDRATION_TYPES = new Set([
  'writes_checkpoint',
  'incomplete',
  'error',
  'status',
  'mode_changed',
  'compaction_verify_failed'
])

/**
 * Walk events.jsonl from the end and keep the latest row of each hydration-critical
 * type. Avoids losing writes_checkpoint / terminal status / mode when the UI tail
 * cap drops older lines.
 */
function collectLatestCriticalEvents(text: string, inferredRunId: string): PersistedEvent[] {
  const found = new Map<string, PersistedEvent>()
  const writeCheckpoints: PersistedEvent[] = []
  const seenCheckpointIds = new Set<string>()
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (!line) continue
    try {
      const json: unknown = JSON.parse(line)
      const parsed = PersistedEventSchema.safeParse(json)
      if (!parsed.success) continue
      const row = normalizePersistedEvent(parsed.data, inferredRunId)
      const event = row.event
      if (!event || typeof event !== 'object') continue
      const type = (event as { type?: unknown }).type
      if (typeof type !== 'string' || !CRITICAL_HYDRATION_TYPES.has(type)) continue
      if (type === 'status') {
        const status = (event as { status?: unknown }).status
        if (status !== 'done' && status !== 'cancelled' && status !== 'error') continue
      }
      if (type === 'writes_checkpoint') {
        const checkpointId = (event as { checkpointId?: unknown }).checkpointId
        if (typeof checkpointId !== 'string' || seenCheckpointIds.has(checkpointId)) continue
        seenCheckpointIds.add(checkpointId)
        writeCheckpoints.push(row)
        continue
      }
      if (!found.has(type)) found.set(type, row)
    } catch {
      // skip bad line
    }
  }
  return [...found.values(), ...writeCheckpoints]
}

function mergeCriticalHydrationEvents(
  uiEvents: PersistedEvent[],
  critical: PersistedEvent[]
): PersistedEvent[] {
  if (critical.length === 0) return uiEvents
  const out = [...uiEvents]
  for (const crit of critical) {
    const event = crit.event
    if (!event || typeof event !== 'object') continue
    const type = (event as { type?: unknown }).type
    if (typeof type !== 'string') continue
    const already = out.some((row) => {
      const ev = row.event
      if (!ev || typeof ev !== 'object') return false
      if ((ev as { type?: unknown }).type !== type) return false
      if (type === 'writes_checkpoint') {
        return (
          (ev as { checkpointId?: unknown }).checkpointId ===
          (event as { checkpointId?: unknown }).checkpointId
        )
      }
      return true
    })
    if (!already) out.push(crit)
  }
  return out
}

/**
 * UI restore: last N events plus hydration-critical rows from a wider trailing
 * window so writes_checkpoint / mode_changed / terminal status survive long runs.
 */
export async function loadEventsForHydrationAsync(
  dir: string,
  runId?: string,
  options?: { limit?: number }
): Promise<PersistedEvent[]> {
  await flushEventAppends(dir)
  const p = join(dir, 'events.jsonl')
  if (!existsSync(p)) return []
  const inferredRunId = runId ?? basename(dir)
  const limit = options?.limit ?? LOAD_EVENTS_UI_LIMIT
  const uiEvents = await loadEventsAsync(dir, inferredRunId, { limit })
  // Wider than the UI line cap so a checkpoint just outside the 500-event window
  // still hydrates Keep/Discard without loading the entire history.
  const criticalText = readFileTailSync(p, eventsTailByteBudget(Math.max(limit * 10, 2000)))
  const critical = collectLatestCriticalEvents(criticalText, inferredRunId)
  return mergeCriticalHydrationEvents(uiEvents, critical)
}

export async function loadEventsForRunAsync(
  workspacePath: string,
  runId: string,
  options?: { limit?: number }
): Promise<PersistedEvent[]> {
  const dir = resolveRunDir(workspacePath, runId)
  if (!existsSync(join(dir, 'events.jsonl'))) return []
  return loadEventsForHydrationAsync(dir, runId, options)
}


async function collectRunsFromRoot(root: string): Promise<{
  parents: RunSummary[]
  instances: RunSummary[]
}> {
  const parents: RunSummary[] = []
  const instances: RunSummary[] = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return { parents, instances }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    try {
      const statusPath = join(dir, 'status.json')
      const doc = await readJsonDocCached(statusPath)
      const parsed = doc.ok ? RunStatusSchema.safeParse(doc.doc) : null
      if (!parsed || !parsed.success) {
        logger.warn('Skipping run with invalid status.json', {
          scope: 'state',
          runId: entry.name
        })
        continue
      }
      const status = parsed.data
      const goal = readGoal(dir)
      // Schema-validated so `nextAt` is only carried when the file really holds
      // an armed loop — a corrupt or partial loop.json reads as disarmed.
      let armedLoop: { nextAt: string } | null = null
      try {
        const parsedLoop = RunLoopSchema.safeParse(
          JSON.parse(readFileSync(join(dir, 'loop.json'), 'utf8'))
        )
        if (parsedLoop.success && parsedLoop.data.status === 'armed') {
          armedLoop = { nextAt: parsedLoop.data.nextAt }
        }
      } catch {
        armedLoop = null
      }
      const summary: RunSummary = {
        runId: entry.name,
        status: status.status,
        updatedAt: status.updatedAt,
        goal: status.goal,
        ...(goal ? { goalStatus: goal.status } : {}),
        ...(goal?.continueCount ? { goalContinueCount: goal.continueCount } : {}),
        ...(armedLoop ? { loopArmed: true as const, loopNextAt: armedLoop.nextAt } : {}),
        ...(status.resumable ? { resumable: true as const } : {}),
        ...(status.error ? { error: status.error } : {}),
        ...(status.parentRunId ? { parentRunId: status.parentRunId } : {}),
        ...(status.inlineInstance ? { inlineInstance: true as const } : {}),
        ...(status.pathScope?.length ? { pathScope: status.pathScope } : {}),
        ...(status.worktreePath ? { worktreePath: status.worktreePath } : {}),
        ...(status.worktreeBranch ? { worktreeBranch: status.worktreeBranch } : {}),
        ...(status.agentProfileId ? { agentProfileId: status.agentProfileId } : {}),
        ...(status.agentProfileName ? { agentProfileName: status.agentProfileName } : {}),
        ...(status.agentProfileSnapshot
          ? { agentProfileSnapshot: status.agentProfileSnapshot }
          : {}),
        ...(status.runtime ? { runtime: status.runtime } : {})
      }
      const receiptCost = await readLenientReceiptCost(dir)
      if (receiptCost) Object.assign(summary, receiptCost)
      if (status.inlineInstance && status.parentRunId) {
        instances.push(summary)
      } else if (!status.inlineInstance) {
        parents.push(summary)
      }
    } catch (err) {
      logger.warn('Run listing skipped entry', {
        scope: 'runs',
        runDir: entry.name,
        err
      })
    }
  }
  return { parents, instances }
}

export async function listRuns(workspacePath: string): Promise<ListRunsResult> {
  return getCachedListRuns(workspacePath, async () => {
    // Reconcile only on cache miss/TTL expiry — avoids disk walk every sidebar poll.
    await reconcileStaleRuns(workspacePath)
    const { parents, instances } = await collectRunsFromRoot(
      workspaceSessionsRoot(workspacePath)
    )
    const sortedParents = parents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const parentIds = new Set(sortedParents.slice(0, RUN_LIST_CAP).map((r) => r.runId))
    const instanceRuns = instances
      .filter((r) => r.parentRunId != null && parentIds.has(r.parentRunId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return {
      runs: sortedParents.slice(0, RUN_LIST_CAP),
      instanceRuns,
      capped: sortedParents.length > RUN_LIST_CAP
    }
  })
}

/**
 * One older page of parent runs beyond the sidebar cap, strictly older than the
 * supplied cursor. Archived runs are done/idle, so stale-run reconciliation is
 * intentionally skipped here (listRuns owns it).
 */
export async function listRunsOlder(
  workspacePath: string,
  olderThanIso: string,
  limit: number = RUN_LIST_CAP
): Promise<{ runs: RunSummary[]; hasMore: boolean }> {
  const { parents } = await collectRunsFromRoot(workspaceSessionsRoot(workspacePath))
  const older = parents
    .filter((r) => r.updatedAt < olderThanIso)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return {
    runs: older.slice(0, limit),
    hasMore: older.length > limit
  }
}

/** Markdown export of a chat transcript — the file the user saves. */
export async function buildRunMarkdownExport(
  workspacePath: string,
  runId: string
): Promise<{ title: string; markdown: string }> {
  const runDir = resolveRunDir(workspacePath, runId)
  const status = loadStatus(runDir)
  const title = status?.goal?.trim() || runId
  const messages = await loadMessagesAsync(workspacePath, runId)
  const lines: string[] = [
    `# ${title}`,
    '',
    `Exported ${new Date().toISOString()}`
  ]
  for (const message of messages) {
    const text = contentToText(message.content).trim()
    if (!text && message.role !== 'assistant') continue
    lines.push('')
    if (message.role === 'user') {
      lines.push('## User', '', text || '_(empty)_')
    } else if (message.role === 'assistant') {
      lines.push('## Agent', '', text || '_(no text — tool calls only)_')
      // New rows carry reasoning only in reasoningState; derive the view.
      const thinkingText =
        message.thinking?.trim() ||
        thinkingFromReasoningState(parseProviderReasoningState(message.reasoningState)) ||
        ''
      if (thinkingText) {
        lines.push('', '<details><summary>Thinking</summary>', '', thinkingText, '', '</details>')
      }
      for (const call of message.toolCalls ?? []) {
        let args = call.arguments
        try {
          args = JSON.stringify(JSON.parse(call.arguments), null, 2)
        } catch {
          // keep raw arguments when they are not complete JSON
        }
        lines.push('', `**Tool call: ${call.name}**`, '', '```json', args, '```')
      }
    } else if (message.role === 'tool') {
      lines.push(
        `## Tool result: ${message.toolName ?? 'tool'} (${message.ok === false ? 'error' : 'ok'})`,
        '',
        '```',
        text,
        '```'
      )
    }
  }
  lines.push('')
  return { title, markdown: lines.join('\n') }
}

/** Persist failure stubs for tool calls that never received a result before interrupt. */
function appendOrphanToolStubs(dir: string, runId: string): void {
  // Stitch rotated archive heads: an assistant tool_use from an archived head
  // still needs its stub, and the repair rewrite replaces the live file with
  // stitched content (syncMessages removes the now-redundant archives).
  const content = stitchedMessagesContentSync(dir)
  if (content == null) return
  const messages = parseMessagesJsonl(content)
  const completedIds = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId) completedIds.add(message.toolCallId)
  }
  // A crash between dispatch and result cannot honestly claim the tool did not
  // run — see TOOL_STUB_RESTART_INTERRUPTED. The resumed turn reads this.
  const stub = TOOL_STUB_RESTART_INTERRUPTED
  const repaired: ChatMessage[] = []
  let changed = false
  for (const message of messages) {
    repaired.push(message)
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue
    for (const call of message.toolCalls) {
      if (completedIds.has(call.id)) continue
      completedIds.add(call.id)
      changed = true
      repaired.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: stub,
        ok: false
      })
      appendEvent(
        dir,
        toolResultEventForPersistence({
          type: 'tool_result',
          runId,
          toolCallId: call.id,
          name: call.name,
          summary: 'interrupted',
          ok: false,
          content: stub
        })
      )
    }
  }
  if (changed) syncMessages(dir, repaired)
}

/**
 * Demote in-progress markers on every todo_write tool message after run-end.
 * Keeps historical checklist snapshots; only clears spinners (`[~]`).
 */
export async function patchLatestTodoWriteMessage(
  dir: string,
  outcomeOrContent: TodoFinalizeOutcome | string
): Promise<void> {
  // Queued behind pending appends: the terminal error paths flush a partial
  // assistant message without awaiting, and an unserialized rewrite would drop it.
  await enqueueMessageRewrite(dir, () => {
    // Stitched content: the rewrite replaces the live file wholesale and
    // syncMessages removes archives, so archive heads must be folded in first.
    const content = stitchedMessagesContentSync(dir)
    if (content == null) return
    const messages = parseMessagesJsonl(content)
    let changed = false
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      if (message?.role !== 'tool' || message.toolName !== 'todo_write') continue
      const current = toolMessageText(message.content)
      const next =
        outcomeOrContent === 'done' ||
        outcomeOrContent === 'error' ||
        outcomeOrContent === 'cancelled'
          ? finalizeTodoContentOnRunEnd(current, outcomeOrContent)
          : outcomeOrContent
      if (next === current) continue
      messages[index] = { ...message, content: next }
      changed = true
    }
    if (changed) syncMessages(dir, messages)
  })
}

/**
 * Run ids whose instance worktree must survive stale-worktree pruning.
 *
 * Pruning protects only runs live in THIS process, and at boot nothing is live
 * yet — so every instance checkout looks stale. An instance that is still
 * running (re-adding an open workspace mid-run) or that was interrupted and
 * marked resumable would have its checkout deleted out from under the resume
 * it was just promised. Read from durable status rather than process-local
 * maps: at boot they are the only record that these runs exist.
 *
 * Callers build this BEFORE pruning; the branch survives either way
 * (interruptRunningRunOnDisk keeps it), but reusing an intact checkout avoids
 * recreating one from the branch.
 */
export function collectProtectedInstanceRunIds(workspacePath: string): Set<string> {
  const protectedIds = new Set<string>()
  const runs = workspaceSessionsRoot(workspacePath)
  if (!existsSync(runs)) return protectedIds
  let names: string[]
  try {
    names = readdirSync(runs)
  } catch (err) {
    // Unreadable sessions root: protect nothing rather than guess, but say so —
    // a silent empty set here becomes a deleted worktree.
    logger.warn('Protected-instance scan skipped workspace sessions root', {
      scope: 'runs',
      workspacePath,
      err
    })
    return protectedIds
  }
  for (const name of names) {
    try {
      const statusPath = join(runs, name, 'status.json')
      if (!existsSync(statusPath)) continue
      const parsed = RunStatusSchema.safeParse(JSON.parse(readFileSync(statusPath, 'utf8')))
      if (!parsed.success) continue
      const status = parsed.data
      if (!status.inlineInstance) continue
      if (status.status === 'running' || status.resumable === true) protectedIds.add(name)
    } catch {
      // A single unreadable run must not blind the whole protection set.
      continue
    }
  }
  return protectedIds
}

/**
 * Mark runs left as `running` after a crash/restart as cancelled.
 * Scans workspace run directories under each provided path.
 * When `maxAgeMs` is 0 (default), every disk-`running` non-active run is cancelled immediately.
 */
export async function interruptOrphanRuns(
  workspacePaths: string[],
  maxAgeMs = 0
): Promise<number> {
  let count = 0
  for (const workspacePath of workspacePaths) {
    const runs = workspaceSessionsRoot(workspacePath)
    if (!existsSync(runs)) continue
    let workspaceCount = 0
    for (const name of readdirSync(runs)) {
      const dir = join(runs, name)
      try {
        if (!statSync(dir).isDirectory()) continue
        const statusPath = join(dir, 'status.json')
        if (!existsSync(statusPath)) continue
        const raw = JSON.parse(readFileSync(statusPath, 'utf8')) as unknown
        const parsed = RunStatusSchema.safeParse(raw)
        if (!parsed.success) continue
        if (parsed.data.status !== 'running') continue
        // Skip runs still live in memory (re-adding an open workspace must not
        // treat an in-flight agent as a crash orphan).
        if (isActive(name)) continue
        if (!isRunStaleByAge(parsed.data.updatedAt, maxAgeMs)) continue
        await interruptRunningRunOnDisk(workspacePath, name, dir, parsed.data)
        workspaceCount += 1
      } catch (err) {
        logger.warn('Orphan interrupt skipped entry', {
          scope: 'runs',
          runId: name,
          err
        })
      }
    }
    if (workspaceCount > 0) invalidateListRunsCache(workspacePath)
    count += workspaceCount
  }
  return count
}

const DEFAULT_STALE_RUN_AGE_MS = 120_000

function isRunStaleByAge(updatedAt: string, maxAgeMs: number): boolean {
  if (maxAgeMs <= 0) return true
  const ts = Date.parse(updatedAt)
  if (!Number.isFinite(ts)) return true
  return Date.now() - ts >= maxAgeMs
}

async function finalizeInlineInstanceWorktreeBestEffort(
  workspacePath: string,
  status: RunStatus,
  opts?: { keepBranch?: boolean }
): Promise<void> {
  if (!status.inlineInstance || !status.worktreePath) return
  if (!isSafeInstanceWorktreePath(workspacePath, status.worktreePath)) {
    logger.warn('orphan interrupt skipped unsafe instance worktree path', {
      scope: 'runs',
      worktreePath: status.worktreePath
    })
    return
  }
  try {
    await finalizeInstanceWorktree(workspacePath, status.worktreePath, {
      keepBranch: opts?.keepBranch ?? status.status === 'done',
      branch: status.worktreeBranch
    })
  } catch (err) {
    logger.warn('orphan interrupt worktree finalize failed', {
      scope: 'runs',
      worktreePath: status.worktreePath,
      err
    })
  }
}

/**
 * Can this interrupted run honestly be resumed?
 *
 * "Resume" here means a NEW invocation rebuilt from durable state, not a
 * revived process. That only holds when the state it would rebuild from still
 * exists — so an isolated instance needs its branch, and a shared-workspace
 * instance needs its workspace. Marking a run resumable when neither is true
 * is the worst outcome: the user is offered a Resume that cannot restore the
 * work, and the real reason it is gone never gets reported.
 */
function describeInstanceResumability(
  workspacePath: string,
  status: RunStatus
): { resumable: true } | { resumable: false; reason: string } {
  if (!status.inlineInstance) return { resumable: true }
  if (status.worktreePath) {
    // Isolated instance: the checkout is unusable after a crash, but its
    // committed branch is the work. Recovery recreates a checkout from it.
    const branch = status.worktreeBranch?.trim()
    if (!branch || !isSafeInstanceBranch(branch)) {
      return {
        resumable: false,
        reason: 'the isolated branch for this instance was not recorded'
      }
    }
    return { resumable: true }
  }
  // Shared-workspace instance: its edits live in the workspace itself.
  if (!existsSync(workspacePath)) {
    return { resumable: false, reason: 'its workspace no longer exists' }
  }
  return { resumable: true }
}

async function interruptRunningRunOnDisk(
  workspacePath: string,
  runId: string,
  dir: string,
  status: RunStatus
): Promise<void> {
  // Drain pending appends first so the stitched orphan-stub repair below reads
  // and rewrites the complete transcript rather than racing the append chain.
  await flushMessageAppends(dir)
  appendOrphanToolStubs(dir, runId)
  finalizeInterruptedTodos(dir)
  await patchLatestTodoWriteMessage(dir, 'cancelled')
  // Keep the branch. finalizeInstanceWorktree commits the instance's dirty
  // edits and then removes the checkout; deleting the branch too would destroy
  // the very work a `resumable: true` run promises to come back to.
  await finalizeInlineInstanceWorktreeBestEffort(workspacePath, status, { keepBranch: true })
  const resumability = describeInstanceResumability(workspacePath, status)
  await updateStatus(
    dir,
    {
      status: 'cancelled',
      error: resumability.resumable
        ? RUN_INTERRUPTED_ERROR
        : `${RUN_INTERRUPTED_ERROR} — cannot resume because ${resumability.reason}`,
      ...(resumability.resumable ? { resumable: true as const } : {}),
      interruptedAt: new Date().toISOString(),
      step: status.step,
      ...(status.invokeId != null ? { invokeId: status.invokeId } : {})
    },
    { sync: true }
  )
  appendEvent(dir, {
    type: 'status',
    status: 'cancelled',
    runId,
    ...(status.invokeId != null ? { invokeId: status.invokeId } : {})
  })
  await flushEventAppends(dir)
  await flushStatusWrites(dir)
  const events = await loadEventsAsync(dir, runId)
  await writeRunReceiptBestEffort({
    runDir: dir,
    runId,
    loadStatus,
    loadMessages: () => loadMessagesAsync(workspacePath, runId),
    loadEvents: () => events,
    readContract
  })
}

/** Reconcile disk-`running` runs older than `maxAgeMs` when listing or loading sessions. */
export async function reconcileStaleRuns(
  workspacePath: string,
  maxAgeMs = DEFAULT_STALE_RUN_AGE_MS
): Promise<number> {
  let count = 0
  const runs = workspaceSessionsRoot(workspacePath)
  let entries
  try {
    entries = await readdir(runs, { withFileTypes: true })
  } catch (err) {
    logger.warn('Run reconcile skipped workspace sessions root', {
      scope: 'runs',
      workspacePath,
      err
    })
    return 0
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(runs, entry.name)
    try {
      const statusPath = join(dir, 'status.json')
      const doc = await readJsonDocCached(statusPath)
      const parsed = doc.ok ? RunStatusSchema.safeParse(doc.doc) : null
      if (!parsed || !parsed.success) {
        logger.warn('Run reconcile skipped invalid status.json', {
          scope: 'runs',
          runId: entry.name
        })
        continue
      }
      if (parsed.data.status !== 'running') continue
      if (isActive(entry.name)) continue
      if (!isRunStaleByAge(parsed.data.updatedAt, maxAgeMs)) continue
      await interruptRunningRunOnDisk(workspacePath, entry.name, dir, parsed.data)
      count += 1
    } catch (err) {
      logger.warn('Run reconcile skipped entry', {
        scope: 'runs',
        runId: entry.name,
        err
      })
    }
  }
  // Called from listRuns cache miss only — caller writes fresh cache after.
  return count
}

function dismissRunLifecycleInbox(runId: string): void {
  const id = runId.trim()
  if (!id) return
  dismissLifecycleNotification(runDoneDedupeKey(id))
  dismissLifecycleNotification(runErrorDedupeKey(id))
}

export async function deleteRun(
  workspacePath: string,
  runId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (isActive(runId)) {
    return { ok: false, error: 'Cancel run first' }
  }
  const dir = resolveRunDir(workspacePath, runId)
  if (!existsSync(dir)) {
    return { ok: false, error: 'Run not found' }
  }
  const status = loadStatus(dir)

  if (!status?.inlineInstance) {
    const { instances } = await collectRunsFromRoot(workspaceSessionsRoot(workspacePath))
    const children = instances.filter((r) => r.parentRunId === runId)
    if (children.some((c) => isActive(c.runId))) {
      return { ok: false, error: 'Cancel instance runs first' }
    }
    for (const child of children) {
      const childDir = resolveRunDir(workspacePath, child.runId)
      const childStatus = loadStatus(childDir)
      if (childStatus) {
        await finalizeInlineInstanceWorktreeBestEffort(workspacePath, childStatus, {
          keepBranch: false
        })
      }
      if (existsSync(childDir)) {
        await drainRunWritersBeforeDelete(childDir)
        rmSync(childDir, { recursive: true, force: true })
      }
      // The stitched-transcript memo pins multi-MB strings per run dir — drop
      // it with the directory or the LRU keeps deleted runs resident.
      invalidateMessagesCache(childDir)
      dismissRunLifecycleInbox(child.runId)
    }
  }

  if (status?.inlineInstance && status.worktreePath) {
    await finalizeInlineInstanceWorktreeBestEffort(workspacePath, status)
  }
  await drainRunWritersBeforeDelete(dir)
  // M2: a chatStart can register this runId (tryRegisterRunAbort) during the
  // awaits above — re-check so the directory is never deleted under a live run.
  if (isActive(runId)) {
    return { ok: false, error: 'Cancel run first' }
  }
  rmSync(dir, { recursive: true, force: true })
  invalidateMessagesCache(dir)
  dismissRunLifecycleInbox(runId)
  invalidateListRunsCache(workspacePath)
  logger.info('Deleted run', {
    scope: 'agent',
    runId,
    workspaceId: workspaceIdFromPath(workspacePath),
    channel: 'runs:delete'
  })
  return { ok: true }
}

const GOAL_SECTION_RE = /(## Goal\s*\n)([\s\S]*?)(\n## )/
export { GOAL_SECTION_RE }

/**
 * Drain pending run-file writers ahead of a directory delete so queued appends
 * or a debounced status flush cannot re-create the deleted run directory
 * (a phantom run containing only status.json in the sidebar).
 */
async function drainRunWritersBeforeDelete(dir: string): Promise<void> {
  try {
    await flushMessageAppends(dir)
  } catch {
    // best effort — the delete proceeds regardless
  }
  try {
    await flushEventAppends(dir)
  } catch {
    // best effort
  }
  try {
    await flushStatusWrites(dir)
  } catch {
    // best effort
  }
  clearStatusWritesForDir(dir)
}

export async function renameRun(
  workspacePath: string,
  runId: string,
  goal: string
): Promise<RunSummary> {
  if (isActive(runId)) {
    throw new Error('Cancel run first')
  }
  const dir = resolveRunDir(workspacePath, runId)
  if (!existsSync(dir)) {
    throw new Error('Run not found')
  }
  const goalText = goal.trim().slice(0, 200)
  const statusPath = join(dir, 'status.json')
  // Async reads (audit L-15): the contract is capped elsewhere but this path
  // read the full file on the main thread; IPC rename must not block the loop.
  const raw = JSON.parse(await readFile(statusPath, 'utf8')) as unknown
  const parsed = RunStatusSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error('Invalid run status')
  }
  const contractPath = join(dir, 'contract.md')
  if (existsSync(contractPath)) {
    const contract = await readFile(contractPath, 'utf8')
    const updated = GOAL_SECTION_RE.test(contract)
      ? contract.replace(GOAL_SECTION_RE, `$1${goalText}$3`)
      : contract
    atomicWriteFile(contractPath, updated)
  }
  // Serialize through the per-dir status chain. The previous raw read-modify-
  // write raced the debounced flusher (readStatusFile → atomicWriteJsonAsync
  // window) and the in-flight flush silently reverted the rename.
  await updateStatus(dir, { goal: goalText }, { sync: true })
  const saved = loadStatus(dir)
  invalidateListRunsCache(workspacePath)

  return {
    runId,
    status: saved?.status ?? parsed.data.status,
    updatedAt: saved?.updatedAt ?? parsed.data.updatedAt,
    goal: goalText
  }
}
