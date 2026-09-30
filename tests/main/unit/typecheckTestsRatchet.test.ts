import { describe, expect, it } from 'vitest'
import { parseTscErrors, regressions } from '../../../scripts/typecheck-tests-ratchet.mjs'

const out = [
  "tests/a.test.ts(3,5): error TS2339: Property 'x' does not exist on type 'Y'.",
  'tests\\b.test.ts(1,1): error TS7006: Parameter implicitly has an any type.',
  "tests/a.test.ts(9,2): error TS2322: Type 'string' is not assignable to type 'number'.",
  'Found 3 errors in 2 files.'
].join('\r\n')

describe('typecheck-tests ratchet', () => {
  it('groups error lines per file with forward slashes on every OS', () => {
    const { byFile, syntax } = parseTscErrors(out)
    expect([...byFile.keys()]).toEqual(['tests/a.test.ts', 'tests/b.test.ts'])
    expect(byFile.get('tests/a.test.ts')).toHaveLength(2)
    expect(syntax).toEqual([])
  })

  it('flags syntax errors, which hide every other type error in TypeScript 7', () => {
    const { syntax } = parseTscErrors("tests/c.test.ts(2,1): error TS1005: ',' expected.")
    expect(syntax).toHaveLength(1)
  })

  it('fails only files that gained errors, including new files', () => {
    const { byFile } = parseTscErrors(out)
    expect(regressions(byFile, { 'tests/a.test.ts': 2, 'tests/b.test.ts': 1 })).toEqual([])
    expect(regressions(byFile, { 'tests/a.test.ts': 5, 'tests/b.test.ts': 3 })).toEqual([])
    const grown = regressions(byFile, { 'tests/a.test.ts': 1 })
    expect(grown.map((g) => [g.file, g.allowed, g.count])).toEqual([
      ['tests/a.test.ts', 1, 2],
      ['tests/b.test.ts', 0, 1]
    ])
  })
})
