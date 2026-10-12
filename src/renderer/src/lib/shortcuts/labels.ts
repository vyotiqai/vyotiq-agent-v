import { SHORTCUT_BINDINGS, type ShortcutId } from './bindings'
import { getBinding } from './registry'

function isDarwin(): boolean {
  return typeof window !== 'undefined' && window.vyotiq?.platform === 'darwin'
}

/** Keys whose `KeyboardEvent.key` is a word: the keycap a person reads instead. */
const KEY_GLYPHS: Record<string, string> = {
  escape: 'Esc',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '↵',
  backspace: '⌫',
  delete: 'Del',
  tab: 'Tab',
  ' ': 'Space',
  space: 'Space',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  insert: 'Ins'
}

/** One key as its keycap: a glyph or a short word, never `ARROWLEFT`. */
export function keyGlyph(key: string): string {
  const lower = key.toLowerCase()
  const glyph = KEY_GLYPHS[lower]
  if (glyph) return lower === 'tab' && isDarwin() ? '⇥' : glyph
  // F1–F12 and single characters read as typed, upper-cased.
  return key.length === 1 || /^f\d{1,2}$/i.test(key) ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1)
}

function modPrefix(): string {
  return isDarwin() ? '⌘' : 'Ctrl+'
}

/** `Alt+A` — `⌥A` on macOS. */
export function altChordLabel(key: string): string {
  return isDarwin() ? `⌥${keyGlyph(key)}` : `Alt+${keyGlyph(key)}`
}

/** Platform-correct label for a shortcut (Darwin `⌘K` vs `Ctrl+K`). */
export function shortcutLabel(id: ShortcutId): string {
  const binding = getBinding(id)
  const glyph = keyGlyph(binding.key)
  if (binding.alt) return isDarwin() ? `⌥${glyph}` : `Alt+${glyph}`
  if (!binding.mod) return binding.shift === 'require' ? (isDarwin() ? `⇧${glyph}` : `Shift+${glyph}`) : glyph
  const shift = binding.shift === 'require'
  if (isDarwin()) return shift ? `⌘⇧${glyph}` : `⌘${glyph}`
  return shift ? `Ctrl+Shift+${glyph}` : `Ctrl+${glyph}`
}

export const SHORTCUT_TITLES: Record<ShortcutId, string> = {
  sidebar: 'Show / hide navigator',
  search: 'Search and commands',
  nextNeedsYou: 'Next task that needs you',
  prevTask: 'Previous task in the list',
  nextTask: 'Next task in the list',
  navBack: 'Back',
  navForward: 'Forward',
  newChat: 'New task',
  goHome: 'Home',
  settings: 'Settings',
  focusComposer: 'Focus the instruction line',
  stop: 'Stop the run',
  find: 'Find in this view',
  refresh: 'Refresh changes or PR',
  dictation: 'Dictation',
  cycleMode: 'Switch Ask / Agent mode',
  panelTerminal: 'Terminal panel',
  panelChanges: 'Changes panel',
  panelBrowser: 'Browser panel',
  panelFiles: 'Files panel',
  panelPlan: 'Plan panel',
  panelPr: 'Pull request panel',
  closeChat: 'Close task tab',
  splitPane: 'Open a second task pane',
  findInFiles: 'Find in files',
  commandPalette: 'Search (second chord)',
  shortcutsHelp: 'Show keyboard shortcuts',
  workspace1: 'Switch to workspace 1',
  workspace2: 'Switch to workspace 2',
  workspace3: 'Switch to workspace 3',
  workspace4: 'Switch to workspace 4',
  workspace5: 'Switch to workspace 5',
  workspace6: 'Switch to workspace 6',
  workspace7: 'Switch to workspace 7',
  workspace8: 'Switch to workspace 8',
  workspace9: 'Switch to workspace 9',
  inspector: 'Show / hide the inspector',
  inspectorExpand: 'Expand the inspector to full width',
  inspectorTab1: 'Inspector: Changes',
  inspectorTab2: 'Inspector: Files',
  inspectorTab3: 'Inspector: Terminal',
  inspectorTab4: 'Inspector: Browser',
  inspectorTab5: 'Inspector: PR',
  inspectorTab6: 'Inspector: Plan'
}

export type ShortcutCatalogEntry = {
  id: string
  title: string
  label: string
}

/** Chords that exist in the app but are not in SHORTCUT_BINDINGS. */
function extraShortcutCatalog(): ShortcutCatalogEntry[] {
  return [
    { id: 'jump-latest', title: 'Jump to latest', label: 'End' },
    { id: 'jump-top', title: 'Jump to top', label: 'Home' }
  ]
}

/**
 * Chords handled where they apply — the composer, the app's text-size
 * listener — with no command behind them. Settings → Shortcuts lists them so
 * they can be found at all; the command palette must not, because picking one
 * there would dispatch an id nothing listens for.
 */
export function referenceShortcutCatalog(): ShortcutCatalogEntry[] {
  const mod = modPrefix()
  return [
    { id: 'edit-last', title: 'Edit last instruction (empty instruction line)', label: '↑' },
    { id: 'steer', title: 'Send an instruction now, while a run is live', label: isDarwin() ? '⇧↵' : 'Shift+Enter' },
    { id: 'structure', title: 'Structure the instruction into a brief', label: isDarwin() ? '⌘⇧↵' : 'Ctrl+Shift+Enter' },
    { id: 'approval-allow', title: 'Allow the pending approval once', label: altChordLabel('a') },
    { id: 'approval-deny', title: 'Deny the pending approval', label: altChordLabel('d') },
    { id: 'font-smaller', title: 'Smaller text', label: `${mod}-` },
    { id: 'font-larger', title: 'Larger text', label: `${mod}=` },
    { id: 'font-reset', title: 'Reset text size', label: `${mod}0` },
    { id: 'shortcuts-help-key', title: 'Show keyboard shortcuts, outside a text field', label: '?' }
  ]
}

export function shortcutCatalog(): ShortcutCatalogEntry[] {
  const ids = Object.keys(SHORTCUT_BINDINGS) as ShortcutId[]
  return [
    ...ids.map((id) => ({
      id,
      title: SHORTCUT_TITLES[id],
      label: shortcutLabel(id)
    })),
    ...extraShortcutCatalog()
  ]
}
