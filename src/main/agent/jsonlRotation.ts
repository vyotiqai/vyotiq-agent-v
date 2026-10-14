import { appendFile, open, stat, unlink, writeFile } from 'fs/promises'
import { renameWithRetry } from '../storage/atomicWrite'

/** How long a log whose rotation failed goes before rotation is tried again. */
const ROTATION_RETRY_AFTER_MS = 60_000
/** Logs whose last rotation failed, with the time to try again. */
const rotationBlockedUntil = new Map<string, number>()
/** Logs whose final byte has been checked this process (see endsWithTornLine). */
const tailChecked = new Set<string>()

/**
 * Append `data` to a run log, rotating it first when it has outgrown its cap.
 *
 * Rotation is housekeeping. It used to run inside the append's own try, so a
 * rotation that failed — a Windows rename over a file another reader has open
 * fails with EPERM — failed the append too: the record was lost and the run
 * stopped on a persist error. Now a failed rotation is reported, backed off,
 * and the record is appended to the unrotated file.
 */
export async function appendToRunLog(opts: {
  path: string
  data: string
  maxBytes: number
  keepBytes: number
  nextArchivePath: () => string
  /** Runs after a successful rotation; must not throw (best-effort housekeeping). */
  onRotated?: (result: NonNullable<RotationResult>) => void | Promise<void>
  onRotateFailed?: (err: unknown) => void
}): Promise<void> {
  const { path } = opts
  const blockedUntil = rotationBlockedUntil.get(path)
  if (blockedUntil === undefined || Date.now() >= blockedUntil) {
    let rotated: RotationResult = null
    try {
      rotated = await rotateJsonlIfNeeded(opts)
      rotationBlockedUntil.delete(path)
    } catch (err) {
      rotationBlockedUntil.set(path, Date.now() + ROTATION_RETRY_AFTER_MS)
      opts.onRotateFailed?.(err)
    }
    if (rotated) await opts.onRotated?.(rotated)
  }
  let data = opts.data
  if (!tailChecked.has(path)) {
    if (await endsWithTornLine(path)) data = `\n${data}`
    tailChecked.add(path)
  }
  try {
    await appendFile(path, data, 'utf8')
  } catch (err) {
    // A failed append can leave part of the record behind; check again next time.
    tailChecked.delete(path)
    throw err
  }
}

/** @internal Test hook. */
export function resetRunLogStateForTests(): void {
  rotationBlockedUntil.clear()
  tailChecked.clear()
}

/**
 * Size-based rotation shared by the per-run append logs (messages.jsonl,
 * events.jsonl): the head moves to an archive file, the live file keeps the
 * recent tail. Stitched readers put the two back together.
 *
 * Both files are written aside first and swapped in with a Windows-tolerant
 * rename, archive first. If the live swap fails, the archive is removed again,
 * so a failed rotation leaves the log exactly as it was — never the head in
 * both places, which stitched readers would show twice.
 */
export type RotationResult = { archivePath: string; headBytes: number } | null

export async function rotateJsonlIfNeeded(opts: {
  path: string
  maxBytes: number
  keepBytes: number
  /** Full path of the archive to create for this rotation. */
  nextArchivePath: () => string
}): Promise<RotationResult> {
  const { path, maxBytes, keepBytes } = opts
  let size = 0
  try {
    size = (await stat(path)).size
  } catch {
    return null // file does not exist yet — the append will create it
  }
  if (size <= maxBytes) return null
  const targetSplit = size - keepBytes
  if (targetSplit <= 0) return null

  let head: Buffer
  let tail: Buffer
  const handle = await open(path, 'r')
  try {
    // Split on a line boundary: the last newline in the head window, or the
    // first one after it when the window holds no newline at all.
    const headBuf = Buffer.alloc(targetSplit)
    await handle.read(headBuf, 0, targetSplit, 0)
    let splitAt = headBuf.lastIndexOf(0x0a) + 1
    if (splitAt === 0) {
      const restBuf = Buffer.alloc(size - targetSplit)
      await handle.read(restBuf, 0, restBuf.length, targetSplit)
      const firstNl = restBuf.indexOf(0x0a)
      if (firstNl < 0) return null
      splitAt = targetSplit + firstNl + 1
    }
    if (splitAt >= size) return null
    if (splitAt <= targetSplit) {
      head = headBuf.subarray(0, splitAt)
    } else {
      head = Buffer.alloc(splitAt)
      await handle.read(head, 0, splitAt, 0)
    }
    tail = Buffer.alloc(size - splitAt)
    await handle.read(tail, 0, tail.length, splitAt)
  } finally {
    await handle.close()
  }

  const archivePath = opts.nextArchivePath()
  const archiveTemp = `${archivePath}.tmp`
  const liveTemp = `${path}.tmp`
  try {
    await writeFile(archiveTemp, head)
    await writeFile(liveTemp, tail)
    await renameWithRetry(archiveTemp, archivePath)
  } catch (err) {
    await Promise.all([unlink(archiveTemp).catch(() => {}), unlink(liveTemp).catch(() => {})])
    throw err
  }
  try {
    await renameWithRetry(liveTemp, path)
  } catch (err) {
    // The live file still holds the head; drop the archive copy of it.
    await Promise.all([unlink(archivePath).catch(() => {}), unlink(liveTemp).catch(() => {})])
    throw err
  }
  return { archivePath, headBytes: head.length }
}

/**
 * True when the file exists, is non-empty, and its last byte is not a newline —
 * a torn final line from a crash mid-append. The next record must start on its
 * own line, or it is glued to the fragment and both fail to parse.
 */
export async function endsWithTornLine(path: string): Promise<boolean> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return false
  }
  try {
    const { size } = await handle.stat()
    if (size === 0) return false
    const last = Buffer.alloc(1)
    await handle.read(last, 0, 1, size - 1)
    return last[0] !== 0x0a
  } finally {
    await handle.close()
  }
}
