import { existsSync, readFileSync, renameSync, unlinkSync } from 'fs'
import { basename, join } from 'path'
import { z } from 'zod'
import { logger } from '../../shared/logger'
import { atomicWriteJson } from '@main/storage/atomicWrite'
import { ChatMessageSchema } from '@shared/ipc/schemas/agent'
import { followUpPreview, peekFollowUps, seedFollowUps, type FollowUpEntry } from './runRegistry'

const PersistedFollowUpSchema = z.object({
  id: z.string().min(1),
  message: ChatMessageSchema,
  ready: z.boolean().optional()
})

const FollowUpsFileSchema = z.object({
  updatedAt: z.string(),
  followUps: z.array(PersistedFollowUpSchema)
})

type PersistedFollowUpPreview = {
  id: string
  preview: string
  ready?: boolean
}

function followUpsPath(runDir: string): string {
  return join(runDir, 'followups.json')
}

/** Keep an unreadable queue on disk instead of letting the next write erase it. */
function quarantineFollowUps(path: string): void {
  try {
    renameSync(path, `${path}.corrupt-${Date.now()}`)
  } catch {
    // Best effort — the warning below still names the run.
  }
}

export function loadFollowUps(runDir: string): FollowUpEntry[] {
  const path = followUpsPath(runDir)
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const parsed = FollowUpsFileSchema.safeParse(raw)
    if (parsed.success) return parsed.data.followUps

    // These are messages the USER typed. Rather than dropping the whole queue
    // because one entry no longer matches the schema, keep every entry that
    // still parses — the same per-row salvage the events reader does.
    const rows = (raw as { followUps?: unknown })?.followUps
    const salvaged = Array.isArray(rows)
      ? rows.flatMap((row) => {
          const entry = PersistedFollowUpSchema.safeParse(row)
          return entry.success ? [entry.data] : []
        })
      : []
    logger.warn('Corrupt followups.json; kept the entries that still parse', {
      scope: 'state',
      correlationId: basename(runDir),
      kept: salvaged.length,
      discarded: Array.isArray(rows) ? rows.length - salvaged.length : 0,
      err: parsed.error
    })
    return salvaged
  } catch (err) {
    // Unreadable or not JSON at all — keep a copy so the user's queued
    // messages are recoverable instead of silently gone.
    quarantineFollowUps(path)
    logger.warn('Unreadable followups.json; quarantined and treating as empty', {
      scope: 'state',
      correlationId: basename(runDir),
      err
    })
    return []
  }
}

export function saveFollowUps(runDir: string, entries: FollowUpEntry[]): void {
  if (entries.length === 0) {
    clearFollowUps(runDir)
    return
  }
  atomicWriteJson(followUpsPath(runDir), {
    updatedAt: new Date().toISOString(),
    followUps: entries
  })
}

export function clearFollowUps(runDir: string): void {
  const path = followUpsPath(runDir)
  if (!existsSync(path)) return
  try {
    unlinkSync(path)
    return
  } catch {
    // A swallowed unlink leaves the JUST-APPLIED follow-up on disk, and
    // hydrateFollowUpsFromDisk re-seeds it on the next turn — the agent then
    // executes the same instruction a second time. On Windows this is the
    // ordinary AV/indexer lock, so fall back to an empty file: the atomic
    // writer retries the rename, and an empty list hydrates to nothing.
    try {
      atomicWriteJson(path, { updatedAt: new Date().toISOString(), followUps: [] })
      return
    } catch (writeErr) {
      logger.warn('Could not clear followups.json; queued follow-ups may re-apply', {
        scope: 'state',
        correlationId: basename(runDir),
        err: writeErr
      })
      return
    }
  }
}

/** Persist the in-memory follow-up queue for a run to disk. */
export function syncFollowUpsToDisk(runDir: string, runId: string): void {
  saveFollowUps(runDir, peekFollowUps(runId))
}

/** Load follow-ups from disk into the run registry (resume / chatStart). */
export function hydrateFollowUpsFromDisk(runDir: string, runId: string): void {
  const entries = loadFollowUps(runDir)
  if (entries.length > 0) seedFollowUps(runId, entries)
}

export function loadFollowUpPreviews(runDir: string): PersistedFollowUpPreview[] {
  return loadFollowUps(runDir).map((entry) => ({
    id: entry.id,
    preview: followUpPreview(entry.message),
    ...(entry.ready ? { ready: true } : {})
  }))
}
