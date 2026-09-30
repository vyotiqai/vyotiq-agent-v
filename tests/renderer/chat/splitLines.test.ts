import { describe, expect, it } from 'vitest'
import { splitLines } from '@renderer/features/chat/toolUi/parsers/common'
import { splitLines as sharedSplitLines } from '@shared/utils/lineDiffStat'
import { parseDiffPreview } from '@renderer/features/chat/toolUi/parsers/edit'
import type { UiToolRow } from '@shared/transcript'

describe('splitLines (parser re-export)', () => {
  it('is the one shared implementation', () => {
    expect(splitLines).toBe(sharedSplitLines)
  })

  it('treats an empty string as zero lines', () => {
    expect(splitLines('')).toEqual([])
  })

  it('drops the carriage return from CRLF text', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b'])
  })

  it('still splits plain multi-line text', () => {
    expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c'])
  })

  it('does not keep a trailing empty line for a single trailing newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
  })

  it('keeps a blank line in the middle', () => {
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b'])
  })
})

describe('parseDiffPreview with a whole-file write', () => {
  function editRow(contents: string): UiToolRow {
    return {
      id: 'e1',
      name: 'edit',
      summary: 'empty.ts',
      status: 'done',
      argsPreview: JSON.stringify({ path: 'empty.ts', contents }),
      content: 'Wrote empty.ts'
    }
  }

  it('renders no rows for an empty file instead of one phantom +', () => {
    expect(parseDiffPreview(editRow(''))).toEqual([])
  })

  it('still renders one add row per written line', () => {
    expect(parseDiffPreview(editRow('a\nb\n')).map((r) => [r.kind, r.text])).toEqual([
      ['add', 'a'],
      ['add', 'b']
    ])
  })
})
