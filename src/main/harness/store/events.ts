import { open, readFile, readdir, stat, unlink } from 'fs/promises'
import { basename, join } from 'path'
import { atomicWriteFileAsync } from '../../storage/atomicWrite'
import { PersistedEventSchema, type AgentEvent, type PersistedEvent } from '../../../shared/ipc'
import { logger } from '../../../shared/logger'
import {
  stepUsageTotalsFromPersistedEvents,
  type StepUsageTotals
} from '../../../shared/utils/runTelemetry'
import { appendLine, runSerialized, settled } from './jsonl'

/**
 * events.jsonl — one `{ at, event }` row per line, `at` stamped when the event
 * is queued (not when it lands on disk), so rows keep the order and the times
 * the run produced them.
 */
export const EVENTS_FILE = 'events.jsonl'
/** Heads rotated out by the previous writer; still stitched in by full readers. */
const LEGACY_ARCHIVE_PREFIX = 'events.archive.'

export function eventsPath(dir: string): string {
  return join(dir, EVENTS_FILE)
}

export function appendEvent(dir: string, event: AgentEvent): Promise<void> {
  return appendLine(eventsPath(dir), `${JSON.stringify({ at: new Date().toISOString(), event })}\n`)
}

/** Wait for queued event rows of this run to reach disk. */
export function eventsSettled(dir: string): Promise<void> {
  return settled(eventsPath(dir))
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Rows written without a run id get the directory's (legacy rows). */
function withRunId(row: PersistedEvent, runId: string): PersistedEvent {
  const event = row.event
  if (!event || typeof event !== 'object') return row
  const ev = event as Record<string, unknown>
  if (typeof ev.runId === 'string' && ev.runId.length > 0) return row
  return { ...row, event: { ...ev, runId } }
}

function parseRows(text: string, runId: string, limit?: number): PersistedEvent[] {
  const lines = text.split('\n')
  const start = limit != null && limit > 0 && lines.length > limit ? lines.length - limit : 0
  const rows: PersistedEvent[] = []
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]
    if (!line) continue
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      logger.warn('Skipping unparseable events.jsonl line', { scope: 'store', correlationId: runId })
      continue
    }
    const parsed = PersistedEventSchema.safeParse(json)
    if (!parsed.success) {
      logger.warn('Skipping malformed events.jsonl row', { scope: 'store', correlationId: runId })
      continue
    }
    rows.push(withRunId(parsed.data, runId))
  }
  return rows
}

/**
 * The last `byteBudget` bytes of a file, starting at a line boundary. A window
 * that lands mid-line drops the partial first line; one with no newline at all
 * has no complete line to offer.
 */
async function readTail(path: string, byteBudget: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size <= 0) return ''
    const start = Math.max(0, size - byteBudget)
    const buf = Buffer.alloc(size - start)
    const { bytesRead } = await handle.read(buf, 0, buf.length, start)
    const text = buf.toString('utf8', 0, bytesRead)
    if (start === 0) return text
    const firstNewline = text.indexOf('\n')
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
  } finally {
    await handle.close()
  }
}

/** ~2 KB per row, with a floor for short files. */
function tailBudgetForRows(rows: number): number {
  return Math.max(64 * 1024, rows * 2048)
}

/**
 * Event rows of a run, oldest first. With `limit`, only the trailing rows;
 * without, the whole history including legacy archives. A missing file reads
 * as no rows; any other read error throws.
 */
export async function readEventRows(
  dir: string,
  opts?: { runId?: string; limit?: number }
): Promise<PersistedEvent[]> {
  const path = eventsPath(dir)
  await settled(path)
  const runId = opts?.runId ?? basename(dir)
  if (!(await exists(path))) return []
  const limit = opts?.limit
  if (limit != null && limit > 0) {
    return parseRows(await readTail(path, tailBudgetForRows(limit)), runId, limit)
  }
  const parts: string[] = []
  for (const name of await legacyArchives(dir)) parts.push(await readFile(join(dir, name), 'utf8'))
  parts.push(await readFile(path, 'utf8'))
  return parseRows(parts.join(''), runId)
}

/** Default number of rows the UI hydrates; the full history stays on disk. */
export const HYDRATION_EVENT_LIMIT = 500

/**
 * Rows the transcript needs even when they fall outside the hydration window:
 * the latest of each, and every distinct write checkpoint (Keep/Undo).
 */
const CRITICAL_TYPES = new Set([
  'writes_checkpoint',
  'incomplete',
  'error',
  'status',
  'mode_changed',
  'compaction_verify_failed'
])

function eventType(row: PersistedEvent): string | undefined {
  const event = row.event
  if (!event || typeof event !== 'object') return undefined
  const type = (event as { type?: unknown }).type
  return typeof type === 'string' ? type : undefined
}

function checkpointIdOf(row: PersistedEvent): unknown {
  return (row.event as { checkpointId?: unknown }).checkpointId
}

function latestCriticalRows(rows: PersistedEvent[]): PersistedEvent[] {
  const latest = new Map<string, PersistedEvent>()
  const checkpoints: PersistedEvent[] = []
  const seenCheckpoints = new Set<string>()
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!
    const type = eventType(row)
    if (!type || !CRITICAL_TYPES.has(type)) continue
    if (type === 'status') {
      const status = (row.event as { status?: unknown }).status
      if (status !== 'done' && status !== 'cancelled' && status !== 'error') continue
    }
    if (type === 'writes_checkpoint') {
      const id = checkpointIdOf(row)
      if (typeof id !== 'string' || seenCheckpoints.has(id)) continue
      seenCheckpoints.add(id)
      checkpoints.push(row)
      continue
    }
    if (!latest.has(type)) latest.set(type, row)
  }
  return [...latest.values(), ...checkpoints]
}

/**
 * What the UI restores a run from: the trailing `limit` rows, plus the latest
 * critical rows found in a wider trailing window, so a long run still restores
 * its Keep/Undo checkpoints, mode and terminal status.
 */
export async function readHydrationEvents(
  dir: string,
  runId: string,
  limit = HYDRATION_EVENT_LIMIT
): Promise<PersistedEvent[]> {
  const path = eventsPath(dir)
  await settled(path)
  if (!(await exists(path))) return []
  const window = parseRows(await readTail(path, tailBudgetForRows(Math.max(limit * 10, 2000))), runId)
  const tail = window.length > limit ? window.slice(window.length - limit) : window
  const out = [...tail]
  for (const crit of latestCriticalRows(window)) {
    const type = eventType(crit)
    const present = out.some(
      (row) =>
        eventType(row) === type &&
        (type !== 'writes_checkpoint' || checkpointIdOf(row) === checkpointIdOf(crit))
    )
    if (!present) out.push(crit)
  }
  return out
}

/** Cumulative step_usage across the run's whole history (legacy archives included). */
export async function sumStepUsage(dir: string): Promise<StepUsageTotals> {
  return stepUsageTotalsFromPersistedEvents(await readEventRows(dir))
}

/**
 * Replace the run's event history with `rows` (rewind). Rows keep their own
 * `at`. Serialized behind queued appends; legacy archives go once the
 * replacement — which carries their content — is in place.
 */
export function rewriteEvents(dir: string, rows: PersistedEvent[]): Promise<void> {
  const path = eventsPath(dir)
  return runSerialized(path, async () => {
    const body = rows.map((row) => JSON.stringify({ at: row.at, event: row.event })).join('\n')
    await atomicWriteFileAsync(path, body ? `${body}\n` : '')
    for (const name of await legacyArchives(dir)) {
      await unlink(join(dir, name)).catch(() => undefined)
    }
  })
}
