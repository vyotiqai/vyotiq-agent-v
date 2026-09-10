import { existsSync, readFileSync, unlinkSync } from 'fs'
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

export type PersistedFollowUpPreview = {
  id: string
  preview: string
  ready?: boolean
}

function followUpsPath(runDir: string): string {
  return join(runDir, 'followups.json')
}

export function loadFollowUps(runDir: string): FollowUpEntry[] {
  const path = followUpsPath(runDir)
  if (!existsSync(path)) return []
  try {
    const parsed = FollowUpsFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (!parsed.success) throw parsed.error
    return parsed.data.followUps
  } catch (err) {
    logger.warn('Corrupt followups.json; treating as empty', {
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
  } catch {
    // ignore missing or locked file
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
