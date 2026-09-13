import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildWorkspaceSnapshot,
  buildWorkspaceSnapshotAsync,
  clearWorkspaceSnapshotCache
} from '@main/agent/context/workspaceSnapshot'

describe('buildWorkspaceSnapshotAsync', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-snap-async-'))
    clearWorkspaceSnapshotCache()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    clearWorkspaceSnapshotCache()
  })

  it('matches sync snapshot output for non-git workspaces', async () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"demo"}', 'utf8')
    writeFileSync(join(dir, 'alpha.ts'), 'export const a = 1\n', 'utf8')

    const sync = buildWorkspaceSnapshot(dir, 'goal')
    clearWorkspaceSnapshotCache()
    const asyncSnap = await buildWorkspaceSnapshotAsync(dir, 'goal')

    expect(asyncSnap).toBe(sync)
    expect(asyncSnap).toContain('alpha.ts')
  })
})
