/**
 * The window's side of the app's actions (src/shared/appActions.ts): views,
 * panes, panels, the navigator, the agent's mode, the update. Main finds the
 * task or workspace first and sends it resolved; this does what a click or
 * the command palette would, and answers in words the voice can say.
 */
import { APP_PANELS, SETTINGS_SECTIONS, type AppWindowAction } from '@shared/appActions'
import type { SettingsSection } from '@renderer/features/settings/types'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { runPaletteCommand, type PaletteHandlers } from '@renderer/features/commandPalette/paletteCommands'
import { openInEditor } from '@renderer/lib/openInEditor'

export type WindowActionHandlers = PaletteHandlers & {
  onOpenSettingsSection?: (section: SettingsSection) => void
  onOpenTask: (path: string, runId: string) => void
  onSwitchWorkspace?: (path: string) => void
  onToggleArchivedRun?: (path: string, runId: string) => void
  /** Whether the task is archived now, before the toggle. */
  isArchived?: (path: string, runId: string) => boolean
  onDeleteRun?: (path: string, runId: string) => Promise<boolean | void> | void
  /** False when it couldn't be renamed (the screen says why). */
  onRenameRun?: (path: string, runId: string, title: string) => Promise<boolean | void> | void
  /** False when it couldn't be forked (the screen says why). */
  onForkRun?: (path: string, runId: string) => Promise<boolean | void> | void
  /** False when there was no room or nothing to split. */
  splitPane?: () => boolean | void
  /** False when no task tab was open to close. */
  closePane?: () => boolean | void
  onSetAgentMode?: (mode: 'ask' | 'agent') => boolean
  /** An update is downloaded and ready to install. */
  updateReady?: () => boolean
  /** An update is out and not downloaded yet. */
  updateAvailable?: () => boolean
  /** The task view is showing: panels sit beside a task. */
  inTaskView?: () => boolean
}

export type WindowActionOutcome = { ok: boolean; message: string }

const VIEW_COMMAND: Readonly<Record<string, { id: string; said: string }>> = {
  home: { id: 'goHome', said: 'Here’s Home.' },
  settings: { id: 'settings', said: 'Settings are open.' },
  usage: { id: 'goUsage', said: 'Here’s Usage.' },
  inbox: { id: 'openInbox', said: 'The inbox is open.' },
  scheduled: { id: 'scheduledTasks', said: 'Here are the scheduled tasks.' },
  extensions: { id: 'openExtensions', said: 'Extensions are open.' },
  docs: { id: 'openDocs', said: 'The documentation is open.' },
  whats_new: { id: 'whatsNew', said: 'Here’s what’s new.' },
  shortcuts: { id: 'shortcutsHelp', said: 'Here are the shortcuts.' }
}

/** The task view opens the panel named in `detail.panel` (ChatView). */
export const OPEN_PANEL_EVENT = 'vyotiq:open-panel'

/** A `vyotiq:command` for the focused task pane; true when one took it (it sets `handled`). */
function paneCommand(id: string): boolean {
  const detail = { id, handled: false }
  window.dispatchEvent(new CustomEvent('vyotiq:command', { detail }))
  return detail.handled
}

async function runCommand(command: string, h: WindowActionHandlers): Promise<WindowActionOutcome> {
  const inTask = h.inTaskView?.() ?? true
  switch (command) {
    case 'split_pane':
      if (!h.splitPane) return { ok: false, message: 'Panes can’t be split here.' }
      return h.splitPane() === false
        ? { ok: false, message: 'It couldn’t be split.' }
        : { ok: true, message: 'Split: there’s room for another task beside it.' }
    case 'close_pane':
      if (!inTask || !h.closePane || h.closePane() === false) return { ok: false, message: 'No task is open to close.' }
      return { ok: true, message: 'Closed it; the task is still in the list.' }
    case 'find':
      if (!inTask || !paneCommand('find')) return { ok: false, message: 'No task is on screen to search.' }
      return { ok: true, message: 'Find is open; type what to look for.' }
    case 'find_in_files':
      if (!inTask || !h.activeWorkspacePath) return { ok: false, message: 'Open a task first; find in files sits beside it.' }
      runPaletteCommand('findInFiles', h)
      return { ok: true, message: 'Find in files is open; type what to look for.' }
    case 'show_reasoning':
    case 'hide_reasoning': {
      const show = command === 'show_reasoning'
      if (!inTask || !paneCommand(show ? 'showReasoning' : 'hideReasoning')) return { ok: false, message: 'No task is on screen.' }
      return { ok: true, message: show ? 'Reasoning is shown.' : 'Reasoning is hidden.' }
    }
    case 'open_in_editor': {
      const path = h.activeWorkspacePath
      if (!path) return { ok: false, message: 'No workspace is open.' }
      return (await openInEditor({ workspacePath: path }))
        ? { ok: true, message: `${formatWorkspaceName(path)} is opening in your editor.` }
        : { ok: false, message: 'It couldn’t open in an editor; the screen says why.' }
    }
    case 'add_workspace':
      if (!h.onAddWorkspace) return { ok: false, message: 'Workspaces can’t be added here.' }
      h.onAddWorkspace()
      return { ok: true, message: 'Pick the folder in the window that opened.' }
    case 'import_task':
      if (!h.onImportTask || !h.activeWorkspacePath) return { ok: false, message: 'There’s no workspace to import into.' }
      h.onImportTask()
      return { ok: true, message: 'Pick the task file in the window that opened.' }
    case 'send_feedback':
      if (!h.onOpenFeedback) return { ok: false, message: 'Feedback can’t be sent from here.' }
      h.onOpenFeedback()
      return { ok: true, message: 'The feedback form is open.' }
    default:
      return { ok: false, message: 'There’s no such command.' }
  }
}

export async function executeWindowAction(action: AppWindowAction, h: WindowActionHandlers): Promise<WindowActionOutcome> {
  const a = action.args
  const path = action.resolved?.workspacePath
  const runId = action.resolved?.runId
  switch (action.name) {
    case 'open_view': {
      const view = VIEW_COMMAND[String(a.view)]
      if (!view) return { ok: false, message: 'There’s no such view.' }
      if (view.id === 'openExtensions' && !h.onOpenExtensions) return { ok: false, message: 'Extensions aren’t available here.' }
      runPaletteCommand(view.id, h)
      return { ok: true, message: view.said }
    }
    case 'open_settings': {
      // Typed as Settings' own sections, so a catalog name Settings doesn't have fails the build.
      const sections: readonly SettingsSection[] = SETTINGS_SECTIONS
      const section = sections.find((s) => s === a.section) ?? null
      if (section && h.onOpenSettingsSection) h.onOpenSettingsSection(section)
      else h.onOpenSettings()
      return { ok: true, message: 'Settings are open.' }
    }
    case 'open_panel': {
      if (!(APP_PANELS as readonly string[]).includes(String(a.panel))) return { ok: false, message: 'There’s no such panel.' }
      if (h.inTaskView && !h.inTaskView()) return { ok: false, message: 'Panels sit beside a task; open one first.' }
      // Opened, never toggled: the palette's command hides the panel already on screen, and "open the terminal" must not close it.
      window.dispatchEvent(new CustomEvent(OPEN_PANEL_EVENT, { detail: { panel: String(a.panel) } }))
      return { ok: true, message: `The ${a.panel === 'pr' ? 'pull request' : String(a.panel)} panel is open.` }
    }
    case 'toggle_navigator':
      h.onToggleNavigator()
      return { ok: true, message: 'Done.' }
    case 'run_command':
      return runCommand(String(a.command), h)
    case 'next_needs_you':
      h.onNextNeedsYou()
      return { ok: true, message: 'Okay.' }
    case 'new_task':
      if (path && h.onNewChatInWorkspace) h.onNewChatInWorkspace(path)
      else h.onNewTask()
      return { ok: true, message: path ? `New task in ${formatWorkspaceName(path)}. What should it do?` : 'New task. What should it do?' }
    case 'switch_workspace':
      if (!path || !h.onSwitchWorkspace) return { ok: false, message: 'That workspace can’t be switched to.' }
      h.onSwitchWorkspace(path)
      return { ok: true, message: `You’re in ${formatWorkspaceName(path)} now.` }
    case 'open_task':
      if (!path || !runId) return { ok: false, message: 'No task matches that.' }
      h.onOpenTask(path, runId)
      return { ok: true, message: 'Here it is: {task}.' }
    case 'archive_task': {
      if (!path || !runId || !h.onToggleArchivedRun) return { ok: false, message: 'That task can’t be archived from here.' }
      // Asked one way, done that way: the window only toggles, so "archive" on an archived task would bring it back.
      const want = a.unarchive !== true
      const was = h.isArchived?.(path, runId) ?? false
      if (was === want) return { ok: true, message: want ? '{task} is already archived.' : '{task} isn’t archived.' }
      h.onToggleArchivedRun(path, runId)
      return { ok: true, message: want ? 'Archived {task}.' : 'Unarchived {task}.' }
    }
    case 'delete_task': {
      if (!path || !runId || !h.onDeleteRun) return { ok: false, message: 'That task can’t be deleted from here.' }
      const done = await h.onDeleteRun(path, runId)
      return done === false
        ? { ok: false, message: 'It couldn’t be deleted; the screen says why.' }
        : { ok: true, message: 'Deleted {task}. It’s in Recently deleted for 30 days.' }
    }
    case 'fork_task': {
      if (!path || !runId || !h.onForkRun) return { ok: false, message: 'That task can’t be forked from here.' }
      const done = await h.onForkRun(path, runId)
      return done === false ? { ok: false, message: 'It couldn’t be forked; the screen says why.' } : { ok: true, message: 'Forked {task}; the copy is open.' }
    }
    case 'rename_task': {
      const title = typeof a.title === 'string' ? a.title.trim() : ''
      if (!path || !runId || !title || !h.onRenameRun) return { ok: false, message: 'That task can’t be renamed from here.' }
      const done = await h.onRenameRun(path, runId, title)
      return done === false ? { ok: false, message: 'It couldn’t be renamed; the screen says why.' } : { ok: true, message: `Renamed {task} to “${title}”.` }
    }
    case 'set_agent_mode': {
      const mode = a.mode === 'ask' ? 'ask' : 'agent'
      if (!h.onSetAgentMode?.(mode)) return { ok: false, message: 'No task is on screen to set.' }
      return { ok: true, message: mode === 'ask' ? 'Ask mode: it answers without changing anything.' : 'Agent mode: it can make changes.' }
    }
    case 'download_update':
      if (h.updateReady?.()) return { ok: true, message: 'It’s downloaded already; it installs when you say so.' }
      if (!h.updateAvailable?.()) return { ok: false, message: 'There’s no update to download.' }
      runPaletteCommand('downloadUpdate', h)
      return { ok: true, message: 'Downloading the update.' }
    case 'install_update':
      if (!h.updateReady?.()) return { ok: false, message: h.updateAvailable?.() ? 'The update isn’t downloaded yet.' : 'No update is downloaded yet.' }
      runPaletteCommand('installUpdate', h)
      return { ok: true, message: 'Installing it; the app restarts.' }
    default:
      return { ok: false, message: `The window can’t do ${action.name}.` }
  }
}
