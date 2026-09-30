import { describe, expect, it } from 'vitest'
import { parseDiffPreview } from '@renderer/features/chat/toolUi'
import type { UiToolRow } from '@shared/transcript'

function tool(overrides: Partial<UiToolRow> & Pick<UiToolRow, 'name'>): UiToolRow {
  return {
    id: 't1',
    summary: '',
    status: 'done',
    ...overrides
  }
}

const OLD_STRING = 'const a = 1\nconst b = 2\nconst c = 3'
const NEW_STRING = 'const a = 1\nconst b = 22\nconst c = 3'

function strReplaceRow(content: string): UiToolRow {
  return tool({
    name: 'str_replace',
    argsPreview: JSON.stringify({
      path: 'src/x.ts',
      old_string: OLD_STRING,
      new_string: NEW_STRING
    }),
    content
  })
}

const numbersFor = (rows: ReturnType<typeof parseDiffPreview>, kind: 'add' | 'del') =>
  rows.filter((row) => row.kind === kind).map((row) => row.lineNumber)

describe('edit diff gutter line numbers', () => {
  it('numbers str_replace rows from the line the tool result reports', () => {
    const rows = parseDiffPreview(strReplaceRow('Replaced 1 occurrence in src/x.ts (line 42)'))

    // Nothing before the match changes, so old and new file both start at 42.
    expect(numbersFor(rows, 'del')).toEqual([42, 43, 44])
    expect(numbersFor(rows, 'add')).toEqual([42, 43, 44])
  })

  it('leaves str_replace rows unnumbered when the result reports no line', () => {
    const rows = parseDiffPreview(strReplaceRow('Replaced 1 occurrence in src/x.ts'))

    expect(rows.length).toBe(6)
    expect(numbersFor(rows, 'del')).toEqual([null, null, null])
    expect(numbersFor(rows, 'add')).toEqual([null, null, null])
  })

  it('leaves a whole-file contents write unnumbered', () => {
    const rows = parseDiffPreview(
      tool({ name: 'edit', argsPreview: JSON.stringify({ path: 'n.ts', contents: 'a\nb\n' }) })
    )

    expect(rows.map((row) => row.lineNumber)).toEqual([null, null])
  })

  it('still numbers unified diff rows from the hunk header', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -10,4 +10,4 @@', ' keep', '-gone', '+added', ' tail']
      .join('\n')
    const rows = parseDiffPreview(tool({ name: 'edit', argsPreview: JSON.stringify({ path: 'x.ts', diff }) }))

    expect(rows.map((row) => [row.kind, row.lineNumber])).toEqual([
      ['context', 10],
      ['del', null],
      ['add', 11],
      ['context', 12]
    ])
  })
})
