import type { ReleaseNotesSection } from '../ipc/schemas/updater'

export interface ParsedReleaseNotes {
  /** Plain-text fallback: HTML-stripped, whitespace-normalized release body. */
  notesText: string
  /** `## Heading` groups with their `- ` bullets; heading '' when none. */
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

/**
 * Parse electron-updater release notes into structured sections.
 *
 * Accepts a plain markdown string or an array of notes (string or
 * `{ version, note }` entries). `## ` headings open a section; `- ` lines
 * become its items. When no headings exist, all bullets land in one section
 * with heading ''. Non-heading, non-bullet lines only shape `notesText`.
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
  const notesText = stripHtml(parts.join('\n\n')).trim()

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
