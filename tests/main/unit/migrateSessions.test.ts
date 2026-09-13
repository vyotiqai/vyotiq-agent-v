import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userData = join(tmpdir(), `vyotiq-migrate-sessions-${process.pid}-${Date.now()}`)

const legacyWorkspace = vi.hoisted(() => ({ value: null as string | null }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    }
  }
}))

vi.mock('@main/settings/settings', () => ({
  readLegacyWorkspacePath: () => legacyWorkspace.value,
  clearSettingsCacheForTests: () => undefined
}))

import { migrateLegacySessions } from '@main/storage/migrations/migrateSessions'
import { readWorkspacesState, resetWorkspacesForTests } from '@main/workspace/workspaces'
import { workspaceSessionsRoot } from '@main/storage/paths'

const VALID_STATUS = { status: 'done', step: 2, updatedAt: '2026-01-01T00:00:00.000Z' }

function seedWorkspacesJson(fields: Record<string, unknown>): void {
  mkdirSync(userData, { recursive: true })
  writeFileSync(
    join(userData, 'workspaces.json'),
    JSON.stringify({
      version: 2,
      workspaceIdsByPath: {},
      legacySessionsMigrated: false,
      openPaths: [],
      activePath: null,
      recentPaths: [],
      uiStateByPath: {},
      settingsOverridesByPath: {},
      ...fields
    }),
    'utf8'
  )
}

function seedLegacySession(runId: string, status?: unknown): string {
  const dir = join(userData, 'sessions', runId)
  mkdirSync(dir, { recursive: true })
  if (status !== undefined) {
    writeFileSync(join(dir, 'status.json'), JSON.stringify(status), 'utf8')
  }
  return dir
}

describe('migrateLegacySessions', () => {
  const workspaces: string[] = []

  beforeEach(() => {
    legacyWorkspace.value = null
    resetWorkspacesForTests()
  })

  afterEach(() => {
    resetWorkspacesForTests()
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    for (const ws of workspaces.splice(0)) {
      if (existsSync(ws)) rmSync(ws, { recursive: true, force: true })
    }
  })

  function makeWorkspace(): string {
    const ws = mkdtempSync(join(tmpdir(), 'vyotiq-migrate-ws-'))
    workspaces.push(ws)
    return ws
  }

  it('moves legacy sessions into the open workspace and patches status.json workspacePath', () => {
    const ws = makeWorkspace()
    seedWorkspacesJson({ openPaths: [ws], activePath: ws, recentPaths: [ws] })
    seedLegacySession('run-a', VALID_STATUS)
    writeFileSync(join(userData, 'sessions', 'run-a', 'events.jsonl'), '{}\n', 'utf8')
    // Ineligible entries: a run dir without status.json and a stray file.
    seedLegacySession('run-b')
    writeFileSync(join(userData, 'sessions', 'notes.txt'), 'x', 'utf8')

    const result = migrateLegacySessions()

    expect(result).toEqual({ migrated: 1, needsWorkspaceForMigration: false, pendingMigrationCount: 0 })

    const dest = join(workspaceSessionsRoot(ws), 'run-a')
    expect(existsSync(join(dest, 'events.jsonl'))).toBe(true)
    const patched = JSON.parse(readFileSync(join(dest, 'status.json'), 'utf8')) as {
      workspacePath?: string
      status?: string
      step?: number
    }
    expect(patched.workspacePath).toBe(ws)
    expect(patched.status).toBe('done')
    expect(patched.step).toBe(2)

    expect(existsSync(join(userData, 'sessions', 'run-a'))).toBe(false)
    expect(existsSync(join(userData, 'sessions', 'run-b'))).toBe(true)

    const state = readWorkspacesState()
    expect(state.legacySessionsMigrated).toBe(true)
    expect(state.needsWorkspaceForMigration).toBe(false)
    expect(state.pendingMigrationCount).toBe(0)
    expect(state.openPaths).toContain(ws)
  })

  it('targets the legacy settings workspacePath when no workspaces.json exists', () => {
    const ws = makeWorkspace()
    legacyWorkspace.value = ws
    seedLegacySession('run-a', VALID_STATUS)

    const result = migrateLegacySessions()

    expect(result.migrated).toBe(1)
    const dest = join(workspaceSessionsRoot(ws), 'run-a', 'status.json')
    expect(existsSync(dest)).toBe(true)
    const patched = JSON.parse(readFileSync(dest, 'utf8')) as { workspacePath?: string }
    expect(patched.workspacePath).toBe(ws)
    expect(readWorkspacesState().legacySessionsMigrated).toBe(true)
  })

  it('falls back to the home workspace when openPaths are missing on disk', () => {
    seedWorkspacesJson({ openPaths: [join(userData, 'no-such-workspace')] })
    seedLegacySession('run-a', VALID_STATUS)
    seedLegacySession('run-b', VALID_STATUS)

    const result = migrateLegacySessions()

    expect(result.migrated).toBe(2)
    expect(result.needsWorkspaceForMigration).toBe(false)
    expect(result.pendingMigrationCount).toBe(0)
    expect(existsSync(join(userData, 'sessions', 'run-a'))).toBe(false)
    expect(existsSync(join(userData, 'sessions', 'run-b'))).toBe(false)

    const state = readWorkspacesState()
    expect(state.openPaths).toHaveLength(1)
    expect(existsSync(state.openPaths[0]!)).toBe(true)
    expect(existsSync(join(workspaceSessionsRoot(state.openPaths[0]!), 'run-a', 'status.json'))).toBe(
      true
    )
    expect(existsSync(join(workspaceSessionsRoot(state.openPaths[0]!), 'run-b', 'status.json'))).toBe(
      true
    )
    expect(state.legacySessionsMigrated).toBe(true)
    expect(state.needsWorkspaceForMigration).toBe(false)
  })

  it('marks migration complete when there are no legacy sessions', () => {
    const ws = makeWorkspace()
    seedWorkspacesJson({ openPaths: [ws], activePath: ws, recentPaths: [ws] })

    const result = migrateLegacySessions()

    expect(result).toEqual({ migrated: 0, needsWorkspaceForMigration: false, pendingMigrationCount: 0 })
    expect(readWorkspacesState().legacySessionsMigrated).toBe(true)
  })

  it('skips destination collisions and reports them as pending', () => {
    const ws = makeWorkspace()
    seedWorkspacesJson({ openPaths: [ws], activePath: ws, recentPaths: [ws] })
    seedLegacySession('run-a', VALID_STATUS)

    const collision = join(workspaceSessionsRoot(ws), 'run-a')
    mkdirSync(collision, { recursive: true })
    writeFileSync(join(collision, 'status.json'), '{"status":"running","updatedAt":"2026-02-02T00:00:00.000Z"}', 'utf8')

    const result = migrateLegacySessions()

    expect(result).toEqual({ migrated: 0, needsWorkspaceForMigration: false, pendingMigrationCount: 1 })
    expect(existsSync(join(userData, 'sessions', 'run-a'))).toBe(true)
    // The pre-existing destination is left untouched (no workspacePath patch).
    const destStatus = readFileSync(join(collision, 'status.json'), 'utf8')
    expect(destStatus).not.toContain('workspacePath')

    const state = readWorkspacesState()
    expect(state.legacySessionsMigrated).toBe(false)
    expect(state.pendingMigrationCount).toBe(1)
  })

  it('moves runs whose status.json fails schema validation without patching them', () => {
    const ws = makeWorkspace()
    seedWorkspacesJson({ openPaths: [ws], activePath: ws, recentPaths: [ws] })
    seedLegacySession('run-a', { bogus: true })

    const result = migrateLegacySessions()

    expect(result.migrated).toBe(1)
    const dest = join(workspaceSessionsRoot(ws), 'run-a', 'status.json')
    expect(readFileSync(dest, 'utf8')).toBe('{"bogus":true}')
  })

  it('is a no-op once legacySessionsMigrated is set', () => {
    const ws = makeWorkspace()
    seedWorkspacesJson({
      legacySessionsMigrated: true,
      needsWorkspaceForMigration: true,
      pendingMigrationCount: 3,
      openPaths: [ws],
      activePath: ws,
      recentPaths: [ws]
    })
    seedLegacySession('run-a', VALID_STATUS)

    const result = migrateLegacySessions()

    expect(result).toEqual({ migrated: 0, needsWorkspaceForMigration: true, pendingMigrationCount: 3 })
    expect(existsSync(join(userData, 'sessions', 'run-a'))).toBe(true)
    expect(existsSync(join(workspaceSessionsRoot(ws), 'run-a'))).toBe(false)
  })

  it('skips symlinked legacy session directories', () => {
    const ws = makeWorkspace()
    seedWorkspacesJson({
      openPaths: [ws],
      activePath: ws,
      recentPaths: [ws]
    })
    const real = mkdtempSync(join(tmpdir(), 'vyotiq-sess-real-'))
    workspaces.push(real)
    writeFileSync(join(real, 'status.json'), JSON.stringify(VALID_STATUS), 'utf8')
    mkdirSync(join(userData, 'sessions'), { recursive: true })
    symlinkSync(
      real,
      join(userData, 'sessions', 'run-link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    const result = migrateLegacySessions()
    expect(result.migrated).toBe(0)
    expect(existsSync(join(workspaceSessionsRoot(ws), 'run-link'))).toBe(false)
  })
})
