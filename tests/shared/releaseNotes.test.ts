import { describe, expect, it } from 'vitest'
import { parseReleaseNotes, stripHtml } from '../../src/shared/utils/releaseNotes'

describe('stripHtml', () => {
  it('removes tags, converts breaks, and decodes entities', () => {
    expect(stripHtml('<p>Hello</p>&amp; <b>world</b>')).toBe('Hello\n& world')
    expect(stripHtml('a<br>b<br/>c')).toBe('a\nb\nc')
    expect(stripHtml('&lt;script&gt; &quot;q&quot; &#39;x&#39; &nbsp;')).toBe(
      '<script> "q" \'x\'  '
    )
  })
})

describe('parseReleaseNotes', () => {
  it('groups ## headings with their - bullets', () => {
    const parsed = parseReleaseNotes(
      '## Fixed\n- Crash on save\n- Wrong icon\n## Added\n- Pinned chats'
    )
    expect(parsed.notesText).toBe(
      '## Fixed\n- Crash on save\n- Wrong icon\n## Added\n- Pinned chats'
    )
    expect(parsed.notesSections).toEqual([
      { heading: 'Fixed', items: ['Crash on save', 'Wrong icon'] },
      { heading: 'Added', items: ['Pinned chats'] }
    ])
  })

  it('uses one heading-less section when the body has no ## headings', () => {
    const parsed = parseReleaseNotes('Intro text.\n- one\n- two\n- three')
    expect(parsed.notesSections).toEqual([
      { heading: '', items: ['one', 'two', 'three'] }
    ])
    expect(parsed.notesText).toContain('Intro text.')
  })

  it('keeps a plain notesText fallback for bullet-less bodies', () => {
    const parsed = parseReleaseNotes('Just text.\nNo bullets here.')
    expect(parsed.notesSections).toEqual([])
    expect(parsed.notesText).toBe('Just text.\nNo bullets here.')
  })

  it('strips HTML and still parses bullets from the cleaned body', () => {
    const parsed = parseReleaseNotes('<p>## Fixed</p><ul><li>- Crash</li></ul><br>')
    expect(parsed.notesText).toBe('## Fixed\n- Crash')
    expect(parsed.notesSections).toEqual([
      { heading: 'Fixed', items: ['Crash'] }
    ])
  })

  it('accepts arrays of notes including {version, note} entries', () => {
    const parsed = parseReleaseNotes([
      '## A\n- alpha',
      { version: '1.2.0', note: '- beta' },
      '- gamma'
    ])
    // Trailing bullets group under the last seen heading.
    expect(parsed.notesSections).toEqual([
      { heading: 'A', items: ['alpha'] },
      { heading: '1.2.0', items: ['beta', 'gamma'] }
    ])
  })

  it('merges bullets into one section for heading-less string arrays', () => {
    const parsed = parseReleaseNotes(['- a', '- b'])
    expect(parsed.notesSections).toEqual([{ heading: '', items: ['a', 'b'] }])
  })

  it('handles null/undefined', () => {
    expect(parseReleaseNotes(null)).toEqual({ notesText: '', notesSections: [] })
    expect(parseReleaseNotes(undefined)).toEqual({ notesText: '', notesSections: [] })
  })

  it('trims bullet and heading whitespace', () => {
    const parsed = parseReleaseNotes('##   Fixed  \n  -   Crash  ')
    expect(parsed.notesSections).toEqual([{ heading: 'Fixed', items: ['Crash'] }])
  })
})
