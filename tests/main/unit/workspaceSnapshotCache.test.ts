import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildWorkspaceSnapshot,
  clearWorkspaceSnapshotCache
} from '@main/agent/context/workspaceSnapshot'

describe('workspace snapshot cache', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-snap-cache-'))
    clearWorkspaceSnapshotCache()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    clearWorkspaceSnapshotCache()
  })

  it('reuses cached listing when workspace fingerprint is unchanged', () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"demo"}', 'utf8')
    writeFileSync(join(dir, 'alpha.ts'), 'export const a = 1\n', 'utf8')

    const first = buildWorkspaceSnapshot(dir, 'goal-a')
    const second = buildWorkspaceSnapshot(dir, 'goal-b')

    expect(second).toContain('goal-b')
    expect(second).toContain('alpha.ts')
    expect(first.replace('goal-a', 'goal-b')).toBe(second)
  })

  it('invalidates cache when workspace contents change', () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"v1"}', 'utf8')
    const first = buildWorkspaceSnapshot(dir, 'goal')
    expect(first).toContain('package.json')
    expect(first).not.toContain('pyproject.toml')

    writeFileSync(join(dir, 'pyproject.toml'), '[tool.poetry]\n', 'utf8')
    const second = buildWorkspaceSnapshot(dir, 'goal')
    expect(second).toContain('pyproject.toml')
  })
})
