import type { ReleaseNotesSection } from '../ipc/schemas/updater'

export interface ParsedReleaseNotes {
  /** Plain-text fallback: HTML-stripped, whitespace-normalized release body. */
  notesText: string
  /**
   * `## Heading` groups with their `- ` bullets; heading '' when none. An item
   * keeps its bold lead as `**lead**` — see `releaseNoteParts`.
   */
  notesSections: ReleaseNotesSection[]
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' '
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (entity, code: string) => codePoint(Number.parseInt(code, 10)) ?? entity)
    .replace(/&#x([0-9a-f]+);/gi, (entity, code: string) => codePoint(Number.parseInt(code, 16)) ?? entity)
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (entity) => HTML_ENTITIES[entity] ?? entity)
}

function codePoint(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return null
  return String.fromCodePoint(value)
}

/** Strip HTML tags (electron-updater may deliver HTML bodies), decoding the common entities. */
export function stripHtml(input: string): string {
  const withBreaks = input
    .replace(/\r\n/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
  return withBreaks.replace(/<[^>]*>/g, '').replace(
    /&(?:amp|lt|gt|quot|apos|nbsp|#39);/g,
    (entity) => HTML_ENTITIES[entity] ?? entity
  )
}

/** A body GitHub rendered: what electron-updater reads out of the releases Atom feed. */
const RENDERED_HTML = /<(?:h[1-6]|p|ul|ol|li)\b[^>]*>/i

/** One block's text on one line, a bold run kept as `**bold**`; tags dropped, entities left for the end. */
function inlineText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag: string, inner: string) => {
      const bold = inner.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
      return bold ? `**${bold}**` : ''
    })
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The release body is written as `## ` headings over `- **Lead.** rest`
 * bullets, but GitHub's Atom feed carries it rendered — `<h2>`, `<li>`,
 * `<strong>` — and that is what electron-updater hands over. Read it back into
 * the lines it was written as, so one parser serves both.
 */
function renderedToLines(html: string): string {
  const lines = html
    .replace(/\r\n/g, '\n')
    .replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_match, inner: string) => `\n## ${inlineText(inner)}\n`)
    // A loose list wraps each item in <p>; the item is still one bullet.
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, inner: string) => {
      const text = inlineText(inner).replace(/^[-*]\s+/, '')
      return text ? `\n- ${text}\n` : '\n'
    })
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_match, inner: string) => `\n${inlineText(inner)}\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
  return decodeEntities(lines)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * Parse electron-updater release notes into structured sections.
 *
 * Accepts a plain markdown string, the HTML GitHub renders it to, or an array
 * of notes (string or `{ version, note }` entries). `## ` headings open a
 * section; `- ` lines become its items. When no headings exist, all bullets
 * land in one section with heading ''. Non-heading, non-bullet lines only shape
 * `notesText`.
 */
export function parseReleaseNotes(
  notes:
    | string
    | Array<string | { version?: string; note?: string | null }>
    | null
    | undefined
): ParsedReleaseNotes {
  if (notes == null) return { notesText: '', notesSections: [] }
  const parts = Array.isArray(notes)
    ? notes.map((entry) => {
        if (typeof entry === 'string') return entry
        return [entry.version ? `## ${entry.version}` : '', entry.note ?? '']
          .filter(Boolean)
          .join('\n')
      })
    : [notes]
  const joined = parts.join('\n\n')
  const notesText = (RENDERED_HTML.test(joined) ? renderedToLines(joined) : stripHtml(joined)).trim()

  const sections: ReleaseNotesSection[] = []
  let sawHeading = false
  let current: ReleaseNotesSection | null = null
  for (const rawLine of notesText.split('\n')) {
    const line = rawLine.trim()
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) {
      sawHeading = true
      current = { heading: heading[1].trim(), items: [] }
      sections.push(current)
      continue
    }
    const bullet = /^-\s+(.+)$/.exec(line)
    if (bullet) {
      if (!current) {
        current = { heading: '', items: [] }
        sections.push(current)
      }
      current.items.push(bullet[1].trim())
    }
  }

  if (sawHeading) return { notesText, notesSections: sections }
  if (sections.length === 0) return { notesText, notesSections: [] }
  // No `## ` headings: one section holding every bullet line.
  return {
    notesText,
    notesSections: [{ heading: '', items: sections.flatMap((section) => section.items) }]
  }
}

function unbold(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').trim()
}

/**
 * An item's bold lead — the sentence the body opens each bullet with — and the
 * rest of it. `lead` is null for an item written without one.
 */
export function releaseNoteParts(item: string): { lead: string | null; rest: string } {
  const match = /^\*\*(.+?)\*\*\s*([\s\S]*)$/.exec(item.trim())
  if (!match) return { lead: null, rest: unbold(item) }
  return { lead: match[1]!.trim(), rest: unbold(match[2] ?? '') }
}

/** The one line to show for an item: its lead, or the item itself, without a closing full stop. */
export function releaseNoteHeadline(item: string): string {
  const { lead, rest } = releaseNoteParts(item)
  return (lead ?? rest).replace(/(?<!\.)\.$/, '')
}
