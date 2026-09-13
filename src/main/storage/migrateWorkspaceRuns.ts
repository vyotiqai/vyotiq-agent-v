import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync
} from 'fs'
import { join } from 'path'
import { logger } from '../../shared/logger'
import { canonicalizeWorkspacePath } from '../../shared/workspacePath'
import { readWorkspacesState } from '@main/workspace/workspaces'
import {
  ensureWorkspaceStorage,
  readWorkspaceMeta,
  workspaceId,
  workspaceSessionsRoot,
  writeWorkspaceMeta,
  type WorkspaceMeta
} from './paths'

export type MigrateWorkspaceRunsResult = {
  migrated: number
  workspaces: number
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (!p) continue
    const key = process.platform === 'win32' ? p.toLowerCase() : p
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

function markRunsMigrated(meta: WorkspaceMeta): void {
  writeWorkspaceMeta({
    ...meta,
    runsMigrated: true,
    migratedAt: meta.migratedAt ?? new Date().toISOString()
  })
}

export function moveRunDirectory(
  from: string,
  to: string,
  rename: typeof renameSync = renameSync
): void {
  try {
    rename(from, to)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
  }

  try {
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
    if (!existsSync(join(to, 'status.json'))) {
      throw new Error('Copied run is missing status.json')
    }
    rmSync(from, { recursive: true, force: false })
  } catch (err) {
    try {
      if (existsSync(to)) rmSync(to, { recursive: true, force: true })
    } catch {
      // Preserve the original error; a later migration can inspect/retry.
    }
    throw err
  }
}

export function migrateWorkspaceRunsAtPath(workspacePath: string): number {
  if (!existsSync(workspacePath)) return 0

  const canonical = canonicalizeWorkspacePath(workspacePath)
  ensureWorkspaceStorage(canonical)

  const existingMeta = readWorkspaceMeta(canonical)
  const id = workspaceId(canonical)
  const meta: WorkspaceMeta = existingMeta ?? {
    workspaceId: id,
    canonicalPath: canonical
  }

  if (meta.runsMigrated) return 0

  const legacyRuns = join(workspacePath, '.vyotiq', 'runs')
  if (!existsSync(legacyRuns)) {
    markRunsMigrated(meta)
    return 0
  }

  const sessionsRoot = workspaceSessionsRoot(canonical)
  let migrated = 0
  let hadFailure = false

  for (const runId of readdirSync(legacyRuns)) {
    const from = join(legacyRuns, runId)
    try {
      const st = lstatSync(from)
      if (st.isSymbolicLink() || !st.isDirectory()) continue
      if (!existsSync(join(from, 'status.json'))) continue
      const to = join(sessionsRoot, runId)
      if (existsSync(to)) {
        hadFailure = true
        logger.warn('Skipping workspace runs migration — destination exists', {
          scope: 'migrateWorkspaceRuns',
          workspaceId: id,
          runId
        })
        continue
      }
      moveRunDirectory(from, to)
      migrated += 1
    } catch (err) {
      hadFailure = true
      logger.warn('Failed to migrate workspace run', {
        scope: 'migrateWorkspaceRuns',
        workspaceId: id,
        runId,
        err
      })
    }
  }

  try {
    if (existsSync(legacyRuns) && readdirSync(legacyRuns).length === 0) {
      rmSync(legacyRuns, { recursive: true, force: true })
    }
  } catch {
    // best effort
  }

  if (!hadFailure) markRunsMigrated(meta)
  return migrated
}

/** One-time migration: `{workspace}/.vyotiq/runs/` → AppData sessions. */
export function migrateWorkspaceRuns(): MigrateWorkspaceRunsResult {
  const state = readWorkspacesState()
  const paths = dedupePaths([...state.openPaths, ...state.recentPaths])
  let migrated = 0
  let workspaces = 0

  for (const workspacePath of paths) {
    const count = migrateWorkspaceRunsAtPath(workspacePath)
    if (count > 0) workspaces += 1
    migrated += count
  }

  if (migrated > 0) {
    logger.info(`Migrated ${migrated} workspace run(s) to AppData`, {
      scope: 'migrateWorkspaceRuns',
      migrated,
      workspaces
    })
  }

  return { migrated, workspaces }
}
