import type { UpdaterStatePayload } from '@shared/ipc'
import type { ThemeId } from '@shared/theme'
import type { AppearanceSettings } from '@shared/appearance'
import { SKIN_CATALOG, type SkinId } from '@shared/skins'
import type { IconName } from '@renderer/lib/icons'
import { shortcutCatalog, shortcutLabel, type ShortcutId } from '@renderer/lib/shortcuts'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { SECTION_LABELS } from '@renderer/features/settings/constants'
import { filterSettingsSearch } from '@renderer/features/settings/settingsSearchIndex'
import { downloadUpdate, installUpdate } from '@renderer/features/updates/updaterStore'
import { requestWhatsNew } from '@renderer/features/whats-new/useWhatsNew'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { requestOpenInbox } from '@renderer/app/navigator/NotificationsRow'
import { requestScheduledTasks } from '@renderer/features/schedules/scheduleRequests'
import { openDocumentation, requestShortcutsHelp } from '@renderer/features/help/helpRequests'
import type { PaletteCommand } from './CommandPalette'

/**
 * Commands the palette offers. Each is either handled here (app-level) or
 * dispatched as `vyotiq:command`, which the surface that owns it listens for
 * (the task view's panels, find, dictation, mode). Nothing is listed that no
 * one handles.
 */

/** Opening the palette from the palette is not a command. */
const EXCLUDED = new Set<string>(['search', 'commandPalette'])

const ICON: Record<string, IconName> = {
  sidebar: 'sidebar',
  nextNeedsYou: 'hand',
  newChat: 'plus',
  goHome: 'home',
  settings: 'gear',
  focusComposer: 'enter',
  stop: 'stop',
  find: 'search',
  refresh: 'refresh',
  dictation: 'mic',
  cycleMode: 'repeat',
  panelTerminal: 'terminal',
  panelChanges: 'diff',
  panelBrowser: 'browser',
  panelFiles: 'file',
  panelPlan: 'plan',
  panelPr: 'pullRequest',
  closeChat: 'close',
  splitPane: 'columns',
  findInFiles: 'fileSearch',
  inspector: 'inspector',
  inspectorExpand: 'expand',
  'jump-latest': 'arrowDown',
  'jump-top': 'arrowUp',
  sendFeedback: 'note',
  shortcutsHelp: 'keyboard'
}

/** "Ctrl+Shift+E" → ["Ctrl", "Shift", "E"]; "⌘⇧E" stays one cap. */
export function labelToKeys(label: string): string[] {
  if (!label) return []
  if (label.length > 1 && label.endsWith('+')) return [label.slice(0, -1), '+']
  return label.split('+').filter(Boolean)
}

const THEMES: ReadonlyArray<{ id: ThemeId; label: string; icon: IconName }> = [
  { id: 'system', label: 'System', icon: 'monitor' },
  { id: 'light', label: 'Light', icon: 'sun' },
  { id: 'dark', label: 'Dark', icon: 'moon' }
]

/** Task header actions, for the task in the focused pane. */
const TASK_COMMANDS: PaletteCommand[] = [
  { id: 'renameTask', title: 'Rename task', icon: 'edit' },
  { id: 'archiveTask', title: 'Archive or unarchive task', icon: 'archive' },
  { id: 'forkTask', title: 'Fork task', icon: 'fork' },
  { id: 'toggleReasoning', title: 'Show or hide reasoning', icon: 'eye' },
  { id: 'deleteTask', title: 'Delete task…', icon: 'trash' }
]

export function paletteCommands({
  workspaces,
  activePath,
  canSendFeedback,
  canOpenExtensions = false,
  canAddWorkspace = false,
  appearance = null,
  hasTask = false,
  canImportTask = false
}: {
  workspaces: readonly string[]
  activePath: string | null
  canSendFeedback: boolean
  canOpenExtensions?: boolean
  canAddWorkspace?: boolean
  /** The theme and skin now, to mark the current ones; null hides appearance commands. */
  appearance?: { theme: ThemeId; skinId: SkinId } | null
  /** A task view is showing, so the task commands have something to act on. */
  hasTask?: boolean
  /** A workspace is active to import a task bundle into. */
  canImportTask?: boolean
}): PaletteCommand[] {
  const base: PaletteCommand[] = shortcutCatalog()
    // One tab per Alt chord would repeat the panel commands; the chords are listed in Settings.
    .filter((entry) => !EXCLUDED.has(entry.id) && !/^(workspace[1-9]|inspectorTab[1-6]|prevTask|nextTask)$/.test(entry.id))
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      icon: ICON[entry.id] ?? 'command',
      keys: labelToKeys(entry.label)
    }))

  const perWorkspace: PaletteCommand[] = []
  workspaces.slice(0, 9).forEach((path, i) => {
    const slot = i + 1
    const id = `workspace${slot}` as ShortcutId
    const current = activePath != null && workspacePathsEqual(activePath, path)
    perWorkspace.push({
      id,
      title: `Switch to ${formatWorkspaceName(path)}`,
      icon: 'workspace',
      keys: labelToKeys(shortcutLabel(id)),
      ...(current ? { hint: 'current' } : {})
    })
    perWorkspace.push({ id: `newchat${slot}`, title: `New task in ${formatWorkspaceName(path)}`, icon: 'plus' })
  })

  const extras: PaletteCommand[] = [
    { id: 'goUsage', title: 'Usage', icon: 'chart' },
    { id: 'openInbox', title: 'Inbox', icon: 'inbox' },
    { id: 'scheduledTasks', title: 'Scheduled tasks', icon: 'repeat' },
    ...(canOpenExtensions ? [{ id: 'openExtensions', title: 'Extensions', icon: 'extensions' as const }] : []),
    ...(canAddWorkspace ? [{ id: 'addWorkspace', title: 'Add workspace…', icon: 'folderPlus' as const }] : []),
    ...(canImportTask ? [{ id: 'importTask', title: 'Import task…', icon: 'upload' as const }] : []),
    { id: 'whatsNew', title: 'What’s new', icon: 'sparkles' },
    { id: 'openDocs', title: 'Open documentation', icon: 'book' },
    ...(canSendFeedback ? [{ id: 'sendFeedback', title: 'Send feedback', icon: ICON.sendFeedback }] : [])
  ]
  const look: PaletteCommand[] = appearance
    ? [
        ...THEMES.map((t) => ({
          id: `${THEME_PREFIX}${t.id}`,
          title: `Theme: ${t.label}`,
          icon: t.icon,
          ...(appearance.theme === t.id ? { hint: 'current' } : {})
        })),
        ...SKIN_CATALOG.map((skin) => ({
          id: `${SKIN_PREFIX}${skin.id}`,
          title: `Skin: ${skin.label}`,
          icon: 'star' as const,
          detail: skin.description,
          ...(appearance.skinId === skin.id ? { hint: 'current' } : {})
        }))
      ]
    : []
  return [...base, ...(hasTask ? TASK_COMMANDS : []), ...perWorkspace, ...extras, ...look]
}

/**
 * The update, when there is one to act on: the same store and the same two
 * actions as the navigator's update chip, never a check of its own.
 */
export function paletteUpdateCommands(update: UpdaterStatePayload): PaletteCommand[] {
  const version = update.info?.version
  if (!version) return []
  if (update.status === 'available') {
    return [{ id: 'downloadUpdate', title: `Download update ${version}`, icon: 'download' }]
  }
  if (update.status === 'downloaded') {
    return [{ id: 'installUpdate', title: `Install update ${version}`, icon: 'download', hint: 'restarts Agent V' }]
  }
  return []
}

const SETTINGS_PREFIX = 'settings:'
const THEME_PREFIX = 'theme:'
const SKIN_PREFIX = 'skin:'

/**
 * Settings rows that match, as commands ("Settings: Check automatically"),
 * found the way Settings' own search finds them. Only for a typed query —
 * the palette never lists every setting.
 */
export function paletteSettingsCommands(needle: string): PaletteCommand[] {
  if (!needle.trim()) return []
  return filterSettingsSearch(needle).map((entry) => ({
    id: `${SETTINGS_PREFIX}${entry.id}`,
    title: `Settings: ${entry.title}`,
    icon: 'gear',
    detail: SECTION_LABELS[entry.section]
  }))
}

export type PaletteHandlers = {
  workspaces: readonly string[]
  onOpenSettings: () => void
  onOpenHome: () => void
  onOpenUsage: () => void
  onNewTask: () => void
  onToggleNavigator: () => void
  onNextNeedsYou: () => void
  onOpenFeedback?: () => void
  onStop?: () => void
  onCloseChat?: () => void
  onSplitPane?: () => void
  onSwitchWorkspaceByIndex: (index: number) => void
  onNewChatInWorkspace?: (path: string) => void
  onFocusInstructionLine: () => void
  /** A settings row by its `data-settings-field` id. */
  onOpenSettingsField: (fieldId: string) => void
  onOpenExtensions?: () => void
  onAddWorkspace?: () => void
  /** Import task…, into the active workspace. */
  onImportTask?: () => void
  onAppearanceChange?: (partial: Partial<AppearanceSettings>) => void
}

export function runPaletteCommand(id: string, h: PaletteHandlers): void {
  if (id === 'settings') return h.onOpenSettings()
  if (id === 'goHome') return h.onOpenHome()
  if (id === 'goUsage') return h.onOpenUsage()
  if (id === 'openInbox') {
    // The Inbox on screen opens; with the list hidden there is none, so show the list, then open its.
    if (requestOpenInbox()) return
    h.onToggleNavigator()
    requestAnimationFrame(() => requestAnimationFrame(() => requestOpenInbox()))
    return
  }
  if (id === 'scheduledTasks') {
    requestScheduledTasks()
    return
  }
  if (id === 'newChat') return h.onNewTask()
  if (id === 'sidebar') return h.onToggleNavigator()
  if (id === 'nextNeedsYou') return h.onNextNeedsYou()
  if (id === 'sendFeedback') return h.onOpenFeedback?.()
  if (id === 'focusComposer') return h.onFocusInstructionLine()
  if (id === 'stop') return h.onStop?.()
  if (id === 'closeChat') return h.onCloseChat?.()
  if (id === 'splitPane') return h.onSplitPane?.()
  if (id === 'openExtensions') return h.onOpenExtensions?.()
  if (id === 'addWorkspace') return h.onAddWorkspace?.()
  if (id === 'importTask') return h.onImportTask?.()
  if (id === 'shortcutsHelp') {
    requestShortcutsHelp()
    return
  }
  if (id === 'openDocs') {
    openDocumentation()
    return
  }
  if (id === 'whatsNew') {
    requestWhatsNew()
    return
  }
  if (id.startsWith(THEME_PREFIX)) {
    const theme = id.slice(THEME_PREFIX.length)
    if (THEMES.some((t) => t.id === theme)) h.onAppearanceChange?.({ theme: theme as ThemeId })
    return
  }
  if (id.startsWith(SKIN_PREFIX)) {
    const skin = SKIN_CATALOG.find((entry) => entry.id === id.slice(SKIN_PREFIX.length))
    if (skin) h.onAppearanceChange?.({ skinId: skin.id })
    return
  }
  if (id === 'downloadUpdate') return downloadUpdate()
  if (id === 'installUpdate') return installUpdate()
  if (id.startsWith(SETTINGS_PREFIX)) return h.onOpenSettingsField(id.slice(SETTINGS_PREFIX.length))
  if (id === 'findInFiles') {
    window.dispatchEvent(new Event('vyotiq:find-in-files'))
    return
  }
  const slot = /^workspace([1-9])$/.exec(id)
  if (slot) return h.onSwitchWorkspaceByIndex(Number(slot[1]) - 1)
  const newIn = /^newchat([1-9])$/.exec(id)
  if (newIn) {
    const path = h.workspaces[Number(newIn[1]) - 1]
    if (path) h.onNewChatInWorkspace?.(path)
    return
  }
  window.dispatchEvent(new CustomEvent('vyotiq:command', { detail: { id } }))
}
