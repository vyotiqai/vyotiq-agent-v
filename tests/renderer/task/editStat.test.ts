import { describe, expect, it } from 'vitest'
import type { UiToolRow } from '@shared/transcript'
import { editStatOf, sumEditStats } from '@renderer/features/task/editStat'

function row(name: string, args: Record<string, unknown>, content = ''): UiToolRow {
  return { id: 'c', name, summary: '', status: 'done', content, argsPreview: JSON.stringify(args) }
}

describe('editStatOf', () => {
  it('diffs a replacement instead of counting both texts wholesale', () => {
    // Old: "a b", new: "a c d" → one line removed, two added; "a" is unchanged.
    expect(editStatOf(row('str_replace', { path: 'x.ts', old_string: 'a\nb', new_string: 'a\nc\nd' }))).toEqual({
      path: 'x.ts',
      exact: true,
      add: 2,
      del: 1
    })
  })

  it('cannot count a replace_all from its arguments', () => {
    expect(editStatOf(row('str_replace', { path: 'x.ts', old_string: 'a', new_string: 'b', replace_all: true }))).toEqual({
      path: 'x.ts',
      exact: false
    })
  })

  it('counts a unified diff’s own +/- lines, not its headers', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,3 @@', ' a', '-b', '+c', '+d'].join('\n')
    expect(editStatOf(row('edit', { path: 'x.ts', diff }))).toEqual({ path: 'x.ts', exact: true, add: 2, del: 1 })
  })

  it('counts every line of a created file, and nothing of an overwrite', () => {
    expect(editStatOf(row('edit', { path: 'new.ts', contents: 'one\ntwo\n' }, 'Created new.ts (8 chars)'))).toEqual({
      path: 'new.ts',
      exact: true,
      add: 2,
      del: 0
    })
    expect(editStatOf(row('edit', { path: 'old.ts', contents: 'one\n' }, 'Wrote old.ts (4 chars)'))).toEqual({
      path: 'old.ts',
      exact: false
    })
  })

  it('ignores tools that write nothing', () => {
    expect(editStatOf(row('read', { path: 'x.ts' }))).toBeNull()
  })
})

describe('sumEditStats', () => {
  it('counts a file once however many times it was edited', () => {
    expect(
      sumEditStats([
        { path: 'x.ts', exact: true, add: 2, del: 1 },
        { path: 'x.ts', exact: true, add: 1, del: 0 },
        { path: 'y.ts', exact: true, add: 0, del: 3 }
      ])
    ).toEqual({ files: 2, add: 3, del: 4 })
  })

  it('drops the line counts when any write could not be counted', () => {
    expect(
      sumEditStats([
        { path: 'x.ts', exact: true, add: 2, del: 1 },
        { path: 'gone.ts', exact: false }
      ])
    ).toEqual({ files: 2 })
  })
})
