import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { deleteMemoryNote, memoryNoteDetails } from '@main/agent/context/memory'

let ws = ''
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'vyotiq-memnotes-'))
  const root = join(ws, '.vyotiq', 'memory')
  mkdirSync(join(root, 'notes'), { recursive: true })
  writeFileSync(join(root, 'index.md'), '# Memory index\n\n- [Build](notes/build.md) — how to build\n- [Old](notes/old.md)\n')
  writeFileSync(join(root, 'notes', 'build.md'), '# Build with pnpm\n\nRun pnpm build:vite.\n')
  writeFileSync(join(root, 'notes', 'old.md'), 'Stale fact\n')
  writeFileSync(join(root, 'notes', 'stray.md'), '\n## Not in the index\n')
  writeFileSync(join(root, 'state.md'), 'Working on the updater\n')
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

describe('memory notes', () => {
  it('lists each note with its first line and whether the index points at it', async () => {
    const notes = await memoryNoteDetails(ws)
    const byPath = Object.fromEntries(notes.map((n) => [n.path, n]))
    expect(Object.keys(byPath).sort()).toEqual(['notes/build.md', 'notes/old.md', 'notes/stray.md', 'state.md'])
    expect(byPath['notes/build.md']).toMatchObject({ title: 'Build with pnpm', indexed: true })
    expect(byPath['notes/stray.md']).toMatchObject({ title: 'Not in the index', indexed: false })
  })

  it('deletes a note and the index line that points at it, and nothing else', async () => {
    expect(await deleteMemoryNote(ws, 'notes/old.md')).toBe(true)
    const root = join(ws, '.vyotiq', 'memory')
    expect(existsSync(join(root, 'notes', 'old.md'))).toBe(false)
    const index = readFileSync(join(root, 'index.md'), 'utf8')
    expect(index).not.toContain('notes/old.md')
    expect(index).toContain('notes/build.md')
    expect(await deleteMemoryNote(ws, 'notes/old.md')).toBe(false)
  })

  it('refuses index.md and anything outside the notes', async () => {
    await expect(deleteMemoryNote(ws, 'index.md')).rejects.toThrow(/Only a note/)
    await expect(deleteMemoryNote(ws, '../../package.json')).rejects.toThrow()
    await expect(deleteMemoryNote(ws, 'notes/../../x.md')).rejects.toThrow()
  })
})
