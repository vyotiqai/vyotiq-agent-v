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
  MEMORY_LIST_INDEX_EXCERPT,
  readMemoryFile,
  readMemoryIndex,
  readMemoryState,
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
    expect(listMemoryNotes(dir)).toEqual({ indexExcerpt: '', notes: [], hasState: false })
    expect(readMemoryFile(dir, 'state.md')).toContain('not created yet')
    expect(existsSync(memoryRoot(dir))).toBe(false)
  })

  it('caps the listMemoryNotes index excerpt at 1500 with an overflow marker', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    ensureMemoryLayout(dir)
    const bigIndex = 'x'.repeat(1_600)
    writeFileSync(join(memoryRoot(dir), 'index.md'), bigIndex, 'utf8')
    const listed = listMemoryNotes(dir)
    expect(listed.indexExcerpt.endsWith('\n…')).toBe(true)
    expect(listed.indexExcerpt.length).toBe(MEMORY_LIST_INDEX_EXCERPT + 2)
    expect(listed.indexExcerpt).not.toContain(bigIndex)
    // Under the cap the excerpt is byte-exact.
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    ensureMemoryLayout(dir)
    writeFileSync(join(memoryRoot(dir), 'index.md'), '# small\n', 'utf8')
    expect(listMemoryNotes(dir).indexExcerpt).toBe('# small\n')
  })
})
