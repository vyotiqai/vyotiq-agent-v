import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

const canSymlink = (() => {
  const root = mkdtempSync(join(tmpdir(), 'vyotiq-mem-symlink-probe-'))
  try {
    if (process.platform === 'win32') {
      const target = join(root, 't')
      mkdirSync(target)
      symlinkSync(target, join(root, 'link'), 'junction')
      return true
    }
    const target = join(root, 't.txt')
    writeFileSync(target, 'x', 'utf8')
    symlinkSync(target, join(root, 'link.txt'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})()
import {
  ensureMemoryLayout,
  listMemoryNotes,
  readMemoryFile,
  readMemoryIndex,
  readMemoryState,
  truncateMemoryExcerpt,
  writeMemoryFile,
  memoryRoot
} from '@main/agent/context/memory'
import {
  toolMemoryList,
  toolMemoryRead,
  toolMemoryWrite
} from '@main/agent/tools/memory'

describe('memory store', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('creates layout and writes notes under .vyotiq/memory', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    ensureMemoryLayout(dir)
    expect(memoryRoot(dir)).toContain('.vyotiq')
    const written = writeMemoryFile(dir, 'notes/arch.md', '# Arch\n')
    expect(written).toBe('notes/arch.md')
    expect(readMemoryFile(dir, 'notes/arch.md')).toContain('Arch')
    const listed = listMemoryNotes(dir)
    expect(listed.notes).toContain('arch.md')
  })

  it('rejects path escape', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    ensureMemoryLayout(dir)
    expect(() => writeMemoryFile(dir, '../secrets.txt', 'nope')).toThrow(/escape|Invalid/)
    expect(() => readMemoryFile(dir, '../secrets.txt')).toThrow(/escape|Invalid/)
    expect(() => readMemoryFile(dir, 'notes/../index.md')).toThrow(/Invalid/)
  })

  it.skipIf(!canSymlink)('rejects memory root symlink that escapes the workspace', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    const outside = mkdtempSync(join(tmpdir(), 'vyotiq-mem-out-'))
    try {
      writeFileSync(join(outside, 'index.md'), '# leaked\n', 'utf8')
      mkdirSync(join(dir, '.vyotiq'), { recursive: true })
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      symlinkSync(outside, join(dir, '.vyotiq', 'memory'), linkType)
      expect(() => readMemoryFile(dir, 'index.md')).toThrow(/escapes workspace/)
      expect(() => writeMemoryFile(dir, 'notes/x.md', 'nope')).toThrow(/escapes workspace/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('exposes memory tools', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    toolMemoryWrite(dir, 'notes/prefs.md', 'prefers pnpm')
    expect(toolMemoryRead(dir, 'notes/prefs.md')).toContain('pnpm')
    expect(toolMemoryList(dir)).toContain('prefs.md')
  })

  it('returns friendly response when memory file is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    ensureMemoryLayout(dir)
    expect(toolMemoryRead(dir, 'state.md')).toContain('not created yet')
    expect(readMemoryFile(dir, 'state.md')).toContain('not created yet')
    expect(() => toolMemoryRead(dir, 'notes/missing.md')).toThrow(
      'File not found: notes/missing.md'
    )
    // Whitelist validation still wins over missing-file checks
    expect(() => toolMemoryRead(dir, 'other.md')).toThrow(/path must be/)
    expect(() => toolMemoryRead(dir, 'notes/bad name.md')).toThrow(/safe characters/)
    expect(() => toolMemoryRead(dir, 'notes/../index.md')).toThrow(/Invalid/)
  })

  it('keeps reads side-effect-free when no memory exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    expect(readMemoryIndex(dir)).toBe('')
    expect(readMemoryState(dir)).toBe('')
    expect(listMemoryNotes(dir)).toEqual({ notes: [], indexedNotes: [], hasState: false })
    expect(readMemoryFile(dir, 'state.md')).toContain('not created yet')
    expect(existsSync(memoryRoot(dir))).toBe(false)
  })

  it('caps the injected index excerpt on a line boundary with an explicit marker', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    ensureMemoryLayout(dir)
    // Multi-entry index whose full text exceeds the cap: the cut must land on
    // the last complete entry (line boundary), never mid-entry, and the tail
    // must be announced with the deterministic marker.
    const bigIndex = ['# Memory index', '', ...Array.from({ length: 40 }, (_, i) => `- [note-${i}].md — ${'x'.repeat(100)}`), ''].join('\n')
    writeFileSync(join(memoryRoot(dir), 'index.md'), bigIndex, 'utf8')
    const capped = readMemoryIndex(dir, 3000)
    expect(capped.length).toBeLessThanOrEqual(3000 + '[truncated: showing first 0 of 0 chars — memory_read the file for the rest]'.length)
    expect(capped.endsWith('\n') || capped.includes('[truncated:')).toBe(true)
    expect(capped).toContain('[truncated: showing first ')
    expect(capped).toMatch(/of \d+ chars — memory_read the file for the rest\]$/)
    // Cut lands on a line boundary: the last line before the marker is complete.
    const lines = capped.split('\n')
    const markerIdx = lines.findIndex((l) => l.startsWith('[truncated:'))
    expect(markerIdx).toBeGreaterThan(0)
    expect(lines[markerIdx - 1]).toMatch(/^- \[note-\d+\]\.md — x+$/)
    // No half-entry: no truncated 'x' run shorter than the full 100.
    expect(lines[markerIdx - 1].length).toBeGreaterThan(100)

    // Under the cap the output is byte-exact with no marker.
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    ensureMemoryLayout(dir)
    writeFileSync(join(memoryRoot(dir), 'index.md'), '# small\n', 'utf8')
    expect(readMemoryIndex(dir, 3000)).toBe('# small\n')
  })

  it('hard-cuts (with marker) only when a single line exceeds the cap', () => {
    expect(truncateMemoryExcerpt('a'.repeat(120), 100)).toBe(
      'a'.repeat(100) + '\n[truncated: showing first 100 of 120 chars — memory_read the file for the rest]'
    )
  })

  it('does not excerpt the index in memory_list output (pre-injected every step)', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    ensureMemoryLayout(dir)
    writeFileSync(join(memoryRoot(dir), 'index.md'), 'INDEX_BODY_MARKER\n', 'utf8')
    writeMemoryFile(dir, 'notes/prefs.md', 'prefers pnpm\n')
    const listed = listMemoryNotes(dir)
    expect(listed).toEqual({ notes: ['prefs.md'], indexedNotes: [], hasState: false })
    expect('INDEX_BODY_MARKER' in listed).toBe(false)
  })

  it('reports index coverage drift (unindexed + broken pointers)', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    ensureMemoryLayout(dir)
    writeFileSync(
      join(memoryRoot(dir), 'index.md'),
      '- [notes/live.md](notes/live.md) — live\n- [notes/gone.md](notes/gone.md) — deleted\n',
      'utf8'
    )
    writeMemoryFile(dir, 'notes/live.md', 'live\n')
    writeMemoryFile(dir, 'notes/orphan.md', 'not indexed\n')
    const listed = listMemoryNotes(dir)
    expect(listed.notes).toEqual(['live.md', 'orphan.md'])
    expect(listed.indexedNotes).toEqual(['gone.md', 'live.md'])

    const out = toolMemoryList(dir)
    expect(out).toContain('index.md coverage: 2/2 notes')
    expect(out).toContain('not in index.md: orphan.md')
    expect(out).toContain('indexed but missing on disk: gone.md')
  })

  it('reports full coverage when every note is indexed and resolves', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    ensureMemoryLayout(dir)
    writeFileSync(
      join(memoryRoot(dir), 'index.md'),
      '- [notes/only.md](notes/only.md) — x\n',
      'utf8'
    )
    writeMemoryFile(dir, 'notes/only.md', 'x\n')
    const out = toolMemoryList(dir)
    expect(out).toContain('index.md coverage: 1/1 notes — full')
    expect(out).not.toContain('not in index.md:')
    expect(out).not.toContain('indexed but missing on disk:')
  })
})
