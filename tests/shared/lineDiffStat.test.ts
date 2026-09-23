import { describe, expect, it } from 'vitest'
import { lineDiffStat, splitLines } from '@shared/utils/lineDiffStat'

describe('splitLines', () => {
  it('treats a trailing newline as the end of the last line', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\r\nb')).toEqual(['a', 'b'])
    expect(splitLines('')).toEqual([])
  })
})

describe('lineDiffStat', () => {
  it('counts a created and a deleted file as all adds or all deletes', () => {
    expect(lineDiffStat('', 'a\nb\nc\n')).toEqual({ add: 3, del: 0 })
    expect(lineDiffStat('a\nb\n', '')).toEqual({ add: 0, del: 2 })
  })

  it('counts a replaced line as one add and one delete', () => {
    expect(lineDiffStat('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ add: 1, del: 1 })
  })

  it('matches what git would report for interleaved hunks', () => {
    const before = ['import a', 'one', 'two', 'three', 'four', 'five', 'end'].join('\n')
    const after = ['import a', 'import b', 'one', 'three', 'four', 'FIVE', 'five', 'end'].join('\n')
    // + import b, − two, + FIVE
    expect(lineDiffStat(before, after)).toEqual({ add: 2, del: 1 })
  })

  it('ignores line-ending differences alone', () => {
    expect(lineDiffStat('a\r\nb\r\n', 'a\nb\n')).toEqual({ add: 0, del: 0 })
  })

  it('returns null instead of guessing when the edit is too large', () => {
    const before = Array.from({ length: 50 }, (_, i) => `x${i}`).join('\n')
    const after = Array.from({ length: 50 }, (_, i) => `y${i}`).join('\n')
    expect(lineDiffStat(before, after, { maxEdits: 20 })).toBeNull()
    expect(lineDiffStat(before, after)).toEqual({ add: 50, del: 50 })
  })
})
