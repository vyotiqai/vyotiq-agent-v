import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'vyotiq-deleted-test'), getAppPath: () => tmpdir(), isPackaged: false }
}))

import {
  DELETED_RETENTION_MS,
  listDeletedRuns,
  moveRunToDeleted,
  purgeExpiredDeletedRuns,
  restoreDeletedRun
} from '@main/agent/deletedRuns'
import { workspaceSessionsRoot } from '@main/storage/paths'

const WS = 'C:\\vyotiq-deleted-ws'

function makeRun(id: string): string {
  const dir = join(workspaceSessionsRoot(WS), id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ status: 'done', step: 1, updatedAt: '2026-10-01T00:00:00.000Z', goal: id }))
  return dir
}

afterEach(() => rmSync(join(tmpdir(), 'vyotiq-deleted-test'), { recursive: true, force: true }))

describe('Recently deleted', () => {
  it('moves a task and its helpers out of the session list, and restores both', async () => {
    const parent = makeRun('run-p')
    const child = makeRun('run-c')
    await moveRunToDeleted(WS, 'run-p', parent, { goal: 'Fix the swap', instanceDirs: [{ runId: 'run-c', dir: child }] })
    expect(existsSync(parent)).toBe(false)
    expect(existsSync(child)).toBe(false)
    const listed = await listDeletedRuns(WS)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ runId: 'run-p', goal: 'Fix the swap', instances: ['run-c'] })

    await restoreDeletedRun(WS, 'run-p')
    expect(JSON.parse(readFileSync(join(parent, 'status.json'), 'utf8')).goal).toBe('run-p')
    expect(existsSync(join(child, 'status.json'))).toBe(true)
    expect(existsSync(join(parent, '.deleted.json'))).toBe(false)
    expect(await listDeletedRuns(WS)).toHaveLength(0)
  })

  it('refuses to restore over a task that is back already', async () => {
    const dir = makeRun('run-x')
    await moveRunToDeleted(WS, 'run-x', dir)
    makeRun('run-x')
    await expect(restoreDeletedRun(WS, 'run-x')).rejects.toThrow(/already in the workspace/)
  })

  it('removes for good what has been there 30 days', async () => {
    const old = makeRun('run-old')
    const fresh = makeRun('run-new')
    const now = Date.parse('2026-10-08T12:00:00.000Z')
    await moveRunToDeleted(WS, 'run-old', old, { now: new Date(now - DELETED_RETENTION_MS - 1000) })
    await moveRunToDeleted(WS, 'run-new', fresh, { now: new Date(now - 1000) })
    expect(await purgeExpiredDeletedRuns(WS, now)).toBe(1)
    expect((await listDeletedRuns(WS)).map((r) => r.runId)).toEqual(['run-new'])
  })

  it('never takes a run id that leaves its folder', async () => {
    const dir = makeRun('run-y')
    await expect(moveRunToDeleted(WS, '../escape', dir)).rejects.toThrow(/Invalid run id/)
  })
})
