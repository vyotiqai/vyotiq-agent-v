import { describe, expect, it } from 'vitest'
import {
  decodeJsonStringPrefix,
  extractJsonStringField,
  extractPartialEditArgs,
  extractPartialEditsArray
} from '@shared/utils/partialJson'

describe('decodeJsonStringPrefix', () => {
  it('decodes a complete JSON string with escapes', () => {
    const raw = 'hello\\nworld\\"x"'
    const result = decodeJsonStringPrefix(raw, 0)
    expect(result.complete).toBe(true)
    expect(result.value).toBe('hello\nworld"x')
  })

  it('returns incomplete value when the closing quote is still streaming', () => {
    const result = decodeJsonStringPrefix('line1\\nline2', 0)
    expect(result.complete).toBe(false)
    expect(result.value).toBe('line1\nline2')
  })

  it('waits when a trailing backslash has no escape partner yet', () => {
    const result = decodeJsonStringPrefix('abc\\', 0)
    expect(result.complete).toBe(false)
    expect(result.value).toBe('abc')
  })
})

describe('extractJsonStringField', () => {
  it('pulls a partial diff field from incomplete args JSON', () => {
    const raw = '{"path":"a.ts","diff":"@@\\n+hello'
    expect(extractJsonStringField(raw, 'path')).toBe('a.ts')
    expect(extractJsonStringField(raw, 'diff')).toBe('@@\n+hello')
  })

  it('returns undefined until the field opening quote appears', () => {
    expect(extractJsonStringField('{"path":"a.ts","di', 'diff')).toBeUndefined()
  })
})

describe('extractPartialEditArgs', () => {
  it('returns full parse when JSON is complete', () => {
    const args = extractPartialEditArgs(
      JSON.stringify({ path: 'x.ts', diff: '@@\n+a\n' })
    )
    expect(args).toEqual({ path: 'x.ts', diff: '@@\n+a\n' })
  })

  it('extracts live path + growing diff before the object closes', () => {
    const mid = '{"path":"src/app.ts","diff":"@@\\n-old\\n+new'
    const args = extractPartialEditArgs(mid)
    expect(args?.path).toBe('src/app.ts')
    expect(args?.diff).toBe('@@\n-old\n+new')
  })

  it('extracts streaming contents writes', () => {
    const mid = '{"path":"n.md","contents":"# Title\\n\\nHello'
    const args = extractPartialEditArgs(mid)
    expect(args?.path).toBe('n.md')
    expect(args?.contents).toBe('# Title\n\nHello')
  })

  it('extracts file/content aliases from truncated JSON', () => {
    const mid = '{"file":"manifest.json","content":"{\\"name\\": \\"vy'
    const args = extractPartialEditArgs(mid)
    expect(args?.path).toBe('manifest.json')
    expect(args?.contents).toBe('{"name": "vy')
  })

  it('extracts streaming str_replace new_string while old_string is complete', () => {
    const mid =
      '{"path":"x.ts","old_string":"a\\nb","new_string":"c'
    const args = extractPartialEditArgs(mid)
    expect(args?.old_string).toBe('a\nb')
    expect(args?.new_string).toBe('c')
  })

  it('returns null for empty / pre-field noise', () => {
    expect(extractPartialEditArgs('')).toBeNull()
    expect(extractPartialEditArgs('{')).toBeNull()
  })

  it('extracts fields from incomplete JSON that does not end with a brace', () => {
    const mid = '{"path":"src/app.ts","diff":"@@\\n+hello world'
    expect(mid.trimEnd().endsWith('}')).toBe(false)
    const args = extractPartialEditArgs(mid)
    expect(args?.path).toBe('src/app.ts')
    expect(args?.diff).toBe('@@\n+hello world')
  })
})

describe('extractPartialEditsArray', () => {
  it('keeps completed edits and the trailing incomplete object', () => {
    const raw =
      '{"edits":[{"path":"a.ts","diff":"@@\\n+a\\n"},{"path":"b.ts","diff":"@@\\n+b'
    const edits = extractPartialEditsArray(raw)
    expect(edits).toHaveLength(2)
    expect(edits[0]).toEqual({ path: 'a.ts', diff: '@@\n+a\n' })
    expect(edits[1]?.path).toBe('b.ts')
    expect(edits[1]?.diff).toBe('@@\n+b')
  })
})
