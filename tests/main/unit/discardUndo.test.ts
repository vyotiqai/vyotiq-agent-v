import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pruneDiscardUndo, snapshotForUndo, undoDiscard } from '@main/git/discardUndo'

/** Undo for Discard: the copies kept, what comes back, and what is left alone. */
let ws = ''
let root = ''

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'vyotiq-undo-ws-'))
  root = mkdtempSync(join(tmpdir(), 'vyotiq-undo-root-'))
  mkdirSync(join(ws, 'src'), { recursive: true })
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

describe('discard undo', () => {
  it('puts back an overwritten file and a removed one', async () => {
    writeFileSync(join(ws, 'src', 'a.ts'), 'my edit\n')
    writeFileSync(join(ws, 'new.txt'), 'untracked\n')
    const pending = await snapshotForUndo(root, ws, ['src/a.ts', 'new.txt', 'missing.ts'])
    // What the discard does: git restores a.ts, the trash takes new.txt.
    writeFileSync(join(ws, 'src', 'a.ts'), 'committed\n')
    rmSync(join(ws, 'new.txt'))
    const id = await pending.finish(['src/a.ts', 'new.txt'])
    expect(id).toBeTruthy()
    const result = await undoDiscard(root, ws, id!)
    expect(result.restored.sort()).toEqual(['new.txt', 'src/a.ts'])
    expect(readFileSync(join(ws, 'src', 'a.ts'), 'utf8')).toBe('my edit\n')
    expect(readFileSync(join(ws, 'new.txt'), 'utf8')).toBe('untracked\n')
    await expect(undoDiscard(root, ws, id!)).rejects.toThrow(/no longer be undone/)
  })

  it('leaves a file that changed again since the discard', async () => {
    writeFileSync(join(ws, 'src', 'a.ts'), 'my edit\n')
    const pending = await snapshotForUndo(root, ws, ['src/a.ts'])
    writeFileSync(join(ws, 'src', 'a.ts'), 'committed\n')
    const id = await pending.finish(['src/a.ts'])
    writeFileSync(join(ws, 'src', 'a.ts'), 'newer work\n')
    const result = await undoDiscard(root, ws, id!)
    expect(result.skipped).toEqual(['src/a.ts'])
    expect(result.detail).toMatch(/changed since/)
    expect(readFileSync(join(ws, 'src', 'a.ts'), 'utf8')).toBe('newer work\n')
  })

  it('keeps nothing when nothing was discarded, refuses another workspace, and prunes old sets', async () => {
    writeFileSync(join(ws, 'src', 'a.ts'), 'x\n')
    const nothing = await snapshotForUndo(root, ws, ['src/a.ts'])
    expect(await nothing.finish([])).toBeNull()
    expect(readdirSync(root)).toEqual([])

    const pending = await snapshotForUndo(root, ws, ['src/a.ts'])
    const id = (await pending.finish(['src/a.ts']))!
    await expect(undoDiscard(root, join(ws, 'other'), id)).rejects.toThrow(/another workspace/)
    await pruneDiscardUndo(root, Date.now() + 2 * 24 * 60 * 60 * 1000)
    expect(existsSync(join(root, id))).toBe(false)
  })
})
