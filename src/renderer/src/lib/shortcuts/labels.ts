import { SHORTCUT_BINDINGS, type ShortcutId } from './bindings'

function isDarwin(): boolean {
  return typeof window !== 'undefined' && window.vyotiq?.platform === 'darwin'
}

function keyGlyph(key: string): string {
  if (key === 'escape') return 'Esc'
  if (key === ',') return ','
  return key.toUpperCase()
}

function modPrefix(): string {
  return isDarwin() ? '⌘' : 'Ctrl+'
}

/** `Alt+A` — `⌥A` on macOS. */
export function altChordLabel(key: string): string {
  return isDarwin() ? `⌥${key.toUpperCase()}` : `Alt+${key.toUpperCase()}`
}

/** Platform-correct label for a shortcut (Darwin `⌘K` vs `Ctrl+K`). */
export function shortcutLabel(id: ShortcutId): string {
  const binding = SHORTCUT_BINDINGS[id]
  const glyph = keyGlyph(binding.key)
  if (binding.alt) return isDarwin() ? `⌥${glyph}` : `Alt+${glyph}`
  if (!binding.mod) return glyph
  const shift = binding.shift === 'require'
  if (isDarwin()) return shift ? `⌘⇧${glyph}` : `⌘${glyph}`
  return shift ? `Ctrl+Shift+${glyph}` : `Ctrl+${glyph}`
}

/**
 * `aria-keyshortcuts` form of a chord (`Control+Shift+E`), which is a fixed
 * WAI-ARIA syntax rather than the platform label a reader sees: assistive tech
 * announces the chord from this, so a control that shows one in its tooltip
 * must carry the same one here.
 */
export function shortcutAriaKeys(id: ShortcutId): string {
  const binding = SHORTCUT_BINDINGS[id]
  const parts: string[] = []
  if (binding.alt) parts.push('Alt')
  if (binding.mod) parts.push(isDarwin() ? 'Meta' : 'Control')
  if (binding.shift === 'require') parts.push('Shift')
  parts.push(binding.key === 'escape' ? 'Escape' : binding.key.toUpperCase())
  return parts.join('+')
}

export const SHORTCUT_TITLES: Record<ShortcutId, string> = {
  sidebar: 'Show / hide navigator',
  search: 'Search and commands',
  nextNeedsYou: 'Next task that needs you',
  newChat: 'New task',
  goHome: 'Home',
  settings: 'Settings',
  focusComposer: 'Focus the instruction line',
  stop: 'Stop the run',
  find: 'Find in transcript, changes, or PR',
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
  commandPalette: 'Search and commands (alternate)',
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
export function extraShortcutCatalog(): ShortcutCatalogEntry[] {
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
    { id: 'edit-last', title: 'Edit last prompt (empty composer)', label: '↑' },
    { id: 'approval-allow', title: 'Allow the pending approval once', label: altChordLabel('a') },
    { id: 'approval-deny', title: 'Deny the pending approval', label: altChordLabel('d') },
    { id: 'font-smaller', title: 'Smaller text', label: `${mod}-` },
    { id: 'font-larger', title: 'Larger text', label: `${mod}=` },
    { id: 'font-reset', title: 'Reset text size', label: `${mod}0` }
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
