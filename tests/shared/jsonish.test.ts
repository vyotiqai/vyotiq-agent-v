import { describe, expect, it } from 'vitest'
import {
  closeUnterminatedJson,
  completeJsonPrefix,
  duplicateTopLevelJsonKeyError,
  parseJsonish,
  topLevelDuplicateJsonKeys
} from '@shared/utils/jsonish'

describe('completeJsonPrefix', () => {
  it('returns the first complete value when trailing junk follows', () => {
    expect(completeJsonPrefix('{"path":"a.ts"}}')).toBe('{"path":"a.ts"}')
    expect(completeJsonPrefix('[{"id":"q1"}]}')).toBe('[{"id":"q1"}]')
  })

  it('returns null when the value is already complete or still open', () => {
    expect(completeJsonPrefix('{"path":"a.ts"}')).toBeNull()
    expect(completeJsonPrefix('[{"id":"q1"}')).toBeNull()
  })
})

describe('closeUnterminatedJson', () => {
  it('closes a missing array bracket after a complete object', () => {
    const open = '[{"id":"q1","prompt":"Ready?","type":"text"}'
    expect(closeUnterminatedJson(open)).toBe(`${open}]`)
  })

  it('refuses salvage when EOF is inside a string', () => {
    expect(closeUnterminatedJson('[{"id":"q1","prompt":"Hel')).toBeNull()
  })

  it('refuses salvage after a colon or comma', () => {
    expect(closeUnterminatedJson('{"a":')).toBeNull()
    expect(closeUnterminatedJson('[{"id":"q1"},')).toBeNull()
  })
})

describe('parseJsonish', () => {
  it('parses valid JSON', () => {
    expect(parseJsonish('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonish('[1,2]')).toEqual([1, 2])
  })

  it('drops trailing junk after a complete value', () => {
    expect(parseJsonish('[{"id":"q1"}]}')).toEqual([{ id: 'q1' }])
  })

  it('closes an unclosed questions array (live 0898dc11 shape)', () => {
    const items = [
      { id: 'purpose', prompt: 'What task?', type: 'text' },
      { id: 'placement', prompt: 'Where?', type: 'single', options: ['A', 'B'] }
    ]
    const unclosed = JSON.stringify(items).slice(0, -1)
    expect(parseJsonish(unclosed)).toEqual(items)
  })

  it('unwraps double-encoded JSON once', () => {
    const items = [{ id: 'q1', prompt: 'Ready?', type: 'text' }]
    expect(parseJsonish(JSON.stringify(JSON.stringify(items)))).toEqual(items)
  })

  it('returns undefined for unescaped-quote garbage', () => {
    const malformed =
      '[{"id": "how_open", "prompt": "How?", "type": "single", "options": ["A VS Code "Live Server" or similar", "Other"]}]'
    expect(parseJsonish(malformed)).toBeUndefined()
  })
})

describe('topLevelDuplicateJsonKeys', () => {
  it('lists both values when a top-level path key is repeated', () => {
    const raw =
      '{"path":"murmur-youtube-main/windows/global.json","path":"murmur-youtube-main/windows/Directory.Build.props"}'
    expect(JSON.parse(raw)).toEqual({
      path: 'murmur-youtube-main/windows/Directory.Build.props'
    })
    expect(topLevelDuplicateJsonKeys(raw)).toEqual([
      {
        key: 'path',
        values: [
          'murmur-youtube-main/windows/global.json',
          'murmur-youtube-main/windows/Directory.Build.props'
        ]
      }
    ])
    expect(duplicateTopLevelJsonKeyError(raw)).toMatch(
      /global\.json" and "murmur-youtube-main\/windows\/Directory\.Build\.props"/
    )
    expect(duplicateTopLevelJsonKeyError(raw)).toMatch(/Call the tool once per file/)
  })

  it('ignores unique keys and nested path keys', () => {
    expect(topLevelDuplicateJsonKeys('{"path":"a.ts","offset":1}')).toEqual([])
    expect(
      topLevelDuplicateJsonKeys(
        '{"edits":[{"path":"a.ts","contents":"x"},{"path":"b.ts","contents":"y"}]}'
      )
    ).toEqual([])
    expect(duplicateTopLevelJsonKeyError('{"path":"a.ts"}')).toBeNull()
  })
})
