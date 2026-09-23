import type { IconName } from '@renderer/lib/icons'
import { shortcutCatalog, shortcutLabel, type ShortcutId } from '@renderer/lib/shortcuts'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
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
  sendFeedback: 'note'
}

/** "Ctrl+Shift+E" → ["Ctrl", "Shift", "E"]; "⌘⇧E" stays one cap. */
export function labelToKeys(label: string): string[] {
  if (!label) return []
  if (label.length > 1 && label.endsWith('+')) return [label.slice(0, -1), '+']
  return label.split('+').filter(Boolean)
}

export function paletteCommands({
  workspaces,
  activePath,
  canSendFeedback
}: {
  workspaces: readonly string[]
  activePath: string | null
  canSendFeedback: boolean
}): PaletteCommand[] {
  const base: PaletteCommand[] = shortcutCatalog()
    // One tab per Alt chord would repeat the panel commands; the chords are listed in Settings.
    .filter((entry) => !EXCLUDED.has(entry.id) && !/^(workspace[1-9]|inspectorTab[1-6])$/.test(entry.id))
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

  const extras: PaletteCommand[] = canSendFeedback ? [{ id: 'sendFeedback', title: 'Send feedback', icon: ICON.sendFeedback }] : []
  return [...base, ...perWorkspace, ...extras]
}

export type PaletteHandlers = {
  workspaces: readonly string[]
  onOpenSettings: () => void
  onOpenHome: () => void
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
}

export function runPaletteCommand(id: string, h: PaletteHandlers): void {
  if (id === 'settings') return h.onOpenSettings()
  if (id === 'goHome') return h.onOpenHome()
  if (id === 'newChat') return h.onNewTask()
  if (id === 'sidebar') return h.onToggleNavigator()
  if (id === 'nextNeedsYou') return h.onNextNeedsYou()
  if (id === 'sendFeedback') return h.onOpenFeedback?.()
  if (id === 'focusComposer') return h.onFocusInstructionLine()
  if (id === 'stop') return h.onStop?.()
  if (id === 'closeChat') return h.onCloseChat?.()
  if (id === 'splitPane') return h.onSplitPane?.()
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
