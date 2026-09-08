import { existsSync } from 'fs'
import { open, readFile } from 'fs/promises'
import { join } from 'path'
import { RunReceiptSchema, type RunStat, type RunTokenUsage } from '../../shared/ipc'
import { resolveRunDirInRoot } from '../storage/paths'
import { listMessageArchives } from './messageAppendQueue'

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

async function countLinesSafe(filePath: string): Promise<number> {
  if (!existsSync(filePath)) return 0
  try {
    return await countLines(filePath)
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

/** Best-effort receipt tokenUsage — survives receipt version drift. */
async function readReceiptTokenUsage(runDir: string): Promise<RunTokenUsage | undefined> {
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

/**
 * Real per-run usage over a workspace sessions root: honest transcript message
 * counts (archive-stitched) plus receipt.json tokenUsage when present. Runs
 * whose id fails the containment guard are omitted, never zero-filled.
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
    const tokenUsage = await readReceiptTokenUsage(dir)
    out.push({ runId, messages, ...(tokenUsage ? { tokenUsage } : {}) })
  }
  return out
}
