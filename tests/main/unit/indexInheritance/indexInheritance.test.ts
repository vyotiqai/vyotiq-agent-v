import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  codeindexDbPath,
  codeindexRoot,
  setWorkspaceIndexStorageRootOverrideForTests
} from '@main/agent/indexStoragePaths'
import { copyWorkspaceIndexesForInstance } from '@main/agent/indexInheritance'
import { logger } from '@shared/logger'

/**
 * Real sqlite DBs via node:sqlite DatabaseSync — the same module the store
 * uses (codeindex/store.ts, WAL journal mode).
 */

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function seedIndexDb(dbPath: string, marker: string): void {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('marker', marker)
  } finally {
    db.close() // clean close checkpoints + removes the WAL
  }
}

function openReadOnly(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true })
}

describe('copyWorkspaceIndexesForInstance', () => {
  let workspace: string
  let storageRoot: string
  /** Open handles to close before rmSync (Windows file locks). */
  let openDbs: DatabaseSync[]

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-ws-inherit-'))
    storageRoot = mkdtempSync(join(tmpdir(), 'vyotiq-ud-inherit-'))
    setWorkspaceIndexStorageRootOverrideForTests(storageRoot)
    openDbs = []
  })

  afterEach(() => {
    for (const db of openDbs) {
      try {
        db.close()
      } catch {
        /* already closed */
      }
    }
    setWorkspaceIndexStorageRootOverrideForTests(null)
    if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
    if (storageRoot && existsSync(storageRoot)) rmSync(storageRoot, { recursive: true, force: true })
  })

  it('copies the code index DB into the worktree storage', async () => {
    seedIndexDb(codeindexDbPath(workspace), 'code-marker')
    const worktreePath = join(workspace, 'wt')

    await copyWorkspaceIndexesForInstance(workspace, worktreePath)

    const childCode = openReadOnly(codeindexDbPath(worktreePath))
    openDbs.push(childCode)
    expect(childCode.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })
    expect(
      (childCode.prepare('SELECT value FROM meta WHERE key = ?').get('marker') as { value: string })
        .value
    ).toBe('code-marker')

    // Child copies live in the child's own storage id — not the parent's.
    expect(codeindexDbPath(worktreePath)).not.toBe(codeindexDbPath(workspace))
  })

  it('copy includes WAL-committed rows that were never checkpointed', async () => {
    const parentDb = codeindexDbPath(workspace)
    mkdirSync(dirname(parentDb), { recursive: true })
    const db = new DatabaseSync(parentDb)
    openDbs.push(db)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);')
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('marker', 'wal-row')
    // Deliberately left open (no close → no checkpoint): the row lives only
    // in index.sqlite-wal on disk.
    expect(existsSync(parentDb + '-wal')).toBe(true)

    const worktreePath = join(workspace, 'wt')
    await copyWorkspaceIndexesForInstance(workspace, worktreePath)

    const childDb = codeindexDbPath(worktreePath)
    expect(existsSync(childDb + '-wal')).toBe(true)
    const child = openReadOnly(childDb)
    openDbs.push(child)
    expect(
      (child.prepare('SELECT value FROM meta WHERE key = ?').get('marker') as { value: string })
        .value
    ).toBe('wal-row')
  })

  it('missing parent DBs → clean no-op', async () => {
    const worktreePath = join(workspace, 'wt')

    await expect(copyWorkspaceIndexesForInstance(workspace, worktreePath)).resolves.toBeUndefined()

    expect(existsSync(codeindexDbPath(worktreePath))).toBe(false)
  })

  it('oversized parent DB → skipped, child cold-starts', async () => {
    seedIndexDb(codeindexDbPath(workspace), 'big-marker')
    const worktreePath = join(workspace, 'wt')
    const warnSpy = vi.spyOn(logger, 'warn')

    // maxDbBytes: 0 makes the seeded (non-empty) DB exceed the cap without
    // needing a 512MB fixture on disk.
    await expect(
      copyWorkspaceIndexesForInstance(workspace, worktreePath, { maxDbBytes: 0 })
    ).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledWith(
      'indexInheritance: parent index too large to inherit; child cold-starts',
      expect.objectContaining({ scope: 'indexInheritance', index: 'codeindex' })
    )
    expect(existsSync(codeindexDbPath(worktreePath))).toBe(false)
  })

  it('corrupt parent source → non-fatal, no usable copy left behind', async () => {
    const parentDb = codeindexDbPath(workspace)
    mkdirSync(dirname(parentDb), { recursive: true })
    writeFileSync(parentDb, Buffer.from('this is not a sqlite database, at all....'))
    const worktreePath = join(workspace, 'wt')

    await expect(copyWorkspaceIndexesForInstance(workspace, worktreePath)).resolves.toBeUndefined()

    // The torn/corrupt copy must not be left for the child to open.
    expect(existsSync(codeindexDbPath(worktreePath))).toBe(false)
  })

  it('parent DB bytes are unmodified after the run', async () => {
    seedIndexDb(codeindexDbPath(workspace), 'untouched')
    const parentDb = codeindexDbPath(workspace)
    const beforeHash = sha256(parentDb)
    const beforeFiles = readdirSync(codeindexRoot(workspace)).sort()
    const worktreePath = join(workspace, 'wt')

    await copyWorkspaceIndexesForInstance(workspace, worktreePath)

    expect(sha256(parentDb)).toBe(beforeHash)
    expect(readdirSync(codeindexRoot(workspace)).sort()).toEqual(beforeFiles)
  })
})
