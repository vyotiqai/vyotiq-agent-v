/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WORKSPACE_SWITCH_IDS } from '@renderer/lib/shortcuts/bindings'
import { referenceShortcutCatalog, shortcutCatalog } from '@renderer/lib/shortcuts/labels'
import { shortcutGroups } from '@renderer/features/settings/utils/shortcutGroups'

afterEach(() => {
  // @ts-expect-error test cleanup
  delete window.vyotiq
})

describe('shortcutGroups', () => {
  it('places every chord in exactly one named group', () => {
    const workspaceIds = new Set<string>(WORKSPACE_SWITCH_IDS)
    const expected = [...shortcutCatalog(), ...referenceShortcutCatalog()]
      .map((entry) => entry.id)
      .filter((id) => !workspaceIds.has(id))
    const groups = shortcutGroups()
    const listed = groups.flatMap((group) => group.entries.map((entry) => entry.id))

    // A new binding lands in "Other" until someone gives it a real group.
    expect(groups.map((group) => group.title)).toEqual(['Go', 'Task', 'Panels', 'Text size'])
    expect(new Set(listed).size).toBe(listed.length)
    expect(listed.filter((id) => id !== 'workspaces').sort()).toEqual([...expected].sort())
  })

  it('folds the nine workspace chords into one row', () => {
    // @ts-expect-error test bridge
    window.vyotiq = { platform: 'win32' }
    const all = shortcutGroups().flatMap((group) => group.entries)
    expect(all.filter((entry) => entry.id.startsWith('workspace'))).toEqual([
      { id: 'workspaces', title: 'Switch to workspace 1–9', label: 'Ctrl+1–9' }
    ])
  })

  it('labels the workspace range with ⌘ on darwin', () => {
    // @ts-expect-error test bridge
    window.vyotiq = { platform: 'darwin' }
    const row = shortcutGroups()
      .flatMap((group) => group.entries)
      .find((entry) => entry.id === 'workspaces')
    expect(row?.label).toBe('⌘1–9')
  })
})
