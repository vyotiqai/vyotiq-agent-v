import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  COMPOSER_ATTACHMENT_MAX_BUCKETS,
  ComposerAttachmentsBucketSchema,
  type ComposerAttachmentsBucket
} from '@shared/ipc'
import { logger } from '../../shared/logger'
import { atomicWriteJsonAsync } from '../storage/atomicWrite'
import { workspaceAttachmentsDir } from '../storage/paths'

/** Sidecar file under {userData}/workspaces/{id}/attachments/ — never in the project tree. */
const SIDECAR_FILENAME = 'composer.json'

/** Refuse to persist one pathological bucket (24 × max-size parts can approach 400MB). */
const MAX_BUCKET_JSON_CHARS = 64 * 1024 * 1024

type StoredBucket = ComposerAttachmentsBucket & { savedAt: string }

type SidecarFile = { version: 1; buckets: Record<string, StoredBucket> }

const EMPTY: SidecarFile = { version: 1, buckets: {} }

/** Whole-file sidecar rewrites are serialized per workspace (read-modify-write). */
const writeChains = new Map<string, Promise<void>>()

function sidecarPath(workspacePath: string): string {
  return join(workspaceAttachmentsDir(workspacePath), SIDECAR_FILENAME)
}

async function readSidecar(workspacePath: string): Promise<SidecarFile> {
  try {
    const text = await readFile(sidecarPath(workspacePath), 'utf8')
    const raw = JSON.parse(text) as unknown
    if (!raw || typeof raw !== 'object') return EMPTY
    const buckets: Record<string, StoredBucket> = {}
    for (const [key, value] of Object.entries((raw as SidecarFile).buckets ?? {})) {
      const parsed = ComposerAttachmentsBucketSchema.safeParse(value)
      if (!parsed.success) continue
      const savedAt = (value as { savedAt?: unknown }).savedAt
      buckets[key] = { ...parsed.data, savedAt: typeof savedAt === 'string' ? savedAt : '' }
    }
    return { version: 1, buckets }
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      logger.warn('Failed to read composer attachments sidecar', {
        scope: 'attachments',
        workspacePath,
        err
      })
    }
    return EMPTY
  }
}

function enqueueWrite(workspacePath: string, rewrite: () => Promise<void>): Promise<void> {
  const prev = writeChains.get(workspacePath) ?? Promise.resolve()
  const next = prev.then(rewrite).catch((err) => {
    logger.warn('Failed to persist composer attachments', {
      scope: 'attachments',
      workspacePath,
      err
    })
  })
  writeChains.set(workspacePath, next)
  return next
}

function isBucketEmpty(bucket: ComposerAttachmentsBucket): boolean {
  return (
    bucket.images.length === 0 &&
    bucket.files.length === 0 &&
    bucket.nativeFiles.length === 0 &&
    bucket.audio.length === 0
  )
}

function sameBucket(a: ComposerAttachmentsBucket, b: ComposerAttachmentsBucket): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function stripSavedAt(stored: StoredBucket): ComposerAttachmentsBucket {
  const { savedAt: _savedAt, ...bucket } = stored
  return bucket
}

/** Read every persisted bucket for a workspace (run key → bucket). Async, memory-safe. */
export async function listComposerAttachmentsForWorkspace(
  workspacePath: string
): Promise<Record<string, ComposerAttachmentsBucket>> {
  // Read after any in-flight rewrite so a get following a set never sees stale data.
  await writeChains.get(workspacePath)
  const sidecar = await readSidecar(workspacePath)
  const out: Record<string, ComposerAttachmentsBucket> = {}
  for (const [key, stored] of Object.entries(sidecar.buckets)) {
    const { savedAt: _savedAt, ...bucket } = stored
    out[key] = bucket
  }
  return out
}

/**
 * Replace the persisted bucket map with the renderer's in-memory view — keys
 * absent from the payload are deleted (whole-map replace, mirror of Get), an
 * all-empty payload clears the file. Unchanged buckets keep their savedAt so
 * LRU order tracks real last-use, not the debounce cadence.
 */
export function setComposerAttachmentsForWorkspace(
  workspacePath: string,
  buckets: Record<string, ComposerAttachmentsBucket>
): Promise<void> {
  return enqueueWrite(workspacePath, async () => {
    const sidecar = await readSidecar(workspacePath)
    const now = new Date().toISOString()
    const next: Record<string, StoredBucket> = {}
    for (const [key, bucket] of Object.entries(buckets)) {
      if (isBucketEmpty(bucket)) continue
      if (JSON.stringify(bucket).length > MAX_BUCKET_JSON_CHARS) {
        logger.warn('Composer attachment bucket too large to persist; dropping', {
          scope: 'attachments',
          workspacePath,
          key
        })
        continue
      }
      const prev = sidecar.buckets[key]
      next[key] = {
        ...bucket,
        savedAt: prev && sameBucket(stripSavedAt(prev), bucket) ? prev.savedAt : now
      }
    }
    let entries = Object.entries(next)
    // LRU by savedAt; equal timestamps keep insertion order (stable sort), so
    // the oldest-inserted keys are evicted first within one millisecond.
    if (entries.length > COMPOSER_ATTACHMENT_MAX_BUCKETS) {
      entries.sort((a, b) => (a[1].savedAt || '').localeCompare(b[1].savedAt || ''))
      entries = entries.slice(entries.length - COMPOSER_ATTACHMENT_MAX_BUCKETS)
    }
    await atomicWriteJsonAsync(sidecarPath(workspacePath), {
      version: 1,
      buckets: Object.fromEntries(entries)
    })
  })
}

/** Remove one run key's persisted bucket. */
export function clearComposerAttachmentsForWorkspace(
  workspacePath: string,
  key: string
): Promise<void> {
  return enqueueWrite(workspacePath, async () => {
    const sidecar = await readSidecar(workspacePath)
    if (!(key in sidecar.buckets)) return
    const { [key]: _removed, ...buckets } = sidecar.buckets
    await atomicWriteJsonAsync(sidecarPath(workspacePath), { version: 1, buckets })
  })
}
