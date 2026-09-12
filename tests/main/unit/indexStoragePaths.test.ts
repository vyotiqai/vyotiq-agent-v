import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  codeindexRoot,
  setWorkspaceIndexStorageRootOverrideForTests,
  legacyCodeindexRoot,
  legacySparsegrepRoot,
  removeWorkspaceIndexStorage,
  workspaceIndexStorageDir
} from '@main/agent/indexStoragePaths'
import { CodeIndexStore, closeCodeIndexStore, syncCodeIndex } from '@main/agent/codeindex'
import { removeLegacyWorkspaceIndexDirs } from '@main/agent/workspaceIndex'

describe('index storage outside project tree', () => {
  let workspace: string
  let storageRoot: string

  afterEach(() => {
    if (workspace) {
      closeCodeIndexStore(workspace)
    }
    setWorkspaceIndexStorageRootOverrideForTests(null)
    if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
    if (storageRoot && existsSync(storageRoot)) rmSync(storageRoot, { recursive: true, force: true })
  })

  it('writes the code index under the userData override, not .vyotiq', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-ws-idx-'))
    storageRoot = mkdtempSync(join(tmpdir(), 'vyotiq-ud-idx-'))
    setWorkspaceIndexStorageRootOverrideForTests(storageRoot)
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')

    const codeStore = CodeIndexStore.open(workspace)
    try {
      await syncCodeIndex(workspace, codeStore)
      expect(resolve(codeStore.dbPath).startsWith(resolve(storageRoot))).toBe(true)
      expect(resolve(codeStore.dbPath)).toContain(`${join('codeindex')}`)
      expect(resolve(codeindexRoot(workspace)).startsWith(resolve(storageRoot))).toBe(true)
      expect(resolve(codeindexRoot(workspace)).startsWith(resolve(workspace))).toBe(false)
      expect(existsSync(legacyCodeindexRoot(workspace))).toBe(false)
      expect(existsSync(legacySparsegrepRoot(workspace))).toBe(false)
    } finally {
      codeStore.close()
    }
  })

  it('removeLegacyWorkspaceIndexDirs deletes only old in-repo index folders', () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-legacy-idx-'))
    storageRoot = mkdtempSync(join(tmpdir(), 'vyotiq-ud-legacy-'))
    const legacyCode = legacyCodeindexRoot(workspace)
    const legacySparse = legacySparsegrepRoot(workspace)
    mkdirSync(legacyCode, { recursive: true })
    mkdirSync(legacySparse, { recursive: true })
    mkdirSync(join(workspace, '.vyotiq', 'memory'), { recursive: true })
    writeFileSync(join(workspace, '.vyotiq', 'memory', 'index.md'), '# mem\n', 'utf8')

    removeLegacyWorkspaceIndexDirs(workspace)

    expect(existsSync(legacyCode)).toBe(false)
    expect(existsSync(legacySparse)).toBe(false)
    expect(existsSync(join(workspace, '.vyotiq', 'memory', 'index.md'))).toBe(true)
  })

  it('removeLegacyWorkspaceIndexDirs removes the obsolete userData sparsegrep dir', () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-legacy-idx-'))
    storageRoot = mkdtempSync(join(tmpdir(), 'vyotiq-ud-legacy-'))
    setWorkspaceIndexStorageRootOverrideForTests(storageRoot)
    const obsoleteSparse = join(workspaceIndexStorageDir(workspace), 'sparsegrep')
    mkdirSync(obsoleteSparse, { recursive: true })
    writeFileSync(join(obsoleteSparse, 'index.sqlite'), 'stale', 'utf8')

    removeLegacyWorkspaceIndexDirs(workspace)

    expect(existsSync(obsoleteSparse)).toBe(false)
  })

  it('removeWorkspaceIndexStorage deletes the derived indexes and nothing else', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-wt-idx-'))
    storageRoot = mkdtempSync(join(tmpdir(), 'vyotiq-ud-wt-'))
    setWorkspaceIndexStorageRootOverrideForTests(storageRoot)

    const codeStore = CodeIndexStore.open(workspace)
    codeStore.close()
    expect(existsSync(codeindexRoot(workspace))).toBe(true)

    // Sibling user-ish content under the same id dir must never be touched.
    const sessions = join(workspaceIndexStorageDir(workspace), 'sessions')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, 'keep.txt'), 'keep', 'utf8')

    await removeWorkspaceIndexStorage(workspace)

    expect(existsSync(codeindexRoot(workspace))).toBe(false)
    expect(existsSync(join(sessions, 'keep.txt'))).toBe(true)
  })

  it('removeWorkspaceIndexStorage is an idempotent no-op for a missing dir', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-wt-idx-missing-'))
    storageRoot = mkdtempSync(join(tmpdir(), 'vyotiq-ud-wt-missing-'))
    setWorkspaceIndexStorageRootOverrideForTests(storageRoot)
    await expect(removeWorkspaceIndexStorage(workspace)).resolves.toBeUndefined()
    await expect(removeWorkspaceIndexStorage(workspace)).resolves.toBeUndefined()
  })
})
