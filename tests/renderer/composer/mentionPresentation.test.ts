/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { buildRootMentionItems } from '@renderer/features/chat/components/composer/mentionModel'
import {
  buildMentionRootSections,
  mentionItemSection
} from '@renderer/features/chat/components/composer/mentionPresentation'

describe('mentionPresentation', () => {
  it('groups root items into Context / Files / Browse with flat indices', () => {
    const items = buildRootMentionItems({
      query: '',
      recentFiles: ['src/a.ts', 'src/b.ts'],
      matchingFiles: [],
      includeCodebase: true,
      branchName: 'main'
    })
    const sections = buildMentionRootSections(items)
    expect(sections.map((s) => s.id)).toEqual(['context', 'files', 'browse'])
    expect(sections[0]!.entries.every((e) => mentionItemSection(e.item) === 'context')).toBe(
      true
    )
    expect(sections[1]!.entries.every((e) => e.item.kind === 'file')).toBe(true)
    expect(sections[2]!.entries.every((e) => e.item.kind === 'nav')).toBe(true)

    const flat = sections.flatMap((s) => s.entries.map((e) => e.flatIndex))
    expect(flat).toEqual([...Array(items.length).keys()])
  })

  it('omits empty sections when filtered', () => {
    const items = buildRootMentionItems({
      query: 'branch',
      recentFiles: ['src/a.ts'],
      matchingFiles: [],
      includeCodebase: true
    })
    const sections = buildMentionRootSections(items)
    expect(sections).toHaveLength(1)
    expect(sections[0]!.id).toBe('context')
    expect(sections[0]!.entries).toHaveLength(1)
  })
})
