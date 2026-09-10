/**
 * Storage retention (audit H4 checkpoint blobs + H5 per-workspace runtime
 * storage), per remediation/12-storage-retention-design.md §6.4:
 * checkpoint GC (keep-last-N + age backstop + free resolved/undone pass),
 * orphan reaper (grace + confirmation-gated), prune-on-workspace-removal
 * support, managed size cap, and the live storage report shared by the
 * Settings surface and the GC preview.
 *
 * Every failure is skip-and-log (audit M3 lesson) — a retention sweep must
 * never break a run. All fs access is `fs/promises` (zero sync I/O on main).
 */
import { readdir, readFile, rm, stat } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { userDataRoot, workspacesRoot, workspaceSessionsRoot } from './paths'
import { listActiveRuns } from '../agent/runRegistry'
import { getSettings } from '../settings/settings'
import { workspaceIdFromPath } from '../../shared/utils/workspaceId'
import { canonicalizeWorkspacePath } from '../../shared/utils/workspacePath'
import { getWorkspaces } from '../workspace/workspaces'
import { logger } from '../../shared/logger'
import type {
  Settings,
  StorageCleanupPreviewCategory,
  StorageCleanupPreviewResult,
  StorageCleanupRunResult,
  StorageReportCategory,
  StorageReportResult,
  StorageReportWorkspace
} from '../../shared/ipc'

/** Never delete anything written inside this window (design §8.4). */
export const PROTECTED_WINDOW_MS = 24 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

type DirMeasure = { bytes: number; files: number; lastWriteMs: number }

const EMPTY_MEASURE: DirMeasure = { bytes: 0, files: 0, lastWriteMs: 0 }

/** Measure a directory recursively (async walk; skips unreadable entries). */
export async function measureDir(root: string): Promise<DirMeasure> {
  const out: DirMeasure = { bytes: 0, files: 0, lastWriteMs: 0 }
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      try {
        if (entry.isDirectory()) {
          await walk(abs)
        } else if (entry.isFile()) {
          const st = await stat(abs)
          out.bytes += st.size
          out.files++
          if (st.mtimeMs > out.lastWriteMs) out.lastWriteMs = st.mtimeMs
        }
      } catch {
        // unreadable entry — skip, never fatal
      }
    }
  }
  try {
    out.lastWriteMs = (await stat(root)).mtimeMs
  } catch {
    return EMPTY_MEASURE
  }
  await walk(root)
  return out
}

/** Measure each direct child directory of `root`, keyed by name. */
export async function measureChildDirs(
  root: string
): Promise<Map<string, DirMeasure>> {
  const out = new Map<string, DirMeasure>()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    out.set(entry.name, await measureDir(join(root, entry.name)))
  }
  return out
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

/** Read + JSON.parse; null on any failure (never fatal). */
async function readJson(p: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as unknown
  } catch {
    return null
  }
}

type CheckpointIndexShape = {
  checkpoints?: Array<{ id?: unknown; createdAt?: string; undone?: boolean } | null>
}

type CheckpointMetaShape = {
  createdAt?: string
  undone?: boolean
  resolved?: boolean
}

/** One checkpoint dir under `{runDir}/checkpoints/{id}` with meta flags + size. */
export type CheckpointDirInfo = {
  id: string
  runDir: string
  dir: string
  bytes: number
  files: number
  lastWriteMs: number
  createdAtMs: number | null
  undone: boolean
  resolved: boolean
}

/** Protected window: anything written in the last 24 h is untouchable. */
export function withinProtectedWindow(lastWriteMs: number, nowMs: number): boolean {
  return nowMs - lastWriteMs < PROTECTED_WINDOW_MS
}

/**
 * Session dirs of active runs are never swept. Resolved from the live run
 * registry (`isActive` keeps the post-terminal unwind window covered too).
 */
export function activeRunDirs(): Set<string> {
  const out = new Set<string>()
  for (const run of listActiveRuns()) {
    try {
      out.add(join(workspaceSessionsRoot(run.workspacePath), run.runId))
    } catch {
      // unresolvable workspace path — skip
    }
  }
  return out
}

/** Load a run's checkpoint index.json (append-only; tolerates missing blobs). */
async function loadCheckpointIndex(runDir: string): Promise<CheckpointIndexShape | null> {
  return (await readJson(join(runDir, 'checkpoints', 'index.json'))) as CheckpointIndexShape | null
}

/** Scan one run dir's checkpoint dirs with meta flags + measured sizes. */
async function scanRunCheckpoints(runDir: string): Promise<CheckpointDirInfo[]> {
  const root = join(runDir, 'checkpoints')
  if (!(await dirExists(root))) return []
  const index = await loadCheckpointIndex(runDir)
  const byId = new Map<string, { createdAt?: string; undone?: boolean }>()
  if (index && Array.isArray(index.checkpoints)) {
    for (const c of index.checkpoints) {
      if (c == null || typeof c.id !== 'string') continue
      byId.set(c.id, { createdAt: c.createdAt, undone: c.undone })
    }
  }
  const out: CheckpointDirInfo[] = []
  for (const [id, measure] of await measureChildDirs(root)) {
    const meta = (await readJson(join(root, id, 'meta.json'))) as CheckpointMetaShape | null
    const idxEntry = byId.get(id)
    const createdAt =
      (typeof meta?.createdAt === 'string' && meta.createdAt) ||
      idxEntry?.createdAt ||
      null
    const createdAtMs = createdAt ? Date.parse(createdAt) : null
    out.push({
      id,
      runDir,
      dir: join(root, id),
      bytes: measure.bytes,
      files: measure.files,
      lastWriteMs: measure.lastWriteMs,
      createdAtMs: Number.isFinite(createdAtMs) ? (createdAtMs as number) : null,
      undone: meta?.undone === true || idxEntry?.undone === true,
      resolved: meta?.resolved === true
    })
  }
  return out
}

type SessionInfo = {
  runId: string
  dir: string
  bytes: number
  files: number
  lastWriteMs: number
  hasCheckpoints: boolean
}

/**
 * All session dirs of one workspace, newest-first by last write. Shallow
 * scan (readdir + stat per dir, no recursive size walk) so run-end sweeps
 * stay cheap; full byte measurement happens only when a dir is about to be
 * deleted or previewed for reclaim.
 */
async function scanSessions(sessionsRoot: string): Promise<SessionInfo[]> {
  const out: SessionInfo[] = []
  let entries
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(sessionsRoot, entry.name)
    let lastWriteMs = 0
    try {
      lastWriteMs = (await stat(dir)).mtimeMs
    } catch {
      continue
    }
    out.push({
      runId: entry.name,
      dir,
      bytes: 0,
      files: 0,
      lastWriteMs,
      hasCheckpoints: await dirExists(join(dir, 'checkpoints'))
    })
  }
  out.sort((a, b) => b.lastWriteMs - a.lastWriteMs)
  return out
}

/** All run-dir names under one workspace's sessions root. */
async function listRunIds(sessionsRoot: string): Promise<string[]> {
  try {
    return (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** Storage-id dir names under `workspaces/` — shallow readdir, no size walk. */
async function listStorageIds(): Promise<string[]> {
  try {
    return (await readdir(workspacesRoot(), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * Workspaces.json-referenced storage ids: any path in open/recent/uiState/
 * settingsOverrides/workspaceIdsByPath. A dir whose id is tracked anywhere
 * must never be reaped as an orphan (§8.4 "Unknown-mapping orphan").
 */
export async function resolveTrackedWorkspaceIds(): Promise<Map<string, string>> {
  const state = getWorkspaces()
  const out = new Map<string, string>()
  const paths = [
    ...state.openPaths,
    ...state.recentPaths,
    ...Object.keys(state.uiStateByPath),
    ...Object.keys(state.settingsOverridesByPath),
    ...Object.keys(state.workspaceIdsByPath ?? {})
  ]
  for (const p of paths) {
    if (!p) continue
    try {
      const id = workspaceIdFromPath(p)
      if (!out.has(id)) out.set(id, p)
    } catch {
      // unresolvable path — skip
    }
  }
  // workspaceIdsByPath values are authoritative even when the path is not open.
  for (const [p, id] of Object.entries(state.workspaceIdsByPath ?? {})) {
    if (!out.has(id)) out.set(id, p)
  }
  return out
}

function categoryEntry(
  id: string,
  label: string,
  measure: DirMeasure,
  managed: boolean
): StorageReportCategory {
  return { id, label, bytes: measure.bytes, files: measure.files, managed }
}

/** Sum checkpoint dirs across every session of every storage id. */
async function measureCheckpointsCategory(
  storageIds: string[]
): Promise<DirMeasure> {
  let bytes = 0
  let files = 0
  let lastWriteMs = 0
  for (const id of storageIds) {
    const sessionsDir = join(workspacesRoot(), id, 'sessions')
    if (!(await dirExists(sessionsDir))) continue
    for (const runId of await listRunIds(sessionsDir)) {
      const m = await measureDir(join(sessionsDir, runId, 'checkpoints'))
      bytes += m.bytes
      files += m.files
      if (m.lastWriteMs > lastWriteMs) lastWriteMs = m.lastWriteMs
    }
  }
  return { bytes, files, lastWriteMs }
}

/** messages.jsonl + events.jsonl (+ archives) across all sessions. */
async function measureTranscriptsCategory(storageIds: string[]): Promise<DirMeasure> {
  let bytes = 0
  let files = 0
  let lastWriteMs = 0
  for (const id of storageIds) {
    const sessionsDir = join(workspacesRoot(), id, 'sessions')
    if (!(await dirExists(sessionsDir))) continue
    for (const runId of await listRunIds(sessionsDir)) {
      const runDir = join(sessionsDir, runId)
      try {
        const entries = await readdir(runDir)
        for (const name of entries) {
          if (!/^(messages|events)\.(jsonl|archive\.)/.test(name) && !/^messages\.archive\./.test(name)) {
            continue
          }
          try {
            const st = await stat(join(runDir, name))
            bytes += st.size
            files++
            if (st.mtimeMs > lastWriteMs) lastWriteMs = st.mtimeMs
          } catch {
            /* skip */
          }
        }
      } catch {
        /* skip run dir */
      }
    }
  }
  return { bytes, files, lastWriteMs }
}

/** Browser partitions live directly under userData as vyotiq-agent-browser-*. */
async function measureBrowserPartitions(): Promise<DirMeasure> {
  let bytes = 0
  let files = 0
  const root = userDataRoot()
  try {
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!/^vyotiq-agent-browser-/.test(entry.name)) continue
      const m = await measureDir(join(root, entry.name))
      bytes += m.bytes
      files += m.files
    }
  } catch {
    /* skip */
  }
  return { bytes, files, lastWriteMs: 0 }
}

/** Live storage report: per-category rollup + per-workspace storage dirs. */
export async function collectStorageReport(): Promise<StorageReportResult> {
  const settings = getSettings()
  const nowMs = Date.now()
  const root = userDataRoot()
  const storageIds = await listStorageIds()

  const [
    checkpoints,
    transcripts,
    traces,
    logs,
    dictationModels,
    embedderModel,
    partitions,
    cache
  ] = await Promise.all([
    measureCheckpointsCategory(storageIds),
    measureTranscriptsCategory(storageIds),
    measureDir(join(root, 'traces')).catch(() => EMPTY_MEASURE),
    measureDir(join(root, 'logs')).catch(() => EMPTY_MEASURE),
    measureDir(join(root, 'dictation', 'models')).catch(() => EMPTY_MEASURE),
    measureDir(join(root, 'codeindex', 'models')).catch(() => EMPTY_MEASURE),
    measureBrowserPartitions(),
    measureDir(join(root, 'Cache')).catch(() => EMPTY_MEASURE)
  ])

  // Per-storage-dir rollup — drives orphan discovery + per-workspace detail.
  const tracked = await resolveTrackedWorkspaceIds()
  const storageMeasures = await measureChildDirs(workspacesRoot())
  const workspaces: StorageReportWorkspace[] = []
  for (const [id, measure] of storageMeasures) {
    const trackedPath = tracked.get(id) ?? null
    const sessionsDir = join(workspacesRoot(), id, 'sessions')
    const sessionCount = (await dirExists(sessionsDir))
      ? (await listRunIds(sessionsDir)).length
      : 0
    const idleDays = Math.max(0, Math.floor((nowMs - measure.lastWriteMs) / DAY_MS))
    workspaces.push({
      workspaceId: id,
      path: trackedPath,
      displayName: trackedPath ? trackedPath.split(/[\\/]/).filter(Boolean).pop() ?? trackedPath : null,
      bytes: measure.bytes,
      files: measure.files,
      sessionCount,
      tracked: trackedPath != null,
      idleDays,
      reapable:
        settings.storage.orphanReaperEnabled &&
        trackedPath == null &&
        idleDays >= settings.storage.orphanGraceDays
    })
  }
  workspaces.sort((a, b) => b.bytes - a.bytes)

  // Worktrees + indexes per storage dir.
  let worktreeBytes = 0
  let worktreeFiles = 0
  let indexBytes = 0
  let indexFiles = 0
  for (const id of storageIds) {
    const wt = await measureDir(join(workspacesRoot(), id, 'instance-worktrees'))
    worktreeBytes += wt.bytes
    worktreeFiles += wt.files
    const ci = await measureDir(join(workspacesRoot(), id, 'codeindex'))
    const sg = await measureDir(join(workspacesRoot(), id, 'sparsegrep'))
    indexBytes += ci.bytes + sg.bytes
    indexFiles += ci.files + sg.files
  }

  const categories: StorageReportCategory[] = [
    categoryEntry('checkpoints', 'Checkpoints', checkpoints, true),
    categoryEntry('transcripts', 'Session transcripts', transcripts, true),
    categoryEntry('worktrees', 'Instance worktrees', { bytes: worktreeBytes, files: worktreeFiles, lastWriteMs: 0 }, true),
    categoryEntry('indexes', 'Workspace indexes', { bytes: indexBytes, files: indexFiles, lastWriteMs: 0 }, true),
    categoryEntry('traces', 'Traces', traces, true),
    categoryEntry('logs', 'Logs', logs, true),
    categoryEntry('dictation-models', 'Dictation models', dictationModels, false),
    categoryEntry('embedder-model', 'Embedder model', embedderModel, false),
    categoryEntry('browser-partitions', 'Browser partitions', partitions, false),
    categoryEntry('cache', 'Cache', cache, false)
  ]

  const totalBytes = categories.reduce((sum, c) => sum + c.bytes, 0)
  const managedBytes = categories.filter((c) => c.managed).reduce((s, c) => s + c.bytes, 0)
  const sizeCapBytes = settings.storage.sizeCapGb * 1024 * 1024 * 1024
  return {
    categories,
    workspaces,
    totalBytes,
    managedBytes,
    sizeCapBytes,
    overCap: managedBytes > sizeCapBytes
  }
}

/* ---------------------------------------------------------------------------
 * Checkpoint GC (design §6.1 A1 + A3 folded in as the free first pass)
 * ------------------------------------------------------------------------- */

export type CheckpointSweepResult = {
  bytes: number
  dirs: number
  skipped: number
}

/** Sessions of a workspace that carry checkpoint dirs (newest-first). */
async function checkpointBearingSessions(
  sessionsRoot: string
): Promise<SessionInfo[]> {
  return (await scanSessions(sessionsRoot)).filter((s) => s.hasCheckpoints)
}

/**
 * Free pass (A3): delete checkpoint dirs whose meta says `resolved` and/or
 * `undone` — history the user has already explicitly discarded. Protected
 * window still applies (never anything written in the last 24 h).
 */
async function sweepResolvedUndone(
  runDir: string,
  nowMs: number
): Promise<CheckpointSweepResult> {
  const out: CheckpointSweepResult = { bytes: 0, dirs: 0, skipped: 0 }
  for (const cp of await scanRunCheckpoints(runDir)) {
    if (!(cp.undone || cp.resolved)) continue
    if (withinProtectedWindow(cp.lastWriteMs, nowMs)) {
      out.skipped++
      continue
    }
    try {
      await rm(cp.dir, { recursive: true, force: true })
      out.bytes += cp.bytes
      out.dirs++
      logger.warn('Evicted resolved/undone checkpoint blob dir', {
        scope: 'storage',
        code: 'CHECKPOINT_BLOB_EVICTED',
        correlationId: cp.runDir.split(/[\\/]/).pop() ?? cp.runDir,
        checkpointId: cp.id,
        reason: cp.resolved ? 'resolved' : 'undone',
        bytes: cp.bytes
      })
    } catch (err) {
      out.skipped++
      logger.warn('Failed to evict resolved/undone checkpoint dir (skipped)', {
        scope: 'storage',
        code: 'CHECKPOINT_BLOB_EVICTED',
        correlationId: cp.runDir.split(/[\\/]/).pop() ?? cp.runDir,
        checkpointId: cp.id,
        err
      })
    }
  }
  return out
}

/**
 * Count-capped GC (A1): keep the newest N checkpoint-bearing sessions per
 * workspace, delete older ones' checkpoint dirs; 30-day age backstop deletes
 * checkpoint dirs whose session is older than the window even when under N.
 * Active runs (registry `isActive`) and the 24 h protected window exclude.
 */
async function sweepCheckpointCountCap(
  sessionsRoot: string,
  settings: Settings,
  nowMs: number,
  protectedRuns: Set<string>
): Promise<CheckpointSweepResult> {
  const out: CheckpointSweepResult = { bytes: 0, dirs: 0, skipped: 0 }
  if (!settings.storage.checkpointGcEnabled) return out
  const sessions = await checkpointBearingSessions(sessionsRoot)
  const keep = settings.storage.checkpointKeepSessions
  const ageCutoff = nowMs - settings.storage.checkpointMaxAgeDays * DAY_MS
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]
    if (protectedRuns.has(session.dir)) {
      out.skipped++
      continue
    }
    if (withinProtectedWindow(session.lastWriteMs, nowMs)) {
      out.skipped++
      continue
    }
    const beyondCount = i >= keep
    const beyondAge = session.lastWriteMs < ageCutoff
    if (!beyondCount && !beyondAge) continue
    // Delete only the checkpoints dir — transcript history stays (session
    // retention is a separate, opt-in policy).
    const cpRoot = join(session.dir, 'checkpoints')
    try {
      const m = await measureDir(cpRoot)
      await rm(cpRoot, { recursive: true, force: true })
      out.bytes += m.bytes
      out.dirs++
      logger.warn('Evicted checkpoint dir (count/age cap)', {
        scope: 'storage',
        code: 'CHECKPOINT_BLOB_EVICTED',
        correlationId: session.runId,
        reason: beyondCount && beyondAge ? 'count+age' : beyondCount ? 'count' : 'age',
        bytes: m.bytes
      })
    } catch (err) {
      out.skipped++
      logger.warn('Failed to evict checkpoint dir (skipped)', {
        scope: 'storage',
        code: 'CHECKPOINT_BLOB_EVICTED',
        correlationId: session.runId,
        err
      })
    }
  }
  return out
}

/** Preview-only variant of the count-cap sweep: computes, never deletes. */
async function previewCheckpointSweep(
  sessionsRoot: string,
  settings: Settings,
  nowMs: number,
  protectedRuns: Set<string>
): Promise<CheckpointSweepResult> {
  const out: CheckpointSweepResult = { bytes: 0, dirs: 0, skipped: 0 }
  if (!settings.storage.checkpointGcEnabled) return out
  const sessions = await checkpointBearingSessions(sessionsRoot)
  const keep = settings.storage.checkpointKeepSessions
  const ageCutoff = nowMs - settings.storage.checkpointMaxAgeDays * DAY_MS
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]
    if (protectedRuns.has(session.dir) || withinProtectedWindow(session.lastWriteMs, nowMs)) {
      out.skipped++
      continue
    }
    if (i >= keep || session.lastWriteMs < ageCutoff) {
      const m = await measureDir(join(session.dir, 'checkpoints'))
      out.bytes += m.bytes
      out.dirs++
    }
  }
  return out
}

/* ---------------------------------------------------------------------------
 * Orphan reaper (design §6.2 B3)
 * ------------------------------------------------------------------------- */

/**
 * Untracked storage dirs idle ≥ grace days. Never deletes by itself — the
 * report marks dirs `reapable` and deletion happens only via the confirm-
 * token cleanup run (explicit user action).
 */
export function selectOrphanDirs(
  workspaces: StorageReportWorkspace[],
  settings: Settings,
  nowMs: number
): StorageReportWorkspace[] {
  if (!settings.storage.orphanReaperEnabled) return []
  return workspaces.filter(
    (w) => !w.tracked && w.idleDays >= settings.storage.orphanGraceDays
  )
}

async function reapOrphanDirs(
  orphans: StorageReportWorkspace[]
): Promise<{ bytes: number; dirs: number; skipped: number }> {
  const out = { bytes: 0, dirs: 0, skipped: 0 }
  for (const orphan of orphans) {
    const dir = join(workspacesRoot(), orphan.workspaceId)
    try {
      await rm(dir, { recursive: true, force: true })
      out.bytes += orphan.bytes
      out.dirs++
      logger.warn('Reaped orphan workspace storage dir', {
        scope: 'storage',
        code: 'ORPHAN_STORAGE_REAPED',
        workspaceId: orphan.workspaceId,
        bytes: orphan.bytes
      })
    } catch (err) {
      out.skipped++
      logger.warn('Failed to reap orphan storage dir (skipped)', {
        scope: 'storage',
        code: 'ORPHAN_STORAGE_REAPED',
        workspaceId: orphan.workspaceId,
        err
      })
    }
  }
  return out
}

/* ---------------------------------------------------------------------------
 * Size cap (design §6.4.5) — LRU backstop over managed surfaces only
 * ------------------------------------------------------------------------- */

/** Oldest checkpoint dirs first until the managed set fits the cap. */
async function enforceSizeCap(
  settings: Settings,
  protectedRuns: Set<string>,
  nowMs: number
): Promise<{ bytes: number; dirs: number; skipped: number }> {
  const out = { bytes: 0, dirs: 0, skipped: 0 }
  const report = await collectStorageReport()
  const capBytes = settings.storage.sizeCapGb * 1024 * 1024 * 1024
  if (report.managedBytes <= capBytes) return out

  // LRU candidates: checkpoint dirs across all workspaces, oldest first.
  type Candidate = { dir: string; bytes: number; lastWriteMs: number; runId: string }
  const candidates: Candidate[] = []
  const storageIds = await listStorageIds()
  for (const id of storageIds) {
    const sessionsDir = join(workspacesRoot(), id, 'sessions')
    if (!(await dirExists(sessionsDir))) continue
    for (const runId of await listRunIds(sessionsDir)) {
      const dir = join(sessionsDir, runId)
      if (protectedRuns.has(dir)) continue
      for (const cp of await scanRunCheckpoints(dir)) {
        if (withinProtectedWindow(cp.lastWriteMs, nowMs) || cp.undone || cp.resolved) continue
        candidates.push({
          dir: cp.dir,
          bytes: cp.bytes,
          lastWriteMs: cp.lastWriteMs,
          runId
        })
      }
    }
  }
  candidates.sort((a, b) => a.lastWriteMs - b.lastWriteMs)

  let excess = report.managedBytes - capBytes
  for (const cand of candidates) {
    if (excess <= 0) break
    try {
      await rm(cand.dir, { recursive: true, force: true })
      out.bytes += cand.bytes
      out.dirs++
      excess -= cand.bytes
      logger.warn('Size-cap LRU eviction of checkpoint dir', {
        scope: 'storage',
        code: 'SIZE_CAP_EVICTED',
        correlationId: cand.runId,
        bytes: cand.bytes
      })
    } catch (err) {
      out.skipped++
      logger.warn('Size-cap eviction failed (skipped)', {
        scope: 'storage',
        code: 'SIZE_CAP_EVICTED',
        correlationId: cand.runId,
        err
      })
    }
  }
  return out
}

/* ---------------------------------------------------------------------------
 * Session retention (design §6.2 B2 — opt-in, applies on demand)
 * ------------------------------------------------------------------------- */

export type SessionSweepResult = { bytes: number; dirs: number; skipped: number }

/** keep-last-N / age-window session deletion per workspace (min 1 kept). */
async function sweepSessions(
  sessionsRoot: string,
  settings: Settings,
  nowMs: number,
  protectedRuns: Set<string>
): Promise<SessionSweepResult> {
  const out: SessionSweepResult = { bytes: 0, dirs: 0, skipped: 0 }
  const sessions = await scanSessions(sessionsRoot)
  const keep = Math.max(1, settings.storage.sessionKeepCount)
  const ageCutoff = nowMs - settings.storage.sessionMaxAgeDays * DAY_MS
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]
    if (i < keep) continue
    if (protectedRuns.has(session.dir) || withinProtectedWindow(session.lastWriteMs, nowMs)) {
      out.skipped++
      continue
    }
    // Both bounds apply: beyond keep-N AND older than the age window.
    if (session.lastWriteMs >= ageCutoff) continue
    try {
      const m = await measureDir(session.dir)
      await rm(session.dir, { recursive: true, force: true })
      out.bytes += m.bytes
      out.dirs++
      logger.warn('Evicted old session dir (session retention)', {
        scope: 'storage',
        code: 'SESSION_DIR_EVICTED',
        correlationId: session.runId,
        bytes: session.bytes
      })
    } catch (err) {
      out.skipped++
      logger.warn('Failed to evict session dir (skipped)', {
        scope: 'storage',
        code: 'SESSION_DIR_EVICTED',
        correlationId: session.runId,
        err
      })
    }
  }
  return out
}

/** Preview-only variant of the session retention sweep. */
async function previewSessionSweep(
  sessionsRoot: string,
  settings: Settings,
  nowMs: number,
  protectedRuns: Set<string>
): Promise<SessionSweepResult> {
  const out: SessionSweepResult = { bytes: 0, dirs: 0, skipped: 0 }
  if (!settings.storage.sessionRetentionEnabled) return out
  const sessions = await scanSessions(sessionsRoot)
  const keep = Math.max(1, settings.storage.sessionKeepCount)
  const ageCutoff = nowMs - settings.storage.sessionMaxAgeDays * DAY_MS
  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i]
    if (i < keep) continue
    if (protectedRuns.has(session.dir) || withinProtectedWindow(session.lastWriteMs, nowMs)) {
      out.skipped++
      continue
    }
    if (session.lastWriteMs >= ageCutoff) continue
    const m = await measureDir(session.dir)
    out.bytes += m.bytes
    out.dirs++
  }
  return out
}

/* ---------------------------------------------------------------------------
 * Sweeps + confirm-token cleanup flow
 * ------------------------------------------------------------------------- */

type MintedCleanupToken = { token: string; mintedAtMs: number }

let pendingCleanupToken: MintedCleanupToken | null = null
const CLEANUP_TOKEN_TTL_MS = 10 * 60 * 1000

/** Preview the full "Free up space" sweep without deleting anything. */
export async function previewStorageCleanup(): Promise<StorageCleanupPreviewResult> {
  const settings = getSettings()
  const nowMs = Date.now()
  const protectedRuns = activeRunDirs()
  const acked = settings.storageSurfaceAcked

  const categories: StorageCleanupPreviewCategory[] = []
  let totalReclaimBytes = 0

  const pushCategory = (id: string, label: string, r: { bytes: number; dirs: number }): void => {
    categories.push({ id, label, reclaimBytes: r.bytes, items: r.dirs })
    totalReclaimBytes += r.bytes
  }

  // Checkpoint GC (A3 free pass always previewed; A1 needs ack).
  const storageIds = await listStorageIds()
  let checkpointBytes = 0
  let checkpointDirs = 0
  for (const id of storageIds) {
    const sessionsRoot = join(workspacesRoot(), id, 'sessions')
    if (!(await dirExists(sessionsRoot))) continue
    for (const runId of await listRunIds(sessionsRoot)) {
      const runDir = join(sessionsRoot, runId)
      if (protectedRuns.has(runDir)) continue
      const r = await sweepResolvedUndonePreview(runDir, nowMs)
      checkpointBytes += r.bytes
      checkpointDirs += r.dirs
    }
    if (acked && settings.storage.checkpointGcEnabled) {
      const r = await previewCheckpointSweep(sessionsRoot, settings, nowMs, protectedRuns)
      checkpointBytes += r.bytes
      checkpointDirs += r.dirs
    }
  }
  pushCategory('checkpoints', 'Checkpoints', { bytes: checkpointBytes, dirs: checkpointDirs })

  // Session retention (manual flow always applies policy, acked or not — it
  // is user-confirmed here, satisfying the §8.1 first-run suspension).
  for (const id of storageIds) {
    const sessionsRoot = join(workspacesRoot(), id, 'sessions')
    if (!(await dirExists(sessionsRoot))) continue
    const r = await previewSessionSweep(sessionsRoot, settings, nowMs, protectedRuns)
    const existing = categories.find((c) => c.id === 'sessions')
    if (existing) {
      existing.reclaimBytes += r.bytes
      existing.items += r.dirs
      totalReclaimBytes += r.bytes
    } else {
      pushCategory('sessions', 'Old sessions', r)
    }
  }

  // Orphan dirs (confirm-gated; grace applies).
  const report = await collectStorageReport()
  const orphans = selectOrphanDirs(report.workspaces, settings, nowMs)
  const orphanBytes = orphans.reduce((sum, o) => sum + o.bytes, 0)
  if (orphans.length > 0) {
    categories.push({
      id: 'orphans',
      label: 'Untracked workspace storage',
      reclaimBytes: orphanBytes,
      items: orphans.length
    })
    totalReclaimBytes += orphanBytes
  }

  const token = randomUUID()
  pendingCleanupToken = { token, mintedAtMs: nowMs }
  return { categories, totalReclaimBytes, orphanDirs: orphans, confirm: { token, mintedAt: new Date(nowMs).toISOString() } }
}

/** Preview-only A3 pass (resolved/undone blobs). */
async function sweepResolvedUndonePreview(
  runDir: string,
  nowMs: number
): Promise<CheckpointSweepResult> {
  const out: CheckpointSweepResult = { bytes: 0, dirs: 0, skipped: 0 }
  for (const cp of await scanRunCheckpoints(runDir)) {
    if (!(cp.undone || cp.resolved)) continue
    if (withinProtectedWindow(cp.lastWriteMs, nowMs)) {
      out.skipped++
      continue
    }
    out.bytes += cp.bytes
    out.dirs++
  }
  return out
}

/** Run the confirmed cleanup. Token must match the pending preview mint. */
export async function runStorageCleanup(confirmToken: string): Promise<StorageCleanupRunResult> {
  const settings = getSettings()
  const nowMs = Date.now()
  if (
    !pendingCleanupToken ||
    pendingCleanupToken.token !== confirmToken ||
    nowMs - pendingCleanupToken.mintedAtMs > CLEANUP_TOKEN_TTL_MS
  ) {
    throw new Error('Cleanup confirmation expired — preview again')
  }
  pendingCleanupToken = null

  const protectedRuns = activeRunDirs()
  const storageIds = await listStorageIds()
  const categories: StorageCleanupPreviewCategory[] = []
  let totalReclaimedBytes = 0
  let removedDirs = 0
  let skipped = 0

  const pushCategory = (id: string, label: string, r: { bytes: number; dirs: number; skipped: number }): void => {
    const existing = categories.find((c) => c.id === id)
    if (existing) {
      existing.reclaimBytes += r.bytes
      existing.items += r.dirs
    } else {
      categories.push({ id, label, reclaimBytes: r.bytes, items: r.dirs })
    }
    totalReclaimedBytes += r.bytes
    removedDirs += r.dirs
    skipped += r.skipped
  }

  const acked = settings.storageSurfaceAcked

  // A3 free pass (always runs — data the user already discarded).
  for (const id of storageIds) {
    const sessionsRoot = join(workspacesRoot(), id, 'sessions')
    if (!(await dirExists(sessionsRoot))) continue
    for (const runId of await listRunIds(sessionsRoot)) {
      const runDir = join(sessionsRoot, runId)
      if (protectedRuns.has(runDir)) continue
      pushCategory('checkpoints', 'Checkpoints', await sweepResolvedUndone(runDir, nowMs))
    }
    // A1 count-cap (needs ack + enabled).
    if (acked && settings.storage.checkpointGcEnabled) {
      pushCategory(
        'checkpoints',
        'Checkpoints',
        await sweepCheckpointCountCap(sessionsRoot, settings, nowMs, protectedRuns)
      )
    }
    // Session retention (manual run = user confirmed).
    pushCategory('sessions', 'Old sessions', await sweepSessions(sessionsRoot, settings, nowMs, protectedRuns))
  }

  // Orphans (confirm token = the explicit user action §6.2 B3 requires).
  const report = await collectStorageReport()
  const orphans = selectOrphanDirs(report.workspaces, settings, nowMs)
  const reaped = await reapOrphanDirs(orphans)
  if (reaped.dirs > 0 || reaped.skipped > 0) {
    pushCategory('orphans', 'Untracked workspace storage', reaped)
  }

  // Size cap enforcement (needs ack).
  if (acked) {
    pushCategory('size-cap', 'Size cap', await enforceSizeCap(settings, protectedRuns, nowMs))
  }

  return { categories, totalReclaimedBytes, removedDirs, skipped }
}

/**
 * Automatic sweep — run end + boot. §8.1 first-run: until the user has seen
 * Settings → Storage (`storageSurfaceAcked`), ONLY the free resolved/undone
 * pass runs; everything else waits for the ack. Size-cap enforcement (a full
 * managed-surface measurement) runs at most once per 6 h, not per run end.
 */
const SIZE_CAP_AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000
let lastSizeCapAutoMs = 0

export async function sweepRetentionAuto(): Promise<void> {
  try {
    const settings = getSettings()
    const nowMs = Date.now()
    const protectedRuns = activeRunDirs()
    const storageIds = await listStorageIds()
    for (const id of storageIds) {
      const sessionsRoot = join(workspacesRoot(), id, 'sessions')
      if (!(await dirExists(sessionsRoot))) continue
      for (const runId of await listRunIds(sessionsRoot)) {
        const runDir = join(sessionsRoot, runId)
        if (protectedRuns.has(runDir)) continue
        // Free pass — always allowed.
        await sweepResolvedUndone(runDir, nowMs)
      }
      if (!settings.storageSurfaceAcked) continue
      if (settings.storage.checkpointGcEnabled) {
        await sweepCheckpointCountCap(sessionsRoot, settings, nowMs, protectedRuns)
      }
      if (settings.storage.sessionRetentionEnabled) {
        await sweepSessions(sessionsRoot, settings, nowMs, protectedRuns)
      }
    }
    if (
      settings.storageSurfaceAcked &&
      nowMs - lastSizeCapAutoMs >= SIZE_CAP_AUTO_INTERVAL_MS
    ) {
      lastSizeCapAutoMs = nowMs
      await enforceSizeCap(settings, protectedRuns, nowMs)
    }
  } catch (err) {
    // Never run-fatal (M3 lesson).
    logger.warn('Automatic retention sweep failed (skipped)', {
      scope: 'storage',
      err
    })
  }
}

/** Measure one workspace's storage dir size for the remove-workspace confirm. */
export async function measureWorkspaceStorageDir(workspacePath: string): Promise<number> {
  try {
    const id = workspaceIdFromPath(canonicalizeWorkspacePath(workspacePath))
    const m = await measureDir(join(workspacesRoot(), id))
    return m.bytes
  } catch {
    return 0
  }
}

/** Delete one workspace's storage dir (prune-on-removal, renderer-confirmed). */
export async function deleteWorkspaceStorageDir(workspacePath: string): Promise<{ ok: boolean; bytes: number }> {
  try {
    const id = workspaceIdFromPath(canonicalizeWorkspacePath(workspacePath))
    const dir = join(workspacesRoot(), id)
    const m = await measureDir(dir)
    await rm(dir, { recursive: true, force: true })
    logger.warn('Deleted workspace storage dir on removal', {
      scope: 'storage',
      code: 'WORKSPACE_STORAGE_PRUNED',
      workspaceId: id,
      bytes: m.bytes
    })
    return { ok: true, bytes: m.bytes }
  } catch (err) {
    logger.warn('Failed to delete workspace storage on removal (skipped)', {
      scope: 'storage',
      code: 'WORKSPACE_STORAGE_PRUNED',
      err
    })
    return { ok: false, bytes: 0 }
  }
}

/* Test hooks */
export function resetPendingCleanupTokenForTests(): void {
  pendingCleanupToken = null
}
