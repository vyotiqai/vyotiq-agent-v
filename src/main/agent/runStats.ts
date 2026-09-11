import { existsSync } from 'fs'
import { open, readFile, stat } from 'fs/promises'
import { join } from 'path'
import {
  RunReceiptSchema,
  type RunReceipt,
  type RunStat,
  type RunTokenUsage
} from '../../shared/ipc'
import { resolveRunDirInRoot } from '../storage/paths'
import { listMessageArchives } from './messageAppendQueue'
import { listEventArchives } from './eventAppendQueue'
import { migrateLegacyReceipt } from './harnessReview'

const READ_CHUNK_BYTES = 64 * 1024

/** Chunked async line count — \n separated; a final unterminated line still counts. */
async function countLines(filePath: string): Promise<number> {
  const fh = await open(filePath, 'r')
  try {
    let lines = 0
    let lastByte = -1
    const buf = Buffer.alloc(READ_CHUNK_BYTES)
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null)
      if (bytesRead === 0) break
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 10) lines++
      }
      lastByte = buf[bytesRead - 1]
    }
    if (lines > 0 && lastByte !== 10) lines++
    return lines
  } finally {
    await fh.close()
  }
}

type LineCountCacheEntry = { size: number; mtimeMs: number; ctimeMs: number; lines: number }
const LINE_COUNT_CACHE = new Map<string, LineCountCacheEntry>()
const LINE_COUNT_CACHE_LIMIT = 256

/**
 * Line counts are re-requested on Home focus and run-list refresh for every
 * run in every workspace; transcripts can be tens of MB. Cache the count and
 * validate with size + mtime/ctime (a rewrite changes them, a growing live
 * file changes size), so unchanged transcripts are never byte-scanned twice.
 */
async function countLinesSafe(filePath: string): Promise<number> {
  let before
  try {
    before = await stat(filePath)
  } catch {
    return 0
  }
  const hit = LINE_COUNT_CACHE.get(filePath)
  if (hit && hit.size === before.size && hit.mtimeMs === before.mtimeMs) return hit.lines
  try {
    const lines = await countLines(filePath)
    try {
      const after = await stat(filePath)
      if (after.size === before.size && after.mtimeMs === before.mtimeMs) {
        if (LINE_COUNT_CACHE.size >= LINE_COUNT_CACHE_LIMIT) {
          const oldest = LINE_COUNT_CACHE.keys().next().value
          if (oldest !== undefined) LINE_COUNT_CACHE.delete(oldest)
        }
        LINE_COUNT_CACHE.set(filePath, {
          size: after.size,
          mtimeMs: after.mtimeMs,
          ctimeMs: after.ctimeMs,
          lines
        })
      }
    } catch {
      // Raced with a rewrite/rotation — return the count without caching it.
    }
    return lines
  } catch {
    return 0
  }
}

/**
 * Stitched transcript rows: rotated archive heads (oldest first) plus the live
 * file — mirrors the loadMessages reconstruction, since rotation keeps only the
 * recent tail in the live file.
 */
async function countTranscriptMessages(runDir: string): Promise<number> {
  let messages = 0
  for (const name of await listMessageArchives(runDir)) {
    messages += await countLinesSafe(join(runDir, name))
  }
  messages += await countLinesSafe(join(runDir, 'messages.jsonl'))
  return messages
}

/** First persisted event ISO timestamp (`at`) — run start, for durations. */
async function readFirstEventAt(runDir: string): Promise<string | undefined> {
  let archives: string[] = []
  try {
    archives = await listEventArchives(runDir)
  } catch {
    archives = []
  }
  // Oldest archive first (rotation keeps the recent tail in the live file).
  for (const name of [...archives, 'events.jsonl']) {
    const p = join(runDir, name)
    if (!existsSync(p)) continue
    try {
      const fh = await open(p, 'r')
      try {
        const buf = Buffer.alloc(4096)
        const { bytesRead } = await fh.read(buf, 0, buf.length, null)
        if (bytesRead === 0) continue
        const firstLine = buf.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? ''
        if (!firstLine.trim()) continue
        const row = JSON.parse(firstLine) as { at?: unknown }
        if (typeof row?.at === 'string' && row.at) return row.at
        return undefined
      } finally {
        await fh.close()
      }
    } catch {
      continue
    }
  }
  return undefined
}

/** Best-effort lenient tokenUsage extraction — survives partial/corrupt receipts. */
async function readLenientTokenUsage(runDir: string): Promise<RunTokenUsage | undefined> {
  const receiptPath = join(runDir, 'receipt.json')
  if (!existsSync(receiptPath)) return undefined
  try {
    const raw = JSON.parse(await readFile(receiptPath, 'utf8')) as { tokenUsage?: unknown }
    const parsed = RunReceiptSchema.shape.tokenUsage.safeParse(raw?.tokenUsage)
    if (parsed.success && parsed.data != null) return parsed.data
  } catch {
    // Corrupt or foreign receipt — omit tokens rather than guess.
  }
  return undefined
}

/** Full receipt when it parses strictly (post-migration), else undefined. */
async function readReceiptDetail(runDir: string): Promise<RunReceipt | undefined> {
  const receiptPath = join(runDir, 'receipt.json')
  if (!existsSync(receiptPath)) return undefined
  try {
    const parsed = RunReceiptSchema.safeParse(
      migrateLegacyReceipt(JSON.parse(await readFile(receiptPath, 'utf8')))
    )
    if (parsed.success) return parsed.data
  } catch {
    // Corrupt or foreign receipt — the lenient path still carries tokenUsage.
  }
  return undefined
}

/**
 * Flatten a real receipt into RunStat session detail — only fields the receipt
 * actually carries. Nothing is fabricated: a legacy receipt without cost/
 * model/contextWindow contributes nothing rather than a fake 0.
 */
function statFromReceipt(receipt: RunReceipt): RunStat {
  return {
    runId: receipt.runId,
    messages: 0,
    ...(receipt.tokenUsage ? { tokenUsage: receipt.tokenUsage } : {}),
    ...(receipt.model ? { model: receipt.model } : {}),
    ...(receipt.provider ? { provider: receipt.provider } : {}),
    ...(receipt.billedCost != null && receipt.billedCost > 0
      ? { billedCost: receipt.billedCost }
      : {}),
    ...(receipt.step > 0 ? { steps: receipt.step } : {}),
    ...(receipt.compactionCount > 0 ? { compactionCount: receipt.compactionCount } : {}),
    ...(receipt.toolStats.totalCalls > 0 ? { toolStats: receipt.toolStats } : {}),
    ...(receipt.failureClusters.length > 0
      ? { failureClusters: receipt.failureClusters }
      : {}),
    ...(receipt.maxConsecutiveToolFailures != null && receipt.maxConsecutiveToolFailures > 0
      ? { maxConsecutiveToolFailures: receipt.maxConsecutiveToolFailures }
      : {}),
    ...(receipt.verification ? { verification: receipt.verification } : {}),
    ...(receipt.contextWindow != null && receipt.contextWindow > 0
      ? { contextWindow: receipt.contextWindow }
      : {}),
    ...(receipt.writtenAt ? { writtenAt: receipt.writtenAt } : {})
  }
}

/**
 * Real per-run usage + session detail over a workspace sessions root: honest
 * transcript message counts (archive-stitched), the full persisted receipt
 * (token usage, cost, model, steps, compaction, tool stats, failure clusters,
 * verification state, context window), and the first-event timestamp for run
 * durations. Runs whose id fails the containment guard are omitted, never
 * zero-filled.
 */
export async function collectRunStats(
  sessionsRoot: string,
  runIds: readonly string[]
): Promise<RunStat[]> {
  const out: RunStat[] = []
  for (const runId of runIds) {
    let dir: string
    try {
      dir = resolveRunDirInRoot(sessionsRoot, runId)
    } catch {
      continue
    }
    const messages = await countTranscriptMessages(dir)
    const receipt = await readReceiptDetail(dir)
    if (!receipt) {
      // Partial/legacy receipt: still carry its real tokenUsage (field-level
      // parse) when present — never drop persisted data a strict parse rejects.
      const lenientTokenUsage = await readLenientTokenUsage(dir)
      out.push({
        runId,
        messages,
        ...(lenientTokenUsage ? { tokenUsage: lenientTokenUsage } : {})
      })
      continue
    }
    const startedAt = await readFirstEventAt(dir)
    out.push({
      ...statFromReceipt(receipt),
      messages,
      ...(startedAt ? { startedAt } : {})
    })
  }
  return out
}
