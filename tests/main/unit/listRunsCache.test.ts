import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveRunDir } from '@main/storage/paths'
import {
  invalidateListRunsCache,
  resetListRunsCacheForTests
} from '@main/agent/runListCache'
import { listRuns } from '@main/agent/state'

const userData = join(tmpdir(), `vyotiq-list-cache-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

function writeStatus(
  dir: string,
  status: { status: string; updatedAt: string; goal?: string; workspacePath?: string }
): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'status.json'), JSON.stringify(status, null, 2), 'utf8')
}

describe('listRuns cache', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-list-cache-ws-'))
    mkdirSync(join(userData, 'workspaces'), { recursive: true })
    resetListRunsCacheForTests()
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
    resetListRunsCacheForTests()
  })

  it('reuses cached results within TTL and skips re-reconcile walks', async () => {
    writeStatus(resolveRunDir(workspace, 'run-a'), {
      status: 'done',
      updatedAt: '2026-01-01T00:00:00.000Z',
      goal: 'first',
      workspacePath: workspace
    })

    const first = await listRuns(workspace)
    writeStatus(resolveRunDir(workspace, 'run-b'), {
      status: 'done',
      updatedAt: '2026-01-02T00:00:00.000Z',
      goal: 'second',
      workspacePath: workspace
    })
    const second = await listRuns(workspace)

    expect(first.runs.map((r) => r.runId)).toEqual(['run-a'])
    expect(second.runs.map((r) => r.runId)).toEqual(['run-a'])

    invalidateListRunsCache(workspace)
    const third = await listRuns(workspace)
    expect(third.runs.map((r) => r.runId)).toEqual(['run-b', 'run-a'])
  })
})
