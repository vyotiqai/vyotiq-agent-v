import type { ShortcutId } from '@renderer/lib/shortcuts'
import type { ChatRightPanelId } from './layout'

/**
 * Chord that toggles each panel.
 *
 * A `Record` over the closed panel union, not a `Partial`: every panel the
 * dock can open must name the chord that opens it, and ChatView derives its
 * key handling from this table. Files / Plan / Pull request previously had
 * bindings that the Shortcuts settings page and the command palette both
 * advertised while nothing in the app listened for them.
 */
export const PANEL_SHORTCUT: Record<ChatRightPanelId, ShortcutId> = {
  files: 'panelFiles',
  browser: 'panelBrowser',
  terminal: 'panelTerminal',
  changes: 'panelChanges',
  pr: 'panelPr',
  plan: 'panelPlan'
}
