import { describe, expect, it } from 'vitest'
import { firstLinePreview } from '@renderer/features/chat/utils/firstLinePreview'

describe('firstLinePreview', () => {
  it('returns the first non-empty line with collapsed whitespace', () => {
    expect(firstLinePreview('  hello   world\nsecond')).toBe('hello world')
  })

  it('truncates long lines at a word boundary', () => {
    const long = `${'alpha '.repeat(30).trim()} beta`
    const preview = firstLinePreview(long, 40)
    expect(preview.endsWith('…')).toBe(true)
    expect(preview.length).toBeLessThanOrEqual(41)
  })
})
