import { describe, expect, it } from 'vitest'
import {
  readEditBody,
  readPathArg,
  readString,
  readTrimmed,
  requirePathArg
} from '@main/agent/tools/argAccess'

describe('argAccess', () => {
  it('reads path aliases in priority order', () => {
    expect(readPathArg({ path: 'a.ts' })).toBe('a.ts')
    expect(readPathArg({ file: 'b.ts' })).toBe('b.ts')
    expect(readPathArg({ filepath: 'c.ts' })).toBe('c.ts')
    expect(readPathArg({ filename: 'd.ts' })).toBe('d.ts')
    expect(readPathArg({ path: '  spaced.ts  ' })).toBe('spaced.ts')
    expect(readPathArg({})).toBeUndefined()
  })

  it('reads edit body aliases', () => {
    expect(readEditBody({ contents: 'full' })).toEqual({ contents: 'full', diff: undefined })
    expect(readEditBody({ content: 'alias' })).toEqual({ contents: 'alias', diff: undefined })
    expect(readEditBody({ diff: '@@' })).toEqual({ contents: undefined, diff: '@@' })
  })

  it('never throws on non-string values', () => {
    expect(readString({ path: 1 }, 'path')).toBeUndefined()
    expect(readTrimmed({ query: null }, 'query')).toBeUndefined()
    expect(() => requirePathArg('edit', {})).toThrow('edit requires path')
  })
})
