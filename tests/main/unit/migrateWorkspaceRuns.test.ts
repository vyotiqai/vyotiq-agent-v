import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userData = join(tmpdir(), `vyotiq-migrate-runs-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    }
  }
}))

import {
  migrateWorkspaceRunsAtPath,
  moveRunDirectory
} from '@main/storage/migrateWorkspaceRuns'
import { readWorkspaceMeta, workspaceSessionsRoot } from '@main/storage/paths'

describe('workspace run migration', () => {
  let workspace = ''

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  })

  it('falls back to verified copy/remove when rename crosses devices', () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-migrate-copy-'))
    const from = join(workspace, 'from')
    const to = join(workspace, 'to')
    mkdirSync(from, { recursive: true })
    writeFileSync(join(from, 'status.json'), '{"status":"done"}', 'utf8')

    moveRunDirectory(from, to, () => {
      const error = new Error('cross-device') as NodeJS.ErrnoException
      error.code = 'EXDEV'
      throw error
    })

    expect(existsSync(from)).toBe(false)
    expect(readFileSync(join(to, 'status.json'), 'utf8')).toContain('done')
  })

  it('does not mark migration complete while a destination collision remains', () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-migrate-collision-'))
    const legacy = join(workspace, '.vyotiq', 'runs', 'run-a')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'status.json'), '{}', 'utf8')
    const destination = join(workspaceSessionsRoot(workspace), 'run-a')
    mkdirSync(destination, { recursive: true })
    writeFileSync(join(destination, 'status.json'), '{}', 'utf8')

    expect(migrateWorkspaceRunsAtPath(workspace)).toBe(0)
    expect(readWorkspaceMeta(workspace)?.runsMigrated).not.toBe(true)
    expect(existsSync(legacy)).toBe(true)
  })

  it('marks migration complete after all eligible runs move', () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-migrate-success-'))
    const legacy = join(workspace, '.vyotiq', 'runs', 'run-a')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'status.json'), '{}', 'utf8')

    expect(migrateWorkspaceRunsAtPath(workspace)).toBe(1)
    expect(readWorkspaceMeta(workspace)?.runsMigrated).toBe(true)
    expect(existsSync(join(workspaceSessionsRoot(workspace), 'run-a', 'status.json'))).toBe(true)
  })

  it('skips symlinked legacy run directories', () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-migrate-symlink-'))
    const real = join(workspace, 'real-run')
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, 'status.json'), '{}', 'utf8')
    const legacy = join(workspace, '.vyotiq', 'runs')
    mkdirSync(legacy, { recursive: true })
    symlinkSync(real, join(legacy, 'run-link'), process.platform === 'win32' ? 'junction' : 'dir')

    expect(migrateWorkspaceRunsAtPath(workspace)).toBe(0)
    expect(existsSync(join(workspaceSessionsRoot(workspace), 'run-link'))).toBe(false)
  })
})
