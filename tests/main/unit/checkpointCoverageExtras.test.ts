import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  beginWriteCheckpoint,
  finalizeWriteCheckpoint,
  resetWriteCheckpointsForTests,
  resolveWrites
} from '@main/agent/checkpoints'
import { extractTerminalWritePaths, needsOpaqueWatch, recordTerminalCommandPriors } from '@main/agent/tools/terminalCheckpoint'
import { recordMcpFilesystemPriors, applyMcpFilesystemMutations, mcpFilesystemWriteToolsForTests } from '@main/agent/tools/mcpCheckpoint'
import {
  applyWatchDiffToCheckpoint,
  diffSince,
  disposeWatch,
  startWatch
} from '@main/agent/workspaceMutationWatch'

describe('terminalCheckpoint path parser', () => {
  it('extracts redirection and common mutator paths', () => {
    expect(extractTerminalWritePaths('echo hello > out.txt')).toContain('out.txt')
    expect(extractTerminalWritePaths('echo hi >> "logs/a.txt"')).toContain('logs/a.txt')
    expect(extractTerminalWritePaths('cp src/a.ts dest/b.ts')).toEqual(
      expect.arrayContaining(['src/a.ts', 'dest/b.ts'])
    )
    expect(extractTerminalWritePaths('rm -rf build/tmp')).toContain('build/tmp')
    expect(extractTerminalWritePaths('git restore -- src/x.ts')).toContain('src/x.ts')
    expect(extractTerminalWritePaths('git restore src/x.ts')).toContain('src/x.ts')
    expect(extractTerminalWritePaths('git checkout src/x.ts src/y.ts')).toEqual(
      expect.arrayContaining(['src/x.ts', 'src/y.ts'])
    )
    expect(extractTerminalWritePaths('echo hi > /dev/null')).not.toContain('/dev/null')
    expect(extractTerminalWritePaths('rm -rf dist/*')).toEqual([])
    expect(extractTerminalWritePaths(`Set-Content -Path 'out.ps1' -Value 'x'`)).toContain('out.ps1')
    expect(extractTerminalWritePaths('echo hi | tee log.txt')).toContain('log.txt')
  })

  it('filters non-file tokens from mutator parsing', () => {
    expect(extractTerminalWritePaths('mkdir src/config,src/llm,test')).toEqual([])
    expect(extractTerminalWritePaths('dir')).toEqual([])
    expect(extractTerminalWritePaths('echo hello > Directory')).toEqual([])
    expect(extractTerminalWritePaths('mkdir src/stores;')).toEqual(['src/stores'])
    expect(extractTerminalWritePaths('mkdir src/stores;')).not.toContain('src/stores;')
  })

  it('needs opaque watch only for package managers and build runners', () => {
    expect(needsOpaqueWatch('node scripts/build.js')).toBe(false)
    expect(needsOpaqueWatch('python -c "print(1)"')).toBe(false)
    expect(needsOpaqueWatch('dir')).toBe(false)
    expect(needsOpaqueWatch('pnpm test')).toBe(true)
    expect(needsOpaqueWatch('pip install requests')).toBe(true)
    expect(needsOpaqueWatch('echo hello > out.txt')).toBe(false)
    expect(needsOpaqueWatch('cp src/a.ts dest/b.ts')).toBe(false)
  })

  it('records priors into the active checkpoint', async () => {
    resetWriteCheckpointsForTests()
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-term-cp-'))
    const runDir = mkdtempSync(join(tmpdir(), 'vyotiq-term-run-'))
    try {
      writeFileSync(join(workspace, 'a.txt'), 'old\n', 'utf8')
      beginWriteCheckpoint(runDir, workspace)
      await recordTerminalCommandPriors(workspace, 'echo new > a.txt', { runDir })
      writeFileSync(join(workspace, 'a.txt'), 'new\n', 'utf8')
      const meta = finalizeWriteCheckpoint(runDir)
      expect(meta!.files).toEqual([
        expect.objectContaining({ path: 'a.txt', action: 'modified', undoable: true })
      ])
      resolveWrites(runDir, workspace, { checkpointId: meta!.id, action: 'discard' })
      expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('old\n')
    } finally {
      resetWriteCheckpointsForTests()
      rmSync(workspace, { recursive: true, force: true })
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})

describe('mcpCheckpoint known paths', () => {
  it('lists filesystem write tools', () => {
    expect(mcpFilesystemWriteToolsForTests()).toEqual(
      expect.arrayContaining(['write_file', 'edit_file', 'create_directory', 'move_file'])
    )
  })

  it('records write_file path before mutation', async () => {
    resetWriteCheckpointsForTests()
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-cp-'))
    const runDir = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-run-'))
    try {
      writeFileSync(join(workspace, 'f.txt'), 'before\n', 'utf8')
      beginWriteCheckpoint(runDir, workspace)
      await recordMcpFilesystemPriors(
        'filesystem',
        'write_file',
        { path: 'f.txt', content: 'after' },
        { runDir }
      )
      writeFileSync(join(workspace, 'f.txt'), 'after\n', 'utf8')
      const meta = finalizeWriteCheckpoint(runDir)
      expect(meta!.files[0]).toMatchObject({ path: 'f.txt', action: 'modified' })
      resolveWrites(runDir, workspace, { checkpointId: meta!.id, action: 'discard' })
      expect(readFileSync(join(workspace, 'f.txt'), 'utf8')).toBe('before\n')
    } finally {
      resetWriteCheckpointsForTests()
      rmSync(workspace, { recursive: true, force: true })
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('records move_file source as delete and destination as write', async () => {
    resetWriteCheckpointsForTests()
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-mv-'))
    const runDir = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-mv-run-'))
    try {
      writeFileSync(join(workspace, 'src.txt'), 'body\n', 'utf8')
      beginWriteCheckpoint(runDir, workspace)
      await recordMcpFilesystemPriors(
        'fs',
        'move_file',
        { source: 'src.txt', destination: 'dst.txt' },
        { runDir }
      )
      const meta = finalizeWriteCheckpoint(runDir)
      expect(meta!.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'src.txt', action: 'deleted' }),
          expect.objectContaining({ path: 'dst.txt', action: 'created' })
        ])
      )
    } finally {
      resetWriteCheckpointsForTests()
      rmSync(workspace, { recursive: true, force: true })
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('skips edit_file dryRun', async () => {
    resetWriteCheckpointsForTests()
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-dry-'))
    const runDir = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-dry-run-'))
    try {
      writeFileSync(join(workspace, 'f.txt'), 'x\n', 'utf8')
      beginWriteCheckpoint(runDir, workspace)
      await recordMcpFilesystemPriors(
        'filesystem',
        'edit_file',
        { path: 'f.txt', edits: [], dryRun: true },
        { runDir }
      )
      expect(finalizeWriteCheckpoint(runDir)).toBeNull()
    } finally {
      resetWriteCheckpointsForTests()
      rmSync(workspace, { recursive: true, force: true })
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('records MCP filesystem write paths for scoped git_commit', () => {
    const mutations = new Set<string>()
    applyMcpFilesystemMutations(mutations, 'filesystem', 'write_file', { path: 'src/a.ts' })
    applyMcpFilesystemMutations(mutations, 'fs', 'move_file', {
      source: 'old.ts',
      destination: 'new.ts'
    })
    applyMcpFilesystemMutations(mutations, 'filesystem', 'edit_file', {
      path: 'dry.ts',
      dryRun: true
    })
    expect([...mutations]).toEqual(['src/a.ts', 'old.ts', 'new.ts'])
  })
})

describe('workspaceMutationWatch', () => {
  let workspace: string
  let runDir: string

  beforeEach(() => {
    resetWriteCheckpointsForTests()
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-watch-ws-'))
    runDir = mkdtempSync(join(tmpdir(), 'vyotiq-watch-run-'))
    writeFileSync(join(workspace, 'keep.txt'), 'keep\n', 'utf8')
  })

  afterEach(() => {
    resetWriteCheckpointsForTests()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })

  it('catches opaque creates and restores via discard', async () => {
    beginWriteCheckpoint(runDir, workspace)
    const snap = await startWatch(workspace)
    writeFileSync(join(workspace, 'opaque.txt'), 'secret\n', 'utf8')
    const diff = await diffSince(snap)
    expect(diff.created).toContain('opaque.txt')
    await applyWatchDiffToCheckpoint(snap, diff, { runDir })
    disposeWatch(snap)
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta!.files).toEqual([
      expect.objectContaining({ path: 'opaque.txt', action: 'created', undoable: true })
    ])
    resolveWrites(runDir, workspace, { checkpointId: meta!.id, action: 'discard' })
    expect(existsSync(join(workspace, 'opaque.txt'))).toBe(false)
  })

  it('restores modified files from snapshot blobs', async () => {
    writeFileSync(join(workspace, 'm.txt'), 'before\n', 'utf8')
    beginWriteCheckpoint(runDir, workspace)
    const snap = await startWatch(workspace)
    writeFileSync(join(workspace, 'm.txt'), 'after\n', 'utf8')
    const diff = await diffSince(snap)
    expect(diff.modified).toContain('m.txt')
    await applyWatchDiffToCheckpoint(snap, diff, { runDir })
    disposeWatch(snap)
    const meta = finalizeWriteCheckpoint(runDir)
    resolveWrites(runDir, workspace, { checkpointId: meta!.id, action: 'discard' })
    expect(readFileSync(join(workspace, 'm.txt'), 'utf8')).toBe('before\n')
  })

  it('records mid-size modified files as undoable now that the snapshot blob cap is larger', async () => {
    const largePath = join(workspace, 'big.bin')
    writeFileSync(largePath, Buffer.alloc(1_100_000, 1))
    beginWriteCheckpoint(runDir, workspace)
    const snap = await startWatch(workspace)
    writeFileSync(largePath, Buffer.alloc(1_100_000, 2))
    const diff = await diffSince(snap)
    expect(diff.modified).toContain('big.bin')
    await applyWatchDiffToCheckpoint(snap, diff, { runDir })
    disposeWatch(snap)
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta!.files).toEqual([
      expect.objectContaining({ path: 'big.bin', action: 'modified', undoable: true })
    ])
    // And it actually restores to the prior content.
    resolveWrites(runDir, workspace, { checkpointId: meta!.id, action: 'discard' })
    expect(readFileSync(largePath).equals(Buffer.alloc(1_100_000, 1))).toBe(true)
  })

  it('records truly huge modified files as non-undoable (beyond the snapshot blob budget)', async () => {
    const hugePath = join(workspace, 'huge.bin')
    writeFileSync(hugePath, Buffer.alloc(33 * 1024 * 1024, 1))
    beginWriteCheckpoint(runDir, workspace)
    const snap = await startWatch(workspace)
    writeFileSync(hugePath, Buffer.alloc(33 * 1024 * 1024, 2))
    const diff = await diffSince(snap)
    expect(diff.modified).toContain('huge.bin')
    await applyWatchDiffToCheckpoint(snap, diff, { runDir })
    disposeWatch(snap)
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta!.files).toEqual([
      expect.objectContaining({ path: 'huge.bin', action: 'modified', undoable: false })
    ])
  })

  it('yields to the event loop while walking many directories', async () => {
    const walk = await import('@main/agent/tools/walk')
    const spy = vi.spyOn(walk, 'yieldToEventLoop')
    for (let i = 0; i < 70; i++) {
      mkdirSync(join(workspace, `dir-${i}`), { recursive: true })
      writeFileSync(join(workspace, `dir-${i}`, 'f.txt'), 'x\n', 'utf8')
    }
    const snap = await startWatch(workspace)
    expect(snap.files.size).toBeGreaterThan(60)
    expect(spy).toHaveBeenCalled()
    disposeWatch(snap)
    spy.mockRestore()
  })

  it('skips bin/ build output in opaque workspace snapshots', async () => {
    mkdirSync(join(workspace, 'bin', 'Debug', 'net10.0'), { recursive: true })
    writeFileSync(join(workspace, 'bin', 'Debug', 'net10.0', 'App.dll'), 'old-dll', 'utf8')
    writeFileSync(join(workspace, 'src.ts'), 'old\n', 'utf8')
    beginWriteCheckpoint(runDir, workspace)
    const snap = await startWatch(workspace)
    writeFileSync(join(workspace, 'bin', 'Debug', 'net10.0', 'App.dll'), 'new-dll', 'utf8')
    writeFileSync(join(workspace, 'src.ts'), 'new\n', 'utf8')
    const diff = await diffSince(snap)
    expect(diff.modified).toContain('src.ts')
    expect(diff.modified.join('\n')).not.toMatch(/bin[\\/]/)
    expect(diff.created.join('\n')).not.toMatch(/bin[\\/]/)
    await disposeWatch(snap)
  })

  it('bounds the content-hash pass by total bytes (64MB) and detects only budget-covered same-size rewrites', async () => {
    // 30MB files sit under the 32MB per-file hash cap; 30+30 fits the 64MB
    // total budget regardless of readdir order (BFS visits root files first),
    // while a 5MB file in a subdir is reached only after both fit → exhausted.
    const PATH_A = join(workspace, 'a.bin')
    const PATH_B = join(workspace, 'b.bin')
    const PATH_C = join(workspace, 'sub', 'c.bin')
    const SIZE = 30 * 1024 * 1024
    mkdirSync(join(workspace, 'sub'), { recursive: true })
    writeFileSync(PATH_A, Buffer.alloc(SIZE, 1))
    writeFileSync(PATH_B, Buffer.alloc(SIZE, 2))
    writeFileSync(PATH_C, Buffer.alloc(5 * 1024 * 1024, 3))
    // Pin mtimes to a whole-second stamp so identical rewrites of the pin
    // leave mtime/size unchanged — only the contentHash path can flag them.
    const pin = () => {
      const stamp = new Date(1_700_000_000_000)
      for (const p of [PATH_A, PATH_B, PATH_C]) utimesSync(p, stamp, stamp)
    }
    pin()

    beginWriteCheckpoint(runDir, workspace)
    const snap = await startWatch(workspace)
    expect(snap.files.get('a.bin')?.contentHash).toBeTruthy()
    expect(snap.files.get('b.bin')?.contentHash).toBeTruthy()
    expect(snap.files.get('sub/c.bin')?.contentHash).toBeUndefined()

    // Same-size in-place rewrites, mtimes re-pinned to the same stamp.
    writeFileSync(PATH_A, Buffer.alloc(SIZE, 9))
    writeFileSync(PATH_C, Buffer.alloc(5 * 1024 * 1024, 8))
    pin()

    const diff = await diffSince(snap)
    expect(diff.modified).toContain('a.bin')
    expect(diff.modified.join('\n')).not.toContain('c.bin')
    await applyWatchDiffToCheckpoint(snap, diff, { runDir })
    await disposeWatch(snap)
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta!.files).toEqual([
      expect.objectContaining({ path: 'a.bin', action: 'modified', undoable: false })
    ])
  })
})
