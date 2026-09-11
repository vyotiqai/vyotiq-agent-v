export type ReleaseNotesSection = {
  heading: string
  items: string[]
}

/**
 * Parse a GitHub release body into structured sections, mirroring the desktop
 * app's parser (src/shared/utils/releaseNotes.ts): `## Heading` lines open a
 * section and `- ` lines become its items. Bodies without headings collapse
 * into one heading-less section.
 */
export function parseReleaseNotesSections(body: string): ReleaseNotesSection[] {
  const sections: ReleaseNotesSection[] = []
  let current: ReleaseNotesSection | null = null
  let sawHeading = false
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) {
      sawHeading = true
      current = { heading: heading[1].trim(), items: [] }
      sections.push(current)
      continue
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line)
    if (bullet) {
      if (!current) {
        current = { heading: '', items: [] }
        sections.push(current)
      }
      current.items.push(bullet[1].trim())
    }
  }

  if (!sawHeading && sections.length > 0) {
    return [{ heading: '', items: sections.flatMap((section) => section.items) }]
  }
  return sections.filter((section) => section.heading || section.items.length > 0)
}
