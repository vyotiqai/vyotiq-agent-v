import type { MentionMenuItem } from './mentionModel'

/** Root @-menu category order (matches `buildRootMentionItems` banding). */
export const MENTION_SECTION_ORDER = ['context', 'files', 'browse'] as const

export type MentionSectionId = (typeof MENTION_SECTION_ORDER)[number]

const SECTION_LABEL: Record<MentionSectionId, string> = {
  context: 'Context',
  files: 'Files',
  browse: 'Browse'
}

export function mentionSectionLabel(id: MentionSectionId): string {
  return SECTION_LABEL[id]
}

/** Map a root-list item to its category. Subview-only kinds return null. */
export function mentionItemSection(item: MentionMenuItem): MentionSectionId | null {
  switch (item.kind) {
    case 'branch':
    case 'browser':
    case 'lints':
      return 'context'
    case 'file':
      return 'files'
    case 'nav':
      return 'browse'
    case 'docs':
    case 'rule':
    case 'chat':
    case 'show-more':
      return null
    default: {
      const _exhaustive: never = item
      return _exhaustive
    }
  }
}

export type MentionMenuSection = {
  id: MentionSectionId
  label: string
  entries: Array<{ item: MentionMenuItem; flatIndex: number }>
}

/**
 * Group a flat root mention list into Context / Files / Browse sections.
 * Preserves flat indices for keyboard selection.
 */
export function buildMentionRootSections(items: MentionMenuItem[]): MentionMenuSection[] {
  const buckets = new Map<MentionSectionId, MentionMenuSection['entries']>()
  for (const id of MENTION_SECTION_ORDER) buckets.set(id, [])

  items.forEach((item, flatIndex) => {
    const section = mentionItemSection(item)
    if (!section) return
    buckets.get(section)!.push({ item, flatIndex })
  })

  const out: MentionMenuSection[] = []
  for (const id of MENTION_SECTION_ORDER) {
    const entries = buckets.get(id)!
    if (!entries.length) continue
    out.push({ id, label: mentionSectionLabel(id), entries })
  }
  return out
}
