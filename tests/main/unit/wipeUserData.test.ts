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

/**
 * Audit 2026-10-02: two byte-identical copies of the live secrets store survived in
 * the user-data tree — `pre-remove-backup-20260929/secrets.json` and
 * `marketplace/20260929-pre-remove-backup/secrets.json`, each SHA-256 equal to
 * `secrets.json`. `grep "pre-remove"` over the whole repo returns nothing, so no code
 * in src/ or scripts/ writes those folders; they are pinned here by shape, not by author.
 *
 * Fake ciphertext: the fixtures never carry a real encrypted secret.
 */
function seedSecretsCopies(dir: string): { root: string; marketplace: string } {
  const root = join(dir, 'pre-remove-backup-20260929')
  const marketplace = join(dir, 'marketplace', '20260929-pre-remove-backup')
  for (const backup of [root, marketplace]) {
    mkdirSync(backup, { recursive: true })
    writeFileSync(join(backup, 'index.json'), '{"schemaVersion":1,"items":[]}')
    writeFileSync(join(backup, 'secrets.json'), '{"fake-provider":"ZmFrZS1jaXBoZXJ0ZXh0"}')
  }
  writeFileSync(join(dir, 'marketplace', 'index.json'), '{"schemaVersion":1,"items":[]}')
  // Same family, not a backup: no date stamp, so not the shape the audit found.
  mkdirSync(join(dir, 'pre-remove-backup'), { recursive: true })
  writeFileSync(join(dir, 'pre-remove-backup', 'secrets.json'), '{"fake-provider":"ZmFrZS1jaXBoZXJ0ZXh0"}')
  return { root, marketplace }
}

function copyPaths(dir: string): string[] {
  return [
    join(dir, 'secrets.json'),
    join(dir, 'pre-remove-backup-20260929', 'secrets.json'),
    join(dir, 'marketplace', '20260929-pre-remove-backup', 'secrets.json')
  ]
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

  it('removes every copy of the secrets store the wipe leaves behind', () => {
    const dir = fresh('vy-wipe-secrets-')
    seedUserData(dir)
    const seeded = seedSecretsCopies(dir)
    requestDataWipe(dir, { pid: 999_999_999 })

    const report = performPendingWipe(dir, { waitMs: 0 })!
    expect(report.failed).toEqual([])
    for (const p of copyPaths(dir)) expect(existsSync(p)).toBe(false)
    expect(existsSync(seeded.root)).toBe(false)
    expect(existsSync(seeded.marketplace)).toBe(false)
  })

  it('a retry pass removes the backup copies it names, and nothing else', () => {
    const dir = fresh('vy-wipe-secrets-retry-')
    seedUserData(dir)
    seedSecretsCopies(dir)
    // A first pass that could not remove these two top-level folders leaves the
    // retry marker naming only them.
    writeFileSync(
      join(dir, WIPE_MARKER),
      JSON.stringify({
        pid: 0,
        requestedAt: '',
        repos: [],
        only: ['pre-remove-backup-20260929', 'marketplace']
      })
    )
    expect(performPendingWipe(dir, { waitMs: 0 })!.failed).toEqual([])
    // Both copies go with the folders they were in…
    expect(existsSync(join(dir, 'pre-remove-backup-20260929', 'secrets.json'))).toBe(false)
    expect(existsSync(join(dir, 'marketplace', '20260929-pre-remove-backup', 'secrets.json'))).toBe(false)
    // …while what the retry was not asked for stays, live secrets store included:
    // the retry contract is that it never deletes what was made after the wipe.
    expect(existsSync(join(dir, 'secrets.json'))).toBe(true)
    expect(existsSync(join(dir, 'settings.json'))).toBe(true)
    expect(existsSync(join(dir, 'workspaces'))).toBe(true)
    // A folder with the same name family but no date stamp is not swept up either:
    // nothing here matches on a name, so a pass deletes exactly what it was given.
    expect(existsSync(join(dir, 'pre-remove-backup', 'secrets.json'))).toBe(true)
  })

  it('empties the folder by recursion, not by backup-name matching, and never reaches outside it', () => {
    const dir = fresh('vy-wipe-boundary-')
    const outside = fresh('vy-wipe-outside-')
    writeFileSync(join(outside, 'my-notes.md'), 'hello')
    seedUserData(dir)
    seedSecretsCopies(dir)
    // Folders that resemble the audited backups but carry no date stamp, plus a
    // user's own export sitting in the data folder. A whole-folder wipe is
    // name-agnostic: anything inside the data folder goes, so no rule here has to
    // guess which names mean "backup" — see the boundary note in wipeUserData.ts.
    mkdirSync(join(dir, 'pre-remove-backup-notes'), { recursive: true })
    writeFileSync(join(dir, 'pre-remove-backup-notes', 'my-export.json'), '[]')
    requestDataWipe(dir, { pid: 999_999_999 })

    expect(performPendingWipe(dir, { waitMs: 0 })!.failed).toEqual([])
    for (const p of copyPaths(dir)) expect(existsSync(p)).toBe(false)
    expect(existsSync(join(dir, 'pre-remove-backup', 'secrets.json'))).toBe(false)
    expect(existsSync(join(dir, 'pre-remove-backup-notes', 'my-export.json'))).toBe(false)
    // The sibling lives in the same parent directory and is untouched.
    expect(existsSync(join(outside, 'my-notes.md'))).toBe(true)
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
