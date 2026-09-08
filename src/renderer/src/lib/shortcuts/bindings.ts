/** App / panel shortcut identifiers. */
export type ShortcutId =
  | 'sidebar'
  | 'search'
  | 'newChat'
  | 'goHome'
  | 'settings'
  | 'focusComposer'
  | 'stop'
  | 'find'
  | 'refresh'
  | 'dictation'
  | 'cycleMode'
  | 'panelTerminal'
  | 'panelChanges'
  | 'panelBrowser'
  | 'panelFiles'
  | 'panelPlan'
  | 'panelPr'
  | 'closeChat'
  | 'findInFiles'
  | 'commandPalette'
  | 'workspace1'
  | 'workspace2'
  | 'workspace3'
  | 'workspace4'
  | 'workspace5'
  | 'workspace6'
  | 'workspace7'
  | 'workspace8'
  | 'workspace9'

export type ShortcutShift = 'forbid' | 'allow' | 'require'

export type ShortcutBinding = {
  id: ShortcutId
  /** Normalized key (`e.key.toLowerCase()`). */
  key: string
  /** Requires Cmd (macOS) or Ctrl. */
  mod: boolean
  /** Mod chords default to forbidding Shift. */
  shift?: ShortcutShift
}

export const SHORTCUT_BINDINGS: Record<ShortcutId, ShortcutBinding> = {
  sidebar: { id: 'sidebar', key: 'b', mod: true },
  search: { id: 'search', key: 'k', mod: true },
  newChat: { id: 'newChat', key: 'n', mod: true },
  // Shift required: ⌘H alone hides the app on macOS.
  goHome: { id: 'goHome', key: 'h', mod: true, shift: 'require' },
  settings: { id: 'settings', key: ',', mod: true },
  focusComposer: { id: 'focusComposer', key: 'l', mod: true },
  stop: { id: 'stop', key: 'escape', mod: false },
  find: { id: 'find', key: 'f', mod: true },
  refresh: { id: 'refresh', key: 'r', mod: true },
  dictation: { id: 'dictation', key: 'm', mod: true },
  cycleMode: { id: 'cycleMode', key: '.', mod: true, shift: 'allow' },
  panelTerminal: { id: 'panelTerminal', key: '`', mod: true },
  panelChanges: { id: 'panelChanges', key: 'e', mod: true },
  panelBrowser: { id: 'panelBrowser', key: 'b', mod: true, shift: 'require' },
  panelFiles: { id: 'panelFiles', key: 'e', mod: true, shift: 'require' },
  panelPlan: { id: 'panelPlan', key: 'd', mod: true, shift: 'require' },
  panelPr: { id: 'panelPr', key: 'g', mod: true, shift: 'require' },
  closeChat: { id: 'closeChat', key: 'w', mod: true },
  findInFiles: { id: 'findInFiles', key: 'f', mod: true, shift: 'require' },
  commandPalette: { id: 'commandPalette', key: 'p', mod: true, shift: 'require' },
  workspace1: { id: 'workspace1', key: '1', mod: true },
  workspace2: { id: 'workspace2', key: '2', mod: true },
  workspace3: { id: 'workspace3', key: '3', mod: true },
  workspace4: { id: 'workspace4', key: '4', mod: true },
  workspace5: { id: 'workspace5', key: '5', mod: true },
  workspace6: { id: 'workspace6', key: '6', mod: true },
  workspace7: { id: 'workspace7', key: '7', mod: true },
  workspace8: { id: 'workspace8', key: '8', mod: true },
  workspace9: { id: 'workspace9', key: '9', mod: true }
}

/** Ctrl/Cmd+1..9 — index into the sidebar's open-workspace order. */
export const WORKSPACE_SWITCH_IDS = [
  'workspace1',
  'workspace2',
  'workspace3',
  'workspace4',
  'workspace5',
  'workspace6',
  'workspace7',
  'workspace8',
  'workspace9'
] as const
