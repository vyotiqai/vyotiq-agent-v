import { describe, expect, it } from 'vitest'
import {
  parseReleaseNotes,
  releaseNoteHeadline,
  releaseNoteParts,
  stripHtml
} from '../../src/shared/utils/releaseNotes'

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


/**
 * The shape electron-updater hands over for a GitHub release: the body as the
 * releases Atom feed carries it, rendered to HTML. Taken from the v1.0.0 feed
 * entry, sentences shortened.
 */
const GITHUB_RELEASE_HTML = [
  '<p>The first stable release of Agent V, and where its version history starts.</p>',
  '<h2>Added</h2>',
  '<ul>',
  '<li><strong>Every request the browser makes now goes through one egress policy.</strong> The domain allowlist was previously enforced on navigation only.</li>',
  "<li><strong>Each run keeps a durable record of where it went.</strong> Every request the run made is written to that run's own record.</li>",
  '</ul>',
  '<h2>Known issues</h2>',
  '<ul>',
  '<li>Windows and macOS builds are unsigned. Windows SmartScreen warns on first run.</li>',
  '</ul>'
].join('\n')

describe('parseReleaseNotes on a GitHub release', () => {
  it('reads the sections back out of the rendered body', () => {
    // The old parser stripped the tags first and found no `## ` or `- ` at
    // all, so every real release showed as one undivided block of text.
    const parsed = parseReleaseNotes(GITHUB_RELEASE_HTML)
    expect(parsed.notesSections).toEqual([
      {
        heading: 'Added',
        items: [
          '**Every request the browser makes now goes through one egress policy.** The domain allowlist was previously enforced on navigation only.',
          "**Each run keeps a durable record of where it went.** Every request the run made is written to that run's own record."
        ]
      },
      {
        heading: 'Known issues',
        items: ['Windows and macOS builds are unsigned. Windows SmartScreen warns on first run.']
      }
    ])
    expect(parsed.notesText.split('\n')[0]).toBe('The first stable release of Agent V, and where its version history starts.')
  })

  it('keeps one bullet per item in a loose list', () => {
    // A blank line between bullets makes GitHub wrap each item in <p>.
    const parsed = parseReleaseNotes(
      '<h2>Security</h2>\n<ul>\n<li>\n<p><strong>A run cannot read another memory.</strong> Reads are checked.</p>\n</li>\n<li>\n<p><strong>Paths no longer reach the log.</strong></p>\n</li>\n</ul>'
    )
    expect(parsed.notesSections).toEqual([
      {
        heading: 'Security',
        items: ['**A run cannot read another memory.** Reads are checked.', '**Paths no longer reach the log.**']
      }
    ])
  })

  it('decodes entities once, after the tags are gone', () => {
    const parsed = parseReleaseNotes(
      '<h2>Fixed</h2><ul><li><code>a &amp;&amp; b</code> &lt;div&gt; &#8212; &#x2192; &amp;lt;</li></ul>'
    )
    expect(parsed.notesSections[0]?.items).toEqual(['a && b <div> — → &lt;'])
  })
})

describe('releaseNoteParts / releaseNoteHeadline', () => {
  it('splits an item into its bold lead and the rest', () => {
    expect(releaseNoteParts('**The agent can run the team itself.** It can list who exists.')).toEqual({
      lead: 'The agent can run the team itself.',
      rest: 'It can list who exists.'
    })
    expect(releaseNoteParts('Plain item with **bold** inside.')).toEqual({
      lead: null,
      rest: 'Plain item with bold inside.'
    })
  })

  it('shows the lead, or the item, without its closing full stop', () => {
    expect(releaseNoteHeadline('**The agent can run the team itself.** It can list who exists.')).toBe(
      'The agent can run the team itself'
    )
    expect(releaseNoteHeadline('Windows builds are unsigned.')).toBe('Windows builds are unsigned')
    expect(releaseNoteHeadline('**More to come...**')).toBe('More to come...')
  })
})
