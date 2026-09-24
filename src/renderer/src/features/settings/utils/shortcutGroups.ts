import { INSPECTOR_TAB_SHORTCUTS, SHORTCUT_BINDINGS, WORKSPACE_SWITCH_IDS } from '@renderer/lib/shortcuts/bindings'
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
    title: 'Go',
    ids: ['search', 'newChat', 'goHome', 'nextNeedsYou', 'workspaces', 'sidebar', 'settings', 'commandPalette']
  },
  {
    title: 'Task',
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
    title: 'Inspector',
    ids: ['inspector', 'inspector-tabs-1', 'inspector-tabs-2', 'inspectorExpand']
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

/** Alt 1–3 and Alt 4–6 as the two rows the tab strip reads in. */
function inspectorTabRanges(): ShortcutCatalogEntry[] {
  const [a, , c, d, , f] = INSPECTOR_TAB_SHORTCUTS
  type TabId = (typeof INSPECTOR_TAB_SHORTCUTS)[number]
  const range = (from: TabId, to: TabId): string => `${shortcutLabel(from)}–${SHORTCUT_BINDINGS[to].key}`
  return [
    { id: 'inspector-tabs-1', title: 'Changes · Files · Terminal', label: range(a, c) },
    { id: 'inspector-tabs-2', title: 'Browser · PR · Plan', label: range(d, f) }
  ]
}

export function shortcutGroups(): ShortcutGroup[] {
  const rangedIds = new Set<string>([...WORKSPACE_SWITCH_IDS, ...INSPECTOR_TAB_SHORTCUTS])
  const entries = [
    ...shortcutCatalog().filter((entry) => !rangedIds.has(entry.id)),
    workspaceRange(),
    ...inspectorTabRanges(),
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

const MAC_MODIFIERS = new Set(['⌘', '⇧', '⌥', '⌃'])

/** A `+` joining two keys; a trailing one is the plus key itself. */
const KEY_JOIN = /\+(?=.)/

/**
 * A chord's label as keycaps: `Ctrl+Shift+H` → Ctrl · Shift · H, and macOS's
 * run-together `⌘⇧H` → ⌘ · ⇧ · H. A `+` splits only when a key follows it,
 * so `Ctrl++` and `⌘+` keep their plus key.
 */
export function chordKeys(label: string): string[] {
  if (KEY_JOIN.test(label)) return label.split(KEY_JOIN)
  const keys: string[] = []
  let rest = label
  while (rest.length > 1 && MAC_MODIFIERS.has(rest[0]!)) {
    keys.push(rest[0]!)
    rest = rest.slice(1)
  }
  keys.push(rest)
  return keys
}
