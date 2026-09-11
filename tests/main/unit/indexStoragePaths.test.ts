import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  codeindexRoot,
  sparsegrepRoot,
  setWorkspaceIndexStorageRootOverrideForTests,
  legacyCodeindexRoot,
  legacySparsegrepRoot,
  removeWorkspaceIndexStorage,
  workspaceIndexStorageDir
} from '@main/agent/indexStoragePaths'
import { CodeIndexStore, closeCodeIndex, syncCodeIndex, createLocalHashEmbedder } from '@main/agent/codeindex'
import { SparseGrepStore, closeSparseGrep, syncSparseGrep } from '@main/agent/sparsegrep'
import { removeLegacyWorkspaceIndexDirs } from '@main/agent/workspaceIndex'

describe('index storage outside project tree', () => {
  let workspace: string
  let storageRoot: string

  afterEach(() => {
    if (workspace) {
      closeCodeIndex(workspace)
      closeSparseGrep(workspace)
    }
    setWorkspaceIndexStorageRootOverrideForTests(null)
    if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
    if (storageRoot && existsSync(storageRoot)) rmSync(storageRoot, { recursive: true, force: true })
  })

  it('writes codeindex + sparsegrep under userData override, not .vyotiq', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-ws-idx-'))
    storageRoot = mkdtempSync(join(tmpdir(), 'vyotiq-ud-idx-'))
    setWorkspaceIndexStorageRootOverrideForTests(storageRoot)
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')

    const embedder = createLocalHashEmbedder()
    const codeStore = CodeIndexStore.open(workspace, embedder.dimensions)
    try {
      await syncCodeIndex(workspace, codeStore, embedder)
      expect(resolve(codeStore.dbPath).startsWith(resolve(storageRoot))).toBe(true)
      expect(resolve(codeStore.dbPath)).toContain(`${join('codeindex')}`)
      expect(resolve(codeindexRoot(workspace)).startsWith(resolve(storageRoot))).toBe(true)
      expect(resolve(codeindexRoot(workspace)).startsWith(resolve(workspace))).toBe(false)
      expect(existsSync(legacyCodeindexRoot(workspace))).toBe(false)
    } finally {
      codeStore.close()
    }

    const sparse = SparseGrepStore.open(workspace)
    try {
      await syncSparseGrep(workspace, sparse)
      expect(sparse.dbPath.startsWith(resolve(storageRoot))).toBe(true)
      expect(resolve(sparsegrepRoot(workspace)).startsWith(resolve(workspace))).toBe(false)
      expect(existsSync(legacySparsegrepRoot(workspace))).toBe(false)
    } finally {
      sparse.close()
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

  it('removeWorkspaceIndexStorage deletes the derived indexes and nothing else', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-wt-idx-'))
    storageRoot = mkdtempSync(join(tmpdir(), 'vyotiq-ud-wt-'))
    setWorkspaceIndexStorageRootOverrideForTests(storageRoot)

    const codeStore = CodeIndexStore.open(workspace, 8)
    codeStore.close()
    const sparse = SparseGrepStore.open(workspace)
    sparse.close()
    expect(existsSync(codeindexRoot(workspace))).toBe(true)
    expect(existsSync(sparsegrepRoot(workspace))).toBe(true)

    // Sibling user-ish content under the same id dir must never be touched.
    const sessions = join(workspaceIndexStorageDir(workspace), 'sessions')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, 'keep.txt'), 'keep', 'utf8')

    await removeWorkspaceIndexStorage(workspace)

    expect(existsSync(codeindexRoot(workspace))).toBe(false)
    expect(existsSync(sparsegrepRoot(workspace))).toBe(false)
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
