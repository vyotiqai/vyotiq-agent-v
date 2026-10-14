import { describe, expect, it } from 'vitest'
import { compileUserRegex } from '@main/agent/tools/safeUserRegex'

/**
 * grep runs its regex synchronously on the main process, so a catastrophic
 * pattern freezes every window. A quantified group ending in an optional part
 * slipped past the nested-quantifier check.
 */
describe('ReDoS guard: quantified groups with an optional tail', () => {
  it('rejects ?)+, ?)* and ?){n,}', () => {
    expect(() => compileUserRegex('^(\\w+\\s?)+$')).toThrow(/nested quantifiers/)
    expect(() => compileUserRegex('(?:a?)*')).toThrow(/nested quantifiers/)
    expect(() => compileUserRegex('(x\\s?){2,}')).toThrow(/nested quantifiers/)
  })

  it('keeps safe patterns working', () => {
    expect(compileUserRegex('colou?r').test('color')).toBe(true)
    expect(compileUserRegex('(foo)?bar').test('bar')).toBe(true)
    expect(compileUserRegex('(ab)+').test('abab')).toBe(true)
    expect(compileUserRegex('\\B(?=(\\d{3})+(?!\\d))', 'g').test('1234567')).toBe(true)
    expect(compileUserRegex('(a\\?)+').test('a?a?')).toBe(true)
    expect(compileUserRegex('^export (async )?function').test('export function f')).toBe(true)
  })
})
