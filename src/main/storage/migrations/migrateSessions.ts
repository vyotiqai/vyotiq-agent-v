import { app } from 'electron'
import {
  existsSync,
  lstatSync,
  readdirSync,
  renameSync,
  readFileSync
} from 'fs'
import { join } from 'path'
import { RunStatusSchema } from '../../../shared/ipc'
import { logger } from '../../../shared/logger'
import { workspaceIdFromPath } from '../../../shared/workspaceId'
import { atomicWriteJson } from '../atomicWrite'
import { ensureWorkspaceStorage, workspaceSessionsRoot } from '../paths'
import { readLegacyWorkspacePath } from '@main/settings/settings'
import { patchWorkspacesState, readWorkspacesState } from '../../workspace/workspaces'

export type MigrateSessionsResult = {
  migrated: number
  needsWorkspaceForMigration: boolean
  pendingMigrationCount: number
}

function sessionsRoot(): string {
  return join(app.getPath('userData'), 'sessions')
}

function listSessionRunIds(): string[] {
  const root = sessionsRoot()
  if (!existsSync(root)) return []
  const ids: string[] = []
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    try {
      const st = lstatSync(dir)
      if (st.isSymbolicLink() || !st.isDirectory()) continue
      if (!existsSync(join(dir, 'status.json'))) continue
      ids.push(name)
    } catch (err) {
      logger.warn('Legacy session listing skipped entry', {
        scope: 'migrateSessions',
        runId: name,
        err
      })
    }
  }
  return ids
}

function resolveMigrationTarget(): string | null {
  const legacy = readLegacyWorkspacePath()
  if (legacy && existsSync(legacy)) return legacy
  const state = readWorkspacesState()
  if (state.openPaths[0] && existsSync(state.openPaths[0])) return state.openPaths[0]
  return null
}

function patchRunWorkspacePath(runDir: string, workspacePath: string): void {
  const statusPath = join(runDir, 'status.json')
  if (!existsSync(statusPath)) return
  try {
    const raw = JSON.parse(readFileSync(statusPath, 'utf8')) as unknown
    const parsed = RunStatusSchema.safeParse(raw)
    if (!parsed.success) return
    const next = { ...parsed.data, workspacePath }
    atomicWriteJson(statusPath, next)
  } catch (err) {
    logger.warn('Legacy session status patch skipped', {
      scope: 'migrateSessions',
      runDir,
      err
    })
  }
}

export function migrateLegacySessions(): MigrateSessionsResult {
  const state = readWorkspacesState()
  if (state.legacySessionsMigrated) {
    return {
      migrated: 0,
      needsWorkspaceForMigration: Boolean(state.needsWorkspaceForMigration),
      pendingMigrationCount: state.pendingMigrationCount ?? 0
    }
  }

  const sessionIds = listSessionRunIds()
  if (sessionIds.length === 0) {
    patchWorkspacesState({
      legacySessionsMigrated: true,
      needsWorkspaceForMigration: false,
      pendingMigrationCount: 0
    })
    return { migrated: 0, needsWorkspaceForMigration: false, pendingMigrationCount: 0 }
  }

  const target = resolveMigrationTarget()
  if (!target) {
    patchWorkspacesState({
      needsWorkspaceForMigration: true,
      pendingMigrationCount: sessionIds.length
    })
    logger.warn('Legacy sessions need a workspace for migration', {
      scope: 'migrateSessions',
      count: sessionIds.length
    })
    return {
      migrated: 0,
      needsWorkspaceForMigration: true,
      pendingMigrationCount: sessionIds.length
    }
  }

  ensureWorkspaceStorage(target)
  const runsRoot = workspaceSessionsRoot(target)
  let migrated = 0

  for (const runId of sessionIds) {
    const from = join(sessionsRoot(), runId)
    const to = join(runsRoot, runId)
    try {
      const fromSt = lstatSync(from)
      if (fromSt.isSymbolicLink() || !fromSt.isDirectory()) continue
      if (existsSync(to)) {
        logger.warn('Skipping session migration — destination exists', {
          scope: 'migrateSessions',
          runId
        })
        continue
      }
      renameSync(from, to)
      patchRunWorkspacePath(to, target)
      migrated += 1
    } catch (err) {
      logger.warn('Failed to migrate session run', {
        scope: 'migrateSessions',
        runId,
        err
      })
    }
  }

  const remaining = listSessionRunIds()
  const fullyMigrated = remaining.length === 0

  patchWorkspacesState({
    legacySessionsMigrated: fullyMigrated,
    needsWorkspaceForMigration: false,
    pendingMigrationCount: fullyMigrated ? 0 : remaining.length,
    ...(migrated > 0
      ? {
          openPaths: state.openPaths.includes(target)
            ? state.openPaths
            : [...state.openPaths, target],
          activePath: state.activePath ?? target,
          recentPaths: state.recentPaths.includes(target)
            ? state.recentPaths
            : [target, ...state.recentPaths]
        }
      : {})
  })

  if (migrated > 0) {
    logger.info(`Migrated ${migrated} legacy session(s) to workspace`, {
      scope: 'migrateSessions',
      workspaceId: workspaceIdFromPath(target),
      migrated
    })
  }

  if (!fullyMigrated) {
    logger.warn('Legacy session migration incomplete', {
      scope: 'migrateSessions',
      remaining: remaining.length
    })
  }

  return {
    migrated,
    needsWorkspaceForMigration: false,
    pendingMigrationCount: fullyMigrated ? 0 : remaining.length
  }
}
