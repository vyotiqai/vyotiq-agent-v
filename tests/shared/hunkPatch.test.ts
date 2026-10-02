import { describe, expect, it } from 'vitest'
import { formatUnifiedDiff, lineDiff } from '@shared/utils/unifiedDiff'
import {
  applyHunkPatch,
  diffFingerprint,
  forwardHunk,
  hunkIdentity,
  invertPatch,
  parseUnifiedHunks,
  reverseHunk,
  sameHunk
} from '@shared/utils/hunkPatch'

const lines = (n: number, tag = 'line'): string[] => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`)

/** Undo one hunk of before→after, as the Changes review does. */
function undo(before: string, after: string, index: number): string {
  const hunk = lineDiff(before, after).hunks[index]!
  const applied = applyHunkPatch(after, reverseHunk(hunk))
  if (!applied.ok) throw new Error('did not apply')
  return applied.text
}

describe('hunk identity', () => {
  it('names a hunk by position and content, and survives a round trip through the diff text', () => {
    const before = `${lines(20).join('\n')}\n`
    const after = before.replace('line 3\n', 'line three\n').replace('line 17\n', 'line seventeen\n')
    const diff = lineDiff(before, after)
    const parsed = parseUnifiedHunks(formatUnifiedDiff('a.txt', diff, 'modified'))
    expect(parsed).toHaveLength(2)
    expect(parsed.map(hunkIdentity)).toEqual(diff.hunks.map(hunkIdentity))
    expect(sameHunk(hunkIdentity(parsed[0]!), hunkIdentity(parsed[1]!))).toBe(false)
  })

  it('tells hunks at the same place apart by what they say', () => {
    const base = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }
    const a = hunkIdentity({ ...base, lines: [{ kind: '-', text: 'x' }, { kind: '+', text: 'y' }] })
    const b = hunkIdentity({ ...base, lines: [{ kind: '-', text: 'x' }, { kind: '+', text: 'z' }] })
    expect(sameHunk(a, b)).toBe(false)
  })

  it('fingerprints the diff text the same whatever its line endings', () => {
    expect(diffFingerprint('@@ -1 +1 @@\n-a\n+b\n')).toBe(diffFingerprint('@@ -1 +1 @@\r\n-a\r\n+b\r\n'))
    expect(diffFingerprint('@@ -1 +1 @@\n-a\n+b\n')).not.toBe(diffFingerprint('@@ -1 +1 @@\n-a\n+c\n'))
  })
})

describe('reverse-applying one hunk', () => {
  it('takes one of several hunks back and leaves the others', () => {
    const before = `${lines(30).join('\n')}\n`
    const after = before
      .replace('line 2\n', 'line 2\nadded early\n')
      .replace('line 15\n', 'changed 15\n')
      .replace('line 28\n', '')
    expect(lineDiff(before, after).hunks).toHaveLength(3)

    const middleUndone = undo(before, after, 1)
    expect(middleUndone).toContain('added early\n')
    expect(middleUndone).toContain('line 15\n')
    expect(middleUndone).not.toContain('changed 15')
    expect(middleUndone).not.toContain('line 28\n')

    // Every hunk undone, one at a time against the file as it is then, is the before-image.
    let text = after
    while (lineDiff(before, text).hunks.length > 0) text = undo(before, text, 0)
    expect(text).toBe(before)
  })

  it('handles hunks one line apart (merged into one) and hunks just far enough apart to stay two', () => {
    const before = `${lines(20).join('\n')}\n`
    const merged = before.replace('line 5\n', 'five\n').replace('line 12\n', 'twelve\n')
    expect(lineDiff(before, merged).hunks).toHaveLength(1)
    expect(undo(before, merged, 0)).toBe(before)

    const apart = before.replace('line 5\n', 'five\n').replace('line 13\n', 'thirteen\n')
    expect(lineDiff(before, apart).hunks).toHaveLength(2)
    const second = undo(before, apart, 1)
    expect(second).toContain('five\n')
    expect(second).toContain('line 13\n')
  })

  it('keeps CRLF line endings, on the lines it keeps and the lines it puts back', () => {
    const before = `${lines(12).join('\r\n')}\r\n`
    const after = before.replace('line 6\r\n', 'six\r\nsix and a half\r\n')
    const text = undo(before, after, 0)
    expect(text).toBe(before)
    expect(text.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('gives put-back lines the file’s usual ending in a mixed file', () => {
    const after = 'a\r\nb\r\nnew\r\nc\nd\r\n'
    const patch = { start: 1, lines: [{ kind: ' ' as const, text: 'b' }, { kind: '-' as const, text: 'new' }, { kind: '+' as const, text: 'old' }] }
    const applied = applyHunkPatch(after, patch)
    expect(applied).toEqual({ ok: true, text: 'a\r\nb\r\nold\r\nc\nd\r\n', at: 1 })
  })

  it('leaves a file with no newline at its end without one', () => {
    const before = 'one\ntwo\nthree'
    const after = 'one\ntwo\nTHREE'
    expect(undo(before, after, 0)).toBe('one\ntwo\nthree')

    // The agent dropped the last lines: putting them back keeps the missing final newline.
    const shorter = 'one\ntwo'
    expect(undo('one\ntwo\nthree\nfour', shorter, 0)).toBe('one\ntwo\nthree\nfour')
  })

  it('reverses an added file to nothing and a deleted file back to its text', () => {
    const created = lineDiff('', 'a\nb\n').hunks
    expect(created).toHaveLength(1)
    expect(applyHunkPatch('a\nb\n', reverseHunk(created[0]!))).toEqual({ ok: true, text: '', at: 0 })

    const deleted = lineDiff('a\r\nb\r\n', '').hunks
    expect(deleted).toHaveLength(1)
    expect(applyHunkPatch('', reverseHunk(deleted[0]!), { eol: '\r\n', finalEol: '\r\n' })).toEqual({
      ok: true,
      text: 'a\r\nb\r\n',
      at: 0
    })
  })

  it('refuses when the file changed under the hunk since it was shown', () => {
    const before = `${lines(10).join('\n')}\n`
    const after = before.replace('line 5\n', 'five\n')
    const hunk = lineDiff(before, after).hunks[0]!
    const changedSince = after.replace('five\n', 'FIVE\n')
    expect(applyHunkPatch(changedSince, reverseHunk(hunk))).toEqual({ ok: false })
    // Lines added above move it: without leave to look nearby, that is a refusal too.
    expect(applyHunkPatch(`zero\n${after}`, reverseHunk(hunk))).toEqual({ ok: false })
  })

  it('puts an undone hunk back, finding it where other lines moved it', () => {
    const before = `${lines(30).join('\n')}\n`
    const after = before.replace('line 20\n', 'twenty\n')
    const hunk = lineDiff(before, after).hunks[0]!
    const patch = reverseHunk(hunk)
    const undone = applyHunkPatch(after, patch)
    if (!undone.ok) throw new Error('did not apply')
    expect(undone.text).toBe(before)

    const restore = invertPatch(patch, undone.at)
    expect(applyHunkPatch(undone.text, restore)).toMatchObject({ ok: true, text: after })
    // Two lines added near the top since: the put-back finds the hunk two lines down.
    const moved = `top a\ntop b\n${undone.text}`
    expect(applyHunkPatch(moved, restore)).toEqual({ ok: false })
    expect(applyHunkPatch(moved, restore, { maxOffset: 10 })).toMatchObject({ ok: true, text: `top a\ntop b\n${after}` })
  })

  it('applies a hunk forward to the old text', () => {
    const before = `${lines(8).join('\n')}\n`
    const after = before.replace('line 4\n', 'four\n')
    const hunk = lineDiff(before, after).hunks[0]!
    expect(applyHunkPatch(before, forwardHunk(hunk))).toMatchObject({ ok: true, text: after })
  })
})
