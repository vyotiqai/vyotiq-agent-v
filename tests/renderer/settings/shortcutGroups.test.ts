/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { INSPECTOR_TAB_SHORTCUTS, WORKSPACE_SWITCH_IDS } from '@renderer/lib/shortcuts/bindings'
import { referenceShortcutCatalog, shortcutCatalog } from '@renderer/lib/shortcuts/labels'
import { chordKeys, shortcutGroups } from '@renderer/features/settings/utils/shortcutGroups'

afterEach(() => {
  // @ts-expect-error test cleanup
  delete window.vyotiq
})

describe('shortcutGroups', () => {
  it('places every chord in exactly one named group', () => {
    // Ranged chords are listed as one row each (Ctrl 1–9, Alt 1–3, Alt 4–6).
    const rangedIds = new Set<string>([...WORKSPACE_SWITCH_IDS, ...INSPECTOR_TAB_SHORTCUTS])
    const rangeRows = new Set(['workspaces', 'inspector-tabs-1', 'inspector-tabs-2'])
    const expected = [...shortcutCatalog(), ...referenceShortcutCatalog()]
      .map((entry) => entry.id)
      .filter((id) => !rangedIds.has(id))
    const groups = shortcutGroups()
    const listed = groups.flatMap((group) => group.entries.map((entry) => entry.id))

    // A new binding lands in "Other" until someone gives it a real group.
    expect(groups.map((group) => group.title)).toEqual(['Go', 'Task', 'Inspector', 'Panels', 'Text size'])
    expect(new Set(listed).size).toBe(listed.length)
    expect(listed.filter((id) => !rangeRows.has(id)).sort()).toEqual([...expected].sort())
  })

  it('reads the six inspector tabs as the two rows the strip is read in', () => {
    // @ts-expect-error test bridge
    window.vyotiq = { platform: 'win32' }
    const inspector = shortcutGroups().find((group) => group.title === 'Inspector')
    expect(inspector?.entries).toEqual([
      { id: 'inspector', title: 'Show / hide the inspector', label: 'Ctrl+I' },
      { id: 'inspector-tabs-1', title: 'Changes · Files · Terminal', label: 'Alt+1–3' },
      { id: 'inspector-tabs-2', title: 'Browser · PR · Plan', label: 'Alt+4–6' },
      { id: 'inspectorExpand', title: 'Expand the inspector to full width', label: 'Ctrl+Shift+I' }
    ])
  })

  it('labels the inspector tab ranges with ⌥ on darwin', () => {
    // @ts-expect-error test bridge
    window.vyotiq = { platform: 'darwin' }
    const labels = shortcutGroups()
      .flatMap((group) => group.entries)
      .filter((entry) => entry.id.startsWith('inspector-tabs'))
      .map((entry) => entry.label)
    expect(labels).toEqual(['⌥1–3', '⌥4–6'])
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

describe('chordKeys', () => {
  it('splits a joined chord into one keycap per key', () => {
    expect(chordKeys('Ctrl+K')).toEqual(['Ctrl', 'K'])
    expect(chordKeys('Ctrl+Shift+H')).toEqual(['Ctrl', 'Shift', 'H'])
    expect(chordKeys('Alt+1–3')).toEqual(['Alt', '1–3'])
    expect(chordKeys('Ctrl+-')).toEqual(['Ctrl', '-'])
  })

  it("splits macOS's run-together modifiers", () => {
    expect(chordKeys('⌘K')).toEqual(['⌘', 'K'])
    expect(chordKeys('⌘⇧H')).toEqual(['⌘', '⇧', 'H'])
    expect(chordKeys('⌥1–3')).toEqual(['⌥', '1–3'])
    expect(chordKeys('⌘=')).toEqual(['⌘', '='])
  })

  it('keeps a plus key and a lone key whole', () => {
    expect(chordKeys('Ctrl++')).toEqual(['Ctrl', '+'])
    expect(chordKeys('⌘+')).toEqual(['⌘', '+'])
    expect(chordKeys('+')).toEqual(['+'])
    expect(chordKeys('End')).toEqual(['End'])
    expect(chordKeys('↑')).toEqual(['↑'])
    expect(chordKeys('Esc')).toEqual(['Esc'])
  })
})
