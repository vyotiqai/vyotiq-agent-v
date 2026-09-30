import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { performPendingWipe, readWipeRequest, requestDataWipe, WIPE_MARKER, wipePending } from '@main/storage/wipeUserData'

const dirs: string[] = []
function fresh(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function seedUserData(dir: string): void {
  writeFileSync(join(dir, 'settings.json'), '{}')
  writeFileSync(join(dir, 'secrets.json'), '{"openai":"enc"}')
  mkdirSync(join(dir, 'workspaces', 'abc', 'sessions', 'run1'), { recursive: true })
  writeFileSync(join(dir, 'workspaces', 'abc', 'sessions', 'run1', 'messages.jsonl'), '{}\n')
  mkdirSync(join(dir, 'Partitions', 'vyotiq-agent-browser'), { recursive: true })
  writeFileSync(join(dir, 'lockfile'), '')
  writeFileSync(join(dir, 'SingletonLock'), '')
}

describe('delete all my data', () => {
  it('does nothing without a pending request', () => {
    const dir = fresh('vy-wipe-none-')
    seedUserData(dir)
    expect(performPendingWipe(dir)).toBeNull()
    expect(existsSync(join(dir, 'settings.json'))).toBe(true)
  })

  it('empties the data folder except the instance lock, and clears the request', () => {
    const dir = fresh('vy-wipe-')
    seedUserData(dir)
    requestDataWipe(dir, { pid: 999_999_999, repos: ['/work/repo', '/work/repo'] })
    expect(wipePending(dir)).toBe(true)
    expect(readWipeRequest(dir)?.repos).toEqual(['/work/repo'])

    const report = performPendingWipe(dir, { waitMs: 0 })!
    expect(report.failed).toEqual([])
    expect(report.repos).toEqual(['/work/repo'])
    expect(readdirSync(dir).sort()).toEqual(['SingletonLock', 'lockfile'])
    expect(wipePending(dir)).toBe(false)
  })

  it('deletes nothing and keeps the request while another instance holds the app lock', () => {
    const dir = fresh('vy-wipe-locked-')
    seedUserData(dir)
    requestDataWipe(dir, { pid: 999_999_999 })
    const report = performPendingWipe(dir, { waitMs: 0, beforeDelete: () => false })!
    expect(report.skipped).toBe('locked')
    expect(existsSync(join(dir, 'settings.json'))).toBe(true)
    expect(wipePending(dir)).toBe(true)
  })

  it('a retry deletes only what the first pass could not, never data made since', () => {
    const dir = fresh('vy-wipe-retry-')
    seedUserData(dir)
    writeFileSync(join(dir, WIPE_MARKER), JSON.stringify({ pid: 0, requestedAt: '', repos: [], only: ['Partitions'] }))
    const report = performPendingWipe(dir, { waitMs: 0 })!
    expect(report).toMatchObject({ deleted: 1, failed: [] })
    expect(existsSync(join(dir, 'Partitions'))).toBe(false)
    expect(existsSync(join(dir, 'settings.json'))).toBe(true)
    expect(existsSync(join(dir, 'workspaces'))).toBe(true)
    expect(wipePending(dir)).toBe(false)
  })

  it('an unreadable request still wipes: only the confirm ever writes it', () => {
    const dir = fresh('vy-wipe-garbled-')
    seedUserData(dir)
    writeFileSync(join(dir, WIPE_MARKER), '{not json')
    expect(performPendingWipe(dir, { waitMs: 0 })!.failed).toEqual([])
    expect(readdirSync(dir).sort()).toEqual(['SingletonLock', 'lockfile'])
  })

  it('waits for the process that asked for it to exit before deleting', async () => {
    const dir = fresh('vy-wipe-wait-')
    seedUserData(dir)
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1200)'], { stdio: 'ignore' })
    await new Promise((r) => child.once('spawn', r))
    requestDataWipe(dir, { pid: child.pid! })
    const report = performPendingWipe(dir, { waitMs: 10_000 })!
    expect(report.waitedMs).toBeGreaterThanOrEqual(800)
    expect(existsSync(join(dir, 'settings.json'))).toBe(false)
    expect(existsSync(join(dir, WIPE_MARKER))).toBe(false)
  }, 20_000)
})
