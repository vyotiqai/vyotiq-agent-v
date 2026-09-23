import { SHORTCUT_BINDINGS, WORKSPACE_SWITCH_IDS } from '@renderer/lib/shortcuts/bindings'
import {
  referenceShortcutCatalog,
  shortcutCatalog,
  shortcutLabel,
  type ShortcutCatalogEntry
} from '@renderer/lib/shortcuts/labels'

export type ShortcutGroup = {
  title: string
  entries: ShortcutCatalogEntry[]
}

/**
 * Settings → Shortcuts, grouped by what the chord acts on. The page used to
 * be one flat list of thirty-six chords with nothing to scan by, and nine of
 * its rows were "Switch to workspace N": one chord in practice, so it lists
 * as one row. Within a group, the chords people reach for most come first.
 */
const GROUPS: ReadonlyArray<{ title: string; ids: readonly string[] }> = [
  {
    title: 'Navigation',
    ids: ['commandPalette', 'search', 'newChat', 'goHome', 'sidebar', 'settings', 'workspaces']
  },
  {
    title: 'Chat',
    ids: [
      'focusComposer',
      'stop',
      'cycleMode',
      'dictation',
      'edit-last',
      'find',
      'jump-latest',
      'jump-top',
      'closeChat',
      'splitPane'
    ]
  },
  {
    title: 'Panels',
    ids: [
      'panelTerminal',
      'panelChanges',
      'panelFiles',
      'panelBrowser',
      'panelPlan',
      'panelPr',
      'findInFiles',
      'refresh'
    ]
  },
  { title: 'Text size', ids: ['font-larger', 'font-smaller', 'font-reset'] }
]

/** The nine workspace chords as one row: `Ctrl+1–9`, `⌘1–9` on macOS. */
function workspaceRange(): ShortcutCatalogEntry {
  const first = WORKSPACE_SWITCH_IDS[0]
  const last = SHORTCUT_BINDINGS[WORKSPACE_SWITCH_IDS[WORKSPACE_SWITCH_IDS.length - 1]].key
  return {
    id: 'workspaces',
    title: `Switch to workspace ${SHORTCUT_BINDINGS[first].key}–${last}`,
    label: `${shortcutLabel(first)}–${last}`
  }
}

export function shortcutGroups(): ShortcutGroup[] {
  const workspaceIds = new Set<string>(WORKSPACE_SWITCH_IDS)
  const entries = [
    ...shortcutCatalog().filter((entry) => !workspaceIds.has(entry.id)),
    workspaceRange(),
    ...referenceShortcutCatalog()
  ]
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const groups = GROUPS.map(({ title, ids }) => ({
    title,
    entries: ids.flatMap((id) => byId.get(id) ?? [])
  }))
  // A chord bound later but never placed still lists instead of vanishing
  // from Settings; the shortcuts test fails until it gets a real group.
  const placed = new Set(GROUPS.flatMap((group) => group.ids))
  const unplaced = entries.filter((entry) => !placed.has(entry.id))
  if (unplaced.length > 0) groups.push({ title: 'Other', entries: unplaced })
  return groups.filter((group) => group.entries.length > 0)
}
