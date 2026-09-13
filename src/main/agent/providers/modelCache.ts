import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ModelInfo, ProviderId } from '../../../shared/ipc'
import { ollamaNativeHost } from '../../../shared/domain/providers'
import { logger } from '../../../shared/logger'
import { atomicWriteJson } from '../../storage/atomicWrite'

type CacheEntry = {
  models: ModelInfo[]
  expiresAt: number
  /** Disk catalog age — do not refresh when another key is persisted. */
  diskSavedAt: number
}

/** Bump when catalog semantics change (e.g. Ollama thinking unknown ≠ false).
 *  v3: OpenCode Go rows gained registry context/output/modalities and
 *  transport-aware thinking fields; v2 rows hardcode supportsThinking:false. */
const DISK_CACHE_VERSION = 3 as const

type DiskFile = {
  version: typeof DISK_CACHE_VERSION
  entries: Record<string, { models: ModelInfo[]; savedAt: number }>
}

const TTL_MS = 5 * 60 * 1000
/** Disk catalog reused across process restarts (cold models:list was ~1.5s).
 *  Kept short: cached context-window data goes stale as providers update models. */
const DISK_TTL_MS = 24 * 60 * 60 * 1000

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<{ models: ModelInfo[]; warning?: string }>>()
/** Bumped when a new list fetch starts so a slower older fetch cannot overwrite cache. */
const listGeneration = new Map<string, number>()

let diskPathOverride: string | null = null
let diskLoaded = false

function bumpModelListGeneration(key: string): number {
  const next = (listGeneration.get(key) ?? 0) + 1
  listGeneration.set(key, next)
  return next
}

function currentModelListGeneration(key: string): number {
  return listGeneration.get(key) ?? 0
}

/** Normalize list/chat base URLs so Ollama `/v1` and native hosts share one cache slot. */
export function normalizeModelCacheBaseUrl(
  provider: ProviderId,
  baseUrl: string | undefined
): string {
  if (!baseUrl?.trim()) return ''
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (provider === 'ollama') return ollamaNativeHost(trimmed)
  return trimmed
}

export function modelCacheKey(
  provider: ProviderId,
  baseUrl: string | undefined,
  apiKey: string | null | undefined
): string {
  const fingerprint = apiKey
    ? createHash('sha256').update(apiKey).digest('hex').slice(0, 12)
    : 'nokey'
  const normalizedBaseUrl = normalizeModelCacheBaseUrl(provider, baseUrl)
  return `${provider}|${normalizedBaseUrl}|${fingerprint}`
}

function migrateDiskCacheKey(key: string): string {
  const fingerprintSep = key.lastIndexOf('|')
  if (fingerprintSep <= 0) return key
  const fingerprint = key.slice(fingerprintSep + 1)
  const rest = key.slice(0, fingerprintSep)
  const providerSep = rest.indexOf('|')
  if (providerSep <= 0) return key
  const provider = rest.slice(0, providerSep) as ProviderId
  const baseUrl = rest.slice(providerSep + 1)
  if (!baseUrl) return key
  const normalized = normalizeModelCacheBaseUrl(provider, baseUrl)
  if (normalized === baseUrl.replace(/\/+$/, '')) return key
  return `${provider}|${normalized}|${fingerprint}`
}

function resolveDiskPath(): string | null {
  if (diskPathOverride) return diskPathOverride
  try {
    // Lazy require so unit tests without Electron still work when override is set.
    const { app } = require('electron') as typeof import('electron')
    if (!app?.getPath) return null
    return join(app.getPath('userData'), 'model-catalog-cache.json')
  } catch {
    return null
  }
}

function ensureDiskLoaded(): void {
  if (diskLoaded) return
  diskLoaded = true
  const path = resolveDiskPath()
  if (!path || !existsSync(path)) return
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as DiskFile
    if (raw?.version !== DISK_CACHE_VERSION || !raw.entries) return
    const now = Date.now()
    const seenCanonical = new Set<string>()
    let needsCompaction = false
    for (const [rawKey, entry] of Object.entries(raw.entries)) {
      if (!entry?.models?.length) {
        needsCompaction = true
        continue
      }
      if (now - entry.savedAt > DISK_TTL_MS) {
        needsCompaction = true
        continue
      }
      const key = migrateDiskCacheKey(rawKey)
      if (rawKey !== key) needsCompaction = true
      if (seenCanonical.has(key)) needsCompaction = true
      else seenCanonical.add(key)
      const existing = cache.get(key)
      if (existing && existing.diskSavedAt >= entry.savedAt) continue
      cache.set(key, {
        models: entry.models,
        expiresAt: now + TTL_MS,
        diskSavedAt: entry.savedAt
      })
    }
    if (needsCompaction) persistDisk()
  } catch {
    /* corrupt cache — ignore */
  }
}

function persistDisk(): void {
  const path = resolveDiskPath()
  if (!path) return
  const now = Date.now()
  const entries: DiskFile['entries'] = {}
  for (const [key, entry] of cache) {
    if (!entry.models.length) continue
    // Preserve each key's original diskSavedAt so writing one provider does not
    // extend unrelated catalogs past the intended disk TTL.
    entries[key] = { models: entry.models, savedAt: entry.diskSavedAt || now }
  }
  try {
    atomicWriteJson(path, { version: DISK_CACHE_VERSION, entries } satisfies DiskFile)
  } catch {
    /* best-effort */
  }
}

export function getCachedModels(key: string): ModelInfo[] | null {
  ensureDiskLoaded()
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    cache.delete(key)
    return null
  }
  return entry.models
}

export function setCachedModels(key: string, models: ModelInfo[], generation?: number): void {
  if (generation !== undefined && generation !== currentModelListGeneration(key)) {
    logger.debug('Model cache update skipped due to stale generation', {
      key,
      generation,
      current: currentModelListGeneration(key)
    })
    return
  }
  ensureDiskLoaded()
  const now = Date.now()
  cache.set(key, { models, expiresAt: now + TTL_MS, diskSavedAt: now })
  persistDisk()
}

export function clearModelCache(): void {
  cache.clear()
  inflight.clear()
  listGeneration.clear()
  const path = resolveDiskPath()
  if (path && existsSync(path)) {
    try {
      atomicWriteJson(path, { version: DISK_CACHE_VERSION, entries: {} } satisfies DiskFile)
    } catch {
      /* ignore */
    }
  }
}

export function clearModelCacheKey(key: string): void {
  cache.delete(key)
  inflight.delete(key)
  bumpModelListGeneration(key)
  persistDisk()
}

/** Coalesce concurrent listProviderModels for the same cache key. */
export function getModelListInflight(
  key: string
): Promise<{ models: ModelInfo[]; warning?: string }> | undefined {
  return inflight.get(key)
}

export function setModelListInflight(
  key: string,
  promise: Promise<{ models: ModelInfo[]; warning?: string }>
): void {
  inflight.set(key, promise)
}

export function clearModelListInflight(key: string, promise: Promise<unknown>): void {
  if (inflight.get(key) === promise) inflight.delete(key)
}

/** Start a new catalog fetch generation; returns the token to pass to setCachedModels. */
export function beginModelListFetch(key: string): number {
  return bumpModelListGeneration(key)
}

/** @internal */
export function setModelCacheDiskPathForTests(path: string | null): void {
  diskPathOverride = path
  diskLoaded = false
  cache.clear()
  inflight.clear()
  listGeneration.clear()
}

/** @internal */
export function resetModelCacheForTests(): void {
  diskPathOverride = null
  diskLoaded = false
  cache.clear()
  inflight.clear()
  listGeneration.clear()
}

/** Eager load + compact legacy Ollama `/v1` keys and expired entries on app boot. */
export function compactModelCacheOnBoot(): void {
  ensureDiskLoaded()
}
