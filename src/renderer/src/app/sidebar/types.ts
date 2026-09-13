import type { RefObject } from 'react'
import type { RunSummary } from '@shared/ipc'
import type { RunRecencyGroup } from '@renderer/lib/utils/groupRunsByRecency'

export type SidebarView = 'chat' | 'settings' | 'marketplace' | 'home'

export type SidebarProps = {
  view: SidebarView
  onDismissRunsError?: (path?: string) => void
  sessionQuery: string
  searchRef: RefObject<HTMLInputElement | null>
  hasWorkspace?: boolean
  openPaths?: string[]
  activePath?: string | null
  runsByWorkspacePath?: Record<string, WorkspaceSidebarRuns>
  activeRuns?: { runId: string; workspacePath: string }[]
  onSwitchWorkspace?: (path: string) => void
  onCloseWorkspace?: (path: string) => void
  onAddWorkspace?: () => void
  /** Persisted per-workspace sidebar expand state + mutator. */
  expandedByPath?: Record<string, boolean>
  onSetWorkspaceExpanded?: (path: string, expanded: boolean) => void
  workspaceHasBackgroundRun?: (path: string) => boolean
  onSessionQuery: (q: string) => void
  onOpenSettings: () => void
  onOpenNotificationSettings?: () => void
  focusedRunId?: string | null
  onOpenMarketplace: () => void
  /** Show the Home launch surface (Sidebar footer rail + Ctrl/Cmd+Shift+H). */
  onOpenHome?: () => void
  onOpenChat: () => void
  /** Open a fresh chat in a specific workspace (switches there when needed). */
  onNewChatInWorkspace?: (path: string) => void
  onSelectRunInWorkspace?: (path: string, runId: string) => void
  onRenameRunInWorkspace?: (path: string, runId: string, goal: string) => void
  onDeleteRunInWorkspace?: (path: string, runId: string) => void
  onExportRunInWorkspace?: (path: string, runId: string) => void
  /** Load one older page of runs beyond the sidebar cap (runs beyond 30). */
  onLoadOlderRuns?: (path: string) => void
  isRunOpenInPane?: (path: string, runId: string) => boolean
  isRunFocusedInPane?: (path: string, runId: string) => boolean
  openInstanceRunId?: string | null
  onCloseDrawer: () => void
  onToggleSidebar: () => void
  collapsed?: boolean
  /** Home navigation mode: hide the session list (the mobile drawer collapses to the rail). */
  hideSessions?: boolean
  /** Expanded desktop width in px (drag-resized). Ignored when collapsed or drawer. */
  widthPx?: number
  variant?: 'desktop' | 'drawer'
}

export type WorkspaceSidebarRuns = {
  runs: RunSummary[]
  instanceRuns?: RunSummary[]
  runsCapped?: boolean
  runsError?: string | null
  runsLoaded?: boolean
  activeRunId: string | null
}

export type WorkspaceSidebarGroup = {
  path: string
  label: string
  isActiveWorkspace: boolean
  expanded: boolean
  filteredRuns: RunSummary[]
  instanceRuns: RunSummary[]
  groupedRuns: RunRecencyGroup[]
  runsCapped?: boolean
  runsError?: string | null
  runsLoaded?: boolean
  activeRunId: string | null
}
