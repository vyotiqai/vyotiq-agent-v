import { useCallback, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ActiveRun, NotificationItem, NotificationMutateRequest, RunSummary } from '@shared/ipc'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { Icon, type IconName } from '@renderer/lib/icons'
import { ActionMenu, IconButton, cn } from '@renderer/lib/ui'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import { buildNavigatorSections, type NavSection } from './navigatorModel'
import { NavigatorTaskRow, type NavigatorRowActions } from './NavigatorTaskRow'
import { NotificationsButton } from './NotificationsButton'
import { UpdateChip } from './UpdateChip'

export type NavigatorPlace = 'home' | 'extensions' | 'usage' | 'settings' | 'task' | 'other'

/** How many finished tasks show before "N more". */
const DONE_LIMIT = 5

export type NavigatorProps = {
  place: NavigatorPlace
  /** The task open in the focused pane, if any. */
  selected: { workspacePath: string; runId: string } | null
  /** True for a task open in any pane (split view). */
  isRunOpen?: (workspacePath: string, runId: string) => boolean
  openPaths: readonly string[]
  activePath: string | null
  runsByWorkspacePath: Readonly<
    Record<string, { runs: readonly RunSummary[]; runsCapped?: boolean; runsError?: string | null }>
  >
  activeRuns: readonly ActiveRun[]
  activeRunsLoaded: boolean
  /** `null` = all workspaces. */
  scopePath: string | null
  onScopeChange: (path: string | null) => void
  onNewTask: () => void
  onOpenHome: () => void
  onOpenExtensions: () => void
  onOpenUsage: () => void
  onOpenSettings: () => void
  onOpenShortcuts: () => void
  onAddWorkspace: () => void
  onCloseWorkspace: (path: string) => void
  onLoadOlderRuns: (path: string) => void
  onDismissRunsError: (path: string) => void
  rowActions: NavigatorRowActions
  /** `pinnedRunKey` of every pinned task. */
  pinnedKeys?: ReadonlySet<string>
  notifications: {
    items: NotificationItem[]
    unreadCount: number
    onMarkRead: (req: NotificationMutateRequest) => void
    onDismiss: (req: NotificationMutateRequest) => void
    onOpenItem: (item: NotificationItem) => void
    onOpenSettings: () => void
  }
  widthPx: number
}

/**
 * The navigator while Set up is on screen: nothing to navigate yet, so it says
 * what will show here. Named for the folder chosen in Set up once there is one
 * — the app's own scratch folder is not one anybody chose.
 */
export function FirstRunNavigator({ workspaceName, widthPx }: { workspaceName: string | null; widthPx: number }) {
  return (
    <nav
      aria-label="Tasks"
      data-navigator
      data-first-run
      className="app-region-no-drag flex h-full shrink-0 flex-col bg-chrome"
      style={{ width: widthPx }}
    >
      <div className="truncate px-4 pt-3 text-sm font-medium text-muted">{workspaceName ?? 'No workspace yet'}</div>
      <p className="px-4 pt-2 text-xs leading-[18px] text-tertiary">
        Tasks you start show up here, grouped by what they need from you.
      </p>
    </nav>
  )
}

/**
 * The navigator: what needs you first, then what is running, what is waiting
 * for your review, and what is done. The workspace switcher filters it; a row
 * from a workspace other than the active one names that workspace in its meta.
 */
export function Navigator(props: NavigatorProps) {
  const { place, selected, openPaths, activePath, runsByWorkspacePath, scopePath } = props
  const [doneExpanded, setDoneExpanded] = useState(false)

  const unreadRunIds = useMemo(() => {
    const ids = new Set<string>()
    for (const item of props.notifications.items) {
      if (item.read) continue
      if (item.kind !== 'run_done' && item.kind !== 'run_error') continue
      if (item.action?.type === 'open_run') ids.add(item.action.runId)
    }
    return ids
  }, [props.notifications.items])

  const sections = useMemo(
    () =>
      buildNavigatorSections({
        runsByWorkspacePath,
        openPaths,
        activePath,
        activeRuns: props.activeRuns,
        activeRunsLoaded: props.activeRunsLoaded,
        scopePath,
        unreadRunIds,
        pinnedKeys: props.pinnedKeys
      }),
    [
      runsByWorkspacePath,
      openPaths,
      activePath,
      props.activeRuns,
      props.activeRunsLoaded,
      scopePath,
      unreadRunIds,
      props.pinnedKeys
    ]
  )

  // A restart interrupts every live task, whatever the switcher shows.
  const runningCount = useMemo(() => {
    let count = 0
    for (const path of openPaths) {
      for (const run of runsByWorkspacePath[path]?.runs ?? []) {
        if (run.inlineInstance) continue
        if (props.activeRuns.some((a) => a.runId === run.runId && workspacePathsEqual(a.workspacePath, path))) count++
      }
    }
    return count
  }, [openPaths, runsByWorkspacePath, props.activeRuns])

  const cappedPaths = useMemo(
    () =>
      openPaths.filter(
        (path) =>
          (!scopePath || workspacePathsEqual(path, scopePath)) && runsByWorkspacePath[path]?.runsCapped === true
      ),
    [openPaths, scopePath, runsByWorkspacePath]
  )

  const onNavKeyDown = useCallback((e: KeyboardEvent<HTMLButtonElement>) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
    if (!keys.includes(e.key)) return
    const list = e.currentTarget.closest('nav')?.querySelectorAll<HTMLButtonElement>('[data-nav-row]')
    if (!list || list.length === 0) return
    const rows = [...list]
    const i = rows.indexOf(e.currentTarget)
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : e.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0)
    e.preventDefault()
    rows[next]?.focus()
  }, [])

  const hasWorkspace = openPaths.length > 0

  return (
    <nav
      aria-label="Tasks"
      data-navigator
      className="app-region-no-drag flex h-full shrink-0 flex-col bg-chrome"
      style={{ width: props.widthPx }}
    >
      <div className="flex items-center gap-1 px-2 pb-2 pt-1">
        <WorkspaceScope
          openPaths={openPaths}
          activePath={activePath}
          scopePath={scopePath}
          onScopeChange={props.onScopeChange}
          onAddWorkspace={props.onAddWorkspace}
          onCloseWorkspace={props.onCloseWorkspace}
        />
        <IconButton
          icon="plus"
          label={`New task (${shortcutLabel('newChat')})`}
          size="md"
          disabled={!hasWorkspace}
          onClick={props.onNewTask}
        />
      </div>

      <div className="space-y-px px-2">
        <PlaceRow icon="home" label="Home" active={place === 'home'} onClick={props.onOpenHome} />
        <PlaceRow icon="extensions" label="Extensions" active={place === 'extensions'} onClick={props.onOpenExtensions} />
        <PlaceRow icon="chart" label="Usage" active={place === 'usage'} onClick={props.onOpenUsage} />
      </div>

      <div className="scroll-thin mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-navigator-tasks>
        {openPaths
          .filter((path) => (!scopePath || workspacePathsEqual(path, scopePath)) && runsByWorkspacePath[path]?.runsError)
          .map((path) => (
            <p key={path} role="alert" className="flex items-start gap-1.5 px-2 py-1 text-xs text-danger">
              <Icon name="warningCircle" size={13} className="mt-[3px] shrink-0" />
              <span className="min-w-0 flex-1">
                Couldn’t load the tasks in {formatWorkspaceName(path)}.
                <span className="block truncate text-muted" title={runsByWorkspacePath[path]?.runsError ?? undefined}>
                  {runsByWorkspacePath[path]?.runsError}
                </span>
              </span>
              <IconButton
                icon="close"
                label="Dismiss"
                size="xs"
                tone="muted"
                onClick={() => props.onDismissRunsError(path)}
              />
            </p>
          ))}
        {!hasWorkspace || sections.length === 0 ? (
          <p className="px-2 pt-2 text-xs leading-[18px] text-tertiary">
            Tasks you start show up here, grouped by what they need from you.
          </p>
        ) : (
          sections.map((section) => (
            <TaskSection
              key={section.key}
              section={section}
              selected={place === 'task' ? selected : null}
              isRunOpen={place === 'task' ? props.isRunOpen : undefined}
              actions={props.rowActions}
              onNavKeyDown={onNavKeyDown}
              expanded={doneExpanded}
              onExpand={() => setDoneExpanded(true)}
              trailing={
                section.key === 'done' && (doneExpanded || section.rows.length <= DONE_LIMIT) && cappedPaths.length > 0 ? (
                  <MoreButton label="Show older tasks" onClick={() => cappedPaths.forEach((path) => props.onLoadOlderRuns(path))} />
                ) : null
              }
            />
          ))
        )}
      </div>

      <div className="flex h-10 shrink-0 items-center gap-0.5 px-2">
        <NotificationsButton {...props.notifications} />
        <IconButton
          icon="gear"
          label={`Settings (${shortcutLabel('settings')})`}
          size="md"
          tone="muted"
          active={place === 'settings'}
          onClick={props.onOpenSettings}
        />
        <IconButton icon="question" label="Help & shortcuts" size="md" tone="muted" onClick={props.onOpenShortcuts} />
        <span className="flex-1" />
        <UpdateChip runningCount={runningCount} />
      </div>
    </nav>
  )
}

function TaskSection({
  section,
  selected,
  isRunOpen,
  actions,
  onNavKeyDown,
  expanded,
  onExpand,
  trailing
}: {
  section: NavSection
  selected: { workspacePath: string; runId: string } | null
  isRunOpen?: (workspacePath: string, runId: string) => boolean
  actions: NavigatorRowActions
  onNavKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void
  expanded: boolean
  onExpand: () => void
  trailing: ReactNode
}) {
  const limited = section.key === 'done' && !expanded
  const shown = limited ? section.rows.slice(0, DONE_LIMIT) : section.rows
  const hidden = section.rows.length - shown.length
  const headingId = `nav-section-${section.key}`
  return (
    <section className="mt-3 first:mt-1" aria-labelledby={headingId} data-nav-section={section.key}>
      <h3
        id={headingId}
        className={cn('flex h-6 items-center gap-1.5 px-2', SECTION_LABEL)}
      >
        {section.label}
        <span className="font-mono font-normal tnum">{section.rows.length}</span>
      </h3>
      <ul className="space-y-px">
        {shown.map((row) => (
          <NavigatorTaskRow
            key={`${row.workspacePath}::${row.runId}`}
            row={row}
            selected={
              selected != null &&
              selected.runId === row.runId &&
              workspacePathsEqual(selected.workspacePath, row.workspacePath)
            }
            open={isRunOpen?.(row.workspacePath, row.runId) ?? false}
            actions={actions}
            onNavKeyDown={onNavKeyDown}
          />
        ))}
      </ul>
      {hidden > 0 ? <MoreButton label={`${hidden} more`} onClick={onExpand} /> : trailing}
    </section>
  )
}

function MoreButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="mt-0.5 flex h-6 w-full items-center gap-1.5 rounded-md px-2 text-xs text-tertiary vy-transition hover:bg-surface hover:text-muted focus-visible:vy-focus-ring"
      onClick={onClick}
    >
      <Icon name="chevron" size={11} />
      {label}
    </button>
  )
}

function PlaceRow({
  icon,
  label,
  active,
  onClick
}: {
  icon: IconName
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-sm vy-transition focus-visible:vy-focus-ring',
        active ? 'bg-surface-2 font-medium text-fg-strong' : 'text-secondary hover:bg-surface hover:text-fg-strong'
      )}
      onClick={onClick}
    >
      <Icon name={icon} size={16} className={active ? 'text-fg-strong' : 'text-muted'} />
      {label}
    </button>
  )
}

/** Filters the list, and is where workspaces are opened and closed. */
function WorkspaceScope({
  openPaths,
  activePath,
  scopePath,
  onScopeChange,
  onAddWorkspace,
  onCloseWorkspace
}: {
  openPaths: readonly string[]
  activePath: string | null
  scopePath: string | null
  onScopeChange: (path: string | null) => void
  onAddWorkspace: () => void
  onCloseWorkspace: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const label = scopePath ? formatWorkspaceName(scopePath) : openPaths.length > 0 ? 'All workspaces' : 'No workspace'
  const items = [
    ...(openPaths.length > 1 || scopePath
      ? [{ id: 'all', label: 'All workspaces', checked: scopePath === null, onSelect: () => onScopeChange(null) }]
      : []),
    ...openPaths.map((path) => ({
      id: `ws:${path}`,
      label: formatWorkspaceName(path),
      checked: scopePath != null && workspacePathsEqual(scopePath, path),
      onSelect: () => onScopeChange(path)
    })),
    { id: 'add', label: 'Add workspace…', icon: 'folderPlus' as const, separatorBefore: true, onSelect: onAddWorkspace },
    ...(scopePath ?? activePath
      ? [
          {
            id: 'close',
            label: `Close ${formatWorkspaceName(scopePath ?? activePath)}`,
            icon: 'close' as const,
            onSelect: () => onCloseWorkspace((scopePath ?? activePath)!)
          }
        ]
      : [])
  ]
  return (
    <ActionMenu
      open={open}
      onOpenChange={setOpen}
      placement="down"
      aria-label="Workspaces"
      items={items}
      trigger={(t) => (
        <button
          ref={t.ref}
          type="button"
          aria-expanded={t['aria-expanded']}
          aria-controls={t['aria-controls']}
          aria-haspopup={t['aria-haspopup']}
          onClick={t.onClick}
          title={scopePath ?? undefined}
          className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-fg-strong vy-transition hover:bg-surface focus-visible:vy-focus-ring"
        >
          <Icon name="workspace" size={15} className="text-muted" />
          <span className="min-w-0 truncate">{label}</span>
          <Icon name="chevron" size={11} className="shrink-0 text-tertiary" />
        </button>
      )}
    />
  )
}
