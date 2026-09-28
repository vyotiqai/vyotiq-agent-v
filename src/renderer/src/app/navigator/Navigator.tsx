import { useCallback, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { TaskDraft } from '@shared/ipc'
import { NavigatorDraftRow, type NavigatorDraftActions } from './NavigatorDraftRow'
import type { ActiveRun, NotificationItem, NotificationMutateRequest, RunSummary } from '@shared/ipc'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { Icon, type IconName } from '@renderer/lib/icons'
import {
  ActionMenu,
  Button,
  IconButton,
  StatusGlyph,
  Tooltip,
  cn,
  type ActionMenuItem,
  type TaskState
} from '@renderer/lib/ui'
import { BORDER_DIVIDER } from '@renderer/lib/utils/layout'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import {
  buildNavigatorSections,
  draftsPassFilter,
  filterNavigatorSections,
  groupSectionsByWorkspace,
  navFilterActive,
  splitRowsByDate,
  NO_NAV_FILTER,
  type NavRow,
  type NavSection,
  type NavSectionKey,
  type NavStateFilter,
  type NavWhereFilter,
  type NavWorkspaceBlock
} from './navigatorModel'
import { NavigatorTaskRow, type NavigatorRowActions } from './NavigatorTaskRow'
import { NotificationsRow } from './NotificationsRow'
import { UpdateChip } from './UpdateChip'
import { DEFAULT_NAVIGATOR_VIEW, isCollapsed, type NavigatorView } from './useNavigatorView'

export type NavigatorPlace = 'home' | 'extensions' | 'usage' | 'settings' | 'task' | 'other'

/**
 * The state a group says once, on its heading, so its rows don't repeat it: a
 * row wears a glyph only when it ended some other way (a failed task with
 * edits under Ready for review, a stopped one under Today). Pinned and the
 * date groups are history, so their heading has none and a plain done row is
 * bare.
 */
const GROUP_STATE: Record<NavSectionKey, { glyph: TaskState | null; rows: TaskState }> = {
  needs: { glyph: 'needs', rows: 'needs' },
  running: { glyph: 'running', rows: 'running' },
  review: { glyph: 'review', rows: 'review' },
  pinned: { glyph: null, rows: 'done' },
  done: { glyph: null, rows: 'done' },
  archived: { glyph: null, rows: 'done' }
}

type ViewUpdate = (update: (prev: NavigatorView) => NavigatorView) => void

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
  /** Start a task in one workspace: a workspace heading's +. */
  onNewTaskIn?: (path: string) => void
  onOpenHome: () => void
  onOpenExtensions: () => void
  onOpenUsage: () => void
  onOpenSettings: () => void
  onAddWorkspace: () => void
  /** Folders opened before and closed since, newest first — the workspace menu's Recent. */
  recentPaths?: readonly string[]
  onOpenRecentWorkspace?: (path: string) => void
  onCloseWorkspace: (path: string) => void
  onLoadOlderRuns: (path: string) => void
  onDismissRunsError: (path: string) => void
  rowActions: NavigatorRowActions
  /** `pinnedRunKey` of every pinned task. */
  pinnedKeys?: ReadonlySet<string>
  /** `pinnedRunKey` of every archived task. */
  archivedKeys?: ReadonlySet<string>
  /** What the View menu is set to, and folded workspaces. Kept here when the caller does not own it. */
  view?: NavigatorView
  onViewChange?: ViewUpdate
  notifications: {
    items: NotificationItem[]
    unreadCount: number
    onMarkRead: (req: NotificationMutateRequest) => void
    onDismiss: (req: NotificationMutateRequest) => void
    onOpenItem: (item: NotificationItem) => void
    onOpenSettings: () => void
  }
  widthPx: number
  /** New task briefs put aside, and what their rows can do. */
  drafts?: {
    items: ReadonlyArray<{ workspacePath: string; draft: TaskDraft }>
    actions: NavigatorDraftActions
    /** The draft New task is continuing, while it is on screen. */
    open?: { workspacePath: string; draftId: string } | null
  }
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
      {/* The app's one update surface lives in this footer; it must exist here too,
          or an "is ready" notice clicked during Set up opens nothing. Renders nothing while current. */}
      <div className="mt-auto flex h-10 shrink-0 items-center px-2">
        <UpdateChip />
      </div>
    </nav>
  )
}

type Draft = { workspacePath: string; draft: TaskDraft }

/**
 * The navigator, in three zones fenced by the same hairline:
 *
 *   head   the workspace switcher as plain text; on the right the View menu
 *          (what to list) and New task
 *   tasks  per workspace while it lists all of them, each foldable under its
 *          name: what needs you, what is running, what waits on review,
 *          pinned, drafts, everything else by day — Today, Yesterday, This
 *          week, Older — and, when asked for, Archived
 *   foot   Home, Inbox, Extensions and Usage as icons, and Settings
 *
 * One left edge runs the whole height: switcher, workspace and group names,
 * task titles and places all start on it. Glyphs hang on the right, beside the
 * number they qualify.
 */
export function Navigator(props: NavigatorProps) {
  const { place, selected, openPaths, activePath, runsByWorkspacePath, scopePath } = props
  const [ownView, setOwnView] = useState<NavigatorView>(DEFAULT_NAVIGATOR_VIEW)
  const view = props.view ?? ownView
  const updateView: ViewUpdate = props.onViewChange ?? setOwnView
  const filterOn = navFilterActive(view)

  const unreadRunIds = useMemo(() => {
    const ids = new Set<string>()
    for (const item of props.notifications.items) {
      if (item.read) continue
      if (item.kind !== 'run_done' && item.kind !== 'run_error') continue
      if (item.action?.type === 'open_run') ids.add(item.action.runId)
    }
    return ids
  }, [props.notifications.items])

  // Drafts, scoped like tasks: the workspace the navigator is filtered to, or all.
  const drafts = useMemo(
    () =>
      (props.drafts?.items ?? []).filter(
        ({ workspacePath }) =>
          openPaths.some((path) => workspacePathsEqual(path, workspacePath)) &&
          (!scopePath || workspacePathsEqual(scopePath, workspacePath))
      ),
    [props.drafts?.items, openPaths, scopePath]
  )
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
        pinnedKeys: props.pinnedKeys,
        archivedKeys: props.archivedKeys,
        showArchived: view.showArchived
      }),
    [
      runsByWorkspacePath,
      openPaths,
      activePath,
      props.activeRuns,
      props.activeRunsLoaded,
      scopePath,
      unreadRunIds,
      props.pinnedKeys,
      props.archivedKeys,
      view.showArchived
    ]
  )
  const shownSections = useMemo(() => filterNavigatorSections(sections, view), [sections, view])
  const shownDrafts = draftsPassFilter(view) ? drafts : []
  const hiddenCount = countRows(sections) + drafts.length - countRows(shownSections) - shownDrafts.length

  // Every workspace at once: one block each, so their tasks never interleave.
  // One workspace (or one picked): a single block, named by the switcher alone.
  const grouped = scopePath == null && openPaths.length > 1
  const blocks = useMemo<NavWorkspaceBlock[]>(() => {
    if (grouped) return groupSectionsByWorkspace(shownSections, openPaths, activePath)
    const path = scopePath ?? openPaths[0]
    return path ? [{ path, name: formatWorkspaceName(path), sections: shownSections }] : []
  }, [grouped, shownSections, openPaths, activePath, scopePath])

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
  const empty = !hasWorkspace || (sections.length === 0 && drafts.length === 0)
  // Everything there is, hidden by the View menu: one line says so, not one per workspace.
  const allFiltered = !empty && shownSections.length === 0 && shownDrafts.length === 0
  const clearFilter = (): void => updateView((prev) => ({ ...prev, ...NO_NAV_FILTER }))

  return (
    <nav
      aria-label="Tasks"
      data-navigator
      className="app-region-no-drag flex h-full shrink-0 flex-col bg-chrome"
      style={{ width: props.widthPx }}
    >
      <div className={cn('flex h-10 shrink-0 items-center border-b px-2', BORDER_DIVIDER)} data-navigator-head>
        <WorkspaceScope
          openPaths={openPaths}
          scopePath={scopePath}
          onScopeChange={props.onScopeChange}
          onAddWorkspace={props.onAddWorkspace}
          recentPaths={props.recentPaths ?? []}
          onOpenRecent={props.onOpenRecentWorkspace}
          onCloseWorkspace={props.onCloseWorkspace}
        />
        {/* The only gap: a long workspace name gets every pixel up to the controls. */}
        <span className="min-w-2 flex-1" />
        <div className="flex shrink-0 items-center gap-1">
          {hasWorkspace ? <ViewMenu view={view} grouped={grouped} openPaths={openPaths} onChange={updateView} /> : null}
          {hasWorkspace ? (
            <Tooltip content={`New task (${shortcutLabel('newChat')})`} side="bottom">
              <Button size="xs" variant="secondary" onClick={props.onNewTask} data-navigator-new-task>
                New task
              </Button>
            </Tooltip>
          ) : (
            // A disabled Button shows its title as a tooltip itself.
            <Button size="xs" variant="secondary" disabled title="Add a workspace to start a task" data-navigator-new-task>
              New task
            </Button>
          )}
        </div>
      </div>

      {/* The 8px scrollbar gutter is always reserved and stands in for the right
          padding, so the rows' right edge meets the head's and the foot's whether
          or not the list scrolls. */}
      <div
        className="scroll-thin min-h-0 flex-1 overflow-y-auto pb-2 pl-2 pt-2 [scrollbar-gutter:stable]"
        data-navigator-tasks
      >
        {openPaths
          .filter((path) => (!scopePath || workspacePathsEqual(path, scopePath)) && runsByWorkspacePath[path]?.runsError)
          .map((path) => (
            <p key={path} role="alert" className="flex items-start gap-1.5 px-2 py-1 text-xs text-danger">
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
        {filterOn && !empty ? (
          // What the View menu hides is said once, at the top, with the way back.
          <div className="mb-1 flex h-7 items-center gap-2 px-2 text-xs text-muted" data-nav-filter-notice>
            <span className="min-w-0 flex-1 truncate">
              {hiddenCount === 0 ? 'Filtered' : `${hiddenCount} hidden by the filter`}
            </span>
            <button
              type="button"
              className="shrink-0 rounded-sm text-xs text-muted vy-transition hover:text-fg-strong focus-visible:vy-focus-ring"
              onClick={clearFilter}
            >
              Show all
            </button>
          </div>
        ) : null}
        {empty ? (
          <p className="px-2 pt-1 text-xs leading-[18px] text-tertiary">
            Tasks you start show up here, grouped by what they need from you.
          </p>
        ) : allFiltered ? (
          <p className="px-2 text-xs text-tertiary">No tasks match the filter.</p>
        ) : (
          blocks.map((block, index) => (
            <WorkspaceBlock
              key={block.path}
              index={index}
              block={block}
              heading={grouped}
              collapsed={grouped && isCollapsed(view, block.path)}
              onToggleCollapsed={() =>
                updateView((prev) => ({
                  ...prev,
                  collapsed: isCollapsed(prev, block.path)
                    ? prev.collapsed.filter((p) => !workspacePathsEqual(p, block.path))
                    : [...prev.collapsed, block.path]
                }))
              }
              onNewTask={props.onNewTaskIn ? () => props.onNewTaskIn?.(block.path) : undefined}
              filtered={filterOn}
              drafts={shownDrafts.filter((d) => workspacePathsEqual(d.workspacePath, block.path))}
              draftActions={props.drafts?.actions}
              openDraft={props.drafts?.open ?? null}
              capped={runsByWorkspacePath[block.path]?.runsCapped === true}
              onLoadOlder={() => props.onLoadOlderRuns(block.path)}
              selected={place === 'task' ? selected : null}
              isRunOpen={place === 'task' ? props.isRunOpen : undefined}
              actions={props.rowActions}
              onNavKeyDown={onNavKeyDown}
            />
          ))
        )}
      </div>

      <div className={cn('shrink-0 border-t', BORDER_DIVIDER)} data-navigator-places>
        {/* The app's one update surface. Renders nothing while the install is current. */}
        <div className="flex px-4 pt-2 empty:hidden">
          <UpdateChip runningCount={runningCount} />
        </div>
        {/* One 40px row of places, the head's height. pl-2.5 puts the first glyph on
            the column's 16px left edge; Settings ends on the right edge New task does. */}
        <div className="flex h-10 items-center gap-1 pl-2.5 pr-2" role="group" aria-label="Places">
          <PlaceButton icon="home" label="Home" place="home" active={place === 'home'} onClick={props.onOpenHome} />
          <NotificationsRow {...props.notifications} />
          <PlaceButton
            icon="extensions"
            label="Extensions"
            place="extensions"
            active={place === 'extensions'}
            onClick={props.onOpenExtensions}
          />
          <PlaceButton icon="chart" label="Usage" place="usage" active={place === 'usage'} onClick={props.onOpenUsage} />
          <span className="flex-1" />
          <PlaceButton
            icon="gear"
            label={`Settings (${shortcutLabel('settings')})`}
            place="settings"
            active={place === 'settings'}
            onClick={props.onOpenSettings}
          />
        </div>
      </div>
    </nav>
  )
}

function countRows(sections: readonly NavSection[]): number {
  return sections.reduce((n, section) => n + section.rows.length, 0)
}

/**
 * One workspace's tasks. While the navigator lists every workspace it opens on
 * the workspace's name, which folds it away; after the first, a hairline
 * fences it from the one above. Live groups first, then drafts, then Earlier
 * by day, then Archived when the view lists it.
 */
function WorkspaceBlock({
  index,
  block,
  heading,
  collapsed,
  onToggleCollapsed,
  onNewTask,
  filtered,
  drafts,
  draftActions,
  openDraft,
  capped,
  onLoadOlder,
  selected,
  isRunOpen,
  actions,
  onNavKeyDown
}: {
  index: number
  block: NavWorkspaceBlock
  heading: boolean
  collapsed: boolean
  onToggleCollapsed: () => void
  onNewTask?: () => void
  /** The View menu is hiding something: an empty block says "nothing matches", not "no tasks". */
  filtered: boolean
  drafts: Draft[]
  draftActions?: NavigatorDraftActions
  openDraft: { workspacePath: string; draftId: string } | null
  capped: boolean
  onLoadOlder: () => void
  selected: { workspacePath: string; runId: string } | null
  isRunOpen?: (workspacePath: string, runId: string) => boolean
  actions: NavigatorRowActions
  onNavKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void
}) {
  const idBase = `nav-${index}`
  const live = block.sections.filter((section) => section.key !== 'done' && section.key !== 'archived')
  const earlier = block.sections.find((section) => section.key === 'done')
  const archived = block.sections.find((section) => section.key === 'archived')
  const days = earlier ? splitRowsByDate(earlier.rows) : []
  const rowProps = { selected, isRunOpen, actions, onNavKeyDown }
  const olderButton = capped ? (
    <button
      type="button"
      className="mt-px flex h-7 w-full items-center rounded-md px-2 text-xs text-muted vy-transition hover:bg-surface hover:text-fg-strong focus-visible:vy-focus-ring"
      onClick={onLoadOlder}
    >
      Show older tasks
    </button>
  ) : null

  const nothing = block.sections.length === 0 && drafts.length === 0
  const body = (
    <div className="space-y-3">
      {live.map((section) => (
        <TaskSection key={section.key} id={`${idBase}-${section.key}`} section={section} {...rowProps} />
      ))}
      {drafts.length > 0 && draftActions ? (
        <section aria-labelledby={`${idBase}-drafts`} data-nav-section="drafts">
          <GroupHeading id={`${idBase}-drafts`} glyph="queued" label="Drafts" count={drafts.length} />
          <ul className="space-y-px">
            {drafts.map(({ workspacePath, draft }) => (
              <NavigatorDraftRow
                key={`${workspacePath}::${draft.id}`}
                workspacePath={workspacePath}
                draft={draft}
                selected={openDraft?.draftId === draft.id && workspacePathsEqual(openDraft.workspacePath, workspacePath)}
                actions={draftActions}
                onNavKeyDown={onNavKeyDown}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {days.length > 0 ? (
        // Earlier, by day. One wrapper, so "everything that is over" stays one thing to find.
        <div className="space-y-3" data-nav-section="done">
          {days.map((day, i) => (
            <TaskSection
              key={day.key}
              id={`${idBase}-${day.key}`}
              section={{ key: 'done', label: day.label, rows: day.rows }}
              date={day.key}
              trailing={i === days.length - 1 ? olderButton : null}
              {...rowProps}
            />
          ))}
        </div>
      ) : (
        olderButton
      )}
      {archived ? <TaskSection id={`${idBase}-archived`} section={archived} {...rowProps} /> : null}
      {heading && nothing ? (
        <p className="px-2 text-xs text-tertiary">{filtered ? 'Nothing here matches the filter.' : 'No tasks yet.'}</p>
      ) : null}
    </div>
  )

  if (!heading) return body
  const bodyId = `${idBase}-body`
  return (
    <section
      aria-label={block.name}
      data-nav-workspace={block.name}
      data-collapsed={collapsed ? '' : undefined}
      className={cn(index > 0 && cn('mt-4 border-t pt-3', BORDER_DIVIDER))}
    >
      <WorkspaceHeading
        name={block.name}
        path={block.path}
        count={countRows(block.sections) + drafts.length}
        urgent={
          block.sections.some((section) => section.key === 'needs')
            ? 'needs'
            : block.sections.some((section) => section.key === 'running')
              ? 'running'
              : null
        }
        collapsed={collapsed}
        controls={bodyId}
        onToggle={onToggleCollapsed}
        onNewTask={onNewTask}
      />
      {collapsed ? null : (
        <div id={bodyId} className="mt-1">
          {body}
        </div>
      )}
    </section>
  )
}

/**
 * A workspace's name on the left edge; clicking it folds the workspace away.
 * On hover a chevron says it folds and a + starts a task there; folded, the
 * chevron and the task count stay, so a folded workspace never reads as empty,
 * and the glyph of what needs you or is running, so folding never buries it.
 */
function WorkspaceHeading({
  name,
  path,
  count,
  urgent,
  collapsed,
  controls,
  onToggle,
  onNewTask
}: {
  name: string
  path: string
  count: number
  /** The most pressing group inside, said on the heading while it is folded. */
  urgent: TaskState | null
  collapsed: boolean
  controls: string
  onToggle: () => void
  onNewTask?: () => void
}) {
  return (
    <div className="group relative">
      <h2>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : controls}
          title={path}
          data-workspace-heading
          className={cn(
            'flex h-7 w-full items-center gap-2 rounded-md pl-2 text-left text-sm font-medium text-fg-strong vy-transition hover:bg-surface focus-visible:vy-focus-ring',
            // Room for the + after the chevron, on hover or focus — the row's ⋯ rule.
            onNewTask ? 'pr-2 group-hover:pr-7 group-focus-within:pr-7' : 'pr-2'
          )}
          onClick={onToggle}
        >
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {collapsed ? (
            <>
              {urgent ? (
                <span className="inline-flex shrink-0" data-heading-urgent={urgent}>
                  <StatusGlyph state={urgent} size={14} />
                </span>
              ) : null}
              <Icon name="chevronRight" size={11} className="shrink-0 text-tertiary" />
              <span className="min-w-[3ch] shrink-0 text-right font-mono text-caption font-normal text-tertiary tnum">
                {count}
              </span>
            </>
          ) : (
            // The span hides it, not the Icon: Icon's own inline-block would win over `hidden`.
            <span data-heading-chevron className="hidden shrink-0 group-focus-within:flex group-hover:flex">
              <Icon name="chevron" size={11} className="text-tertiary" />
            </span>
          )}
        </button>
      </h2>
      {onNewTask ? (
        <span className="absolute inset-y-0 right-1 hidden items-center group-focus-within:flex group-hover:flex">
          <IconButton icon="plus" label={`New task in ${name}`} size="xs" tone="muted" onClick={onNewTask} />
        </span>
      ) : null}
    </div>
  )
}

const STATE_ITEMS: ReadonlyArray<{ key: NavStateFilter; label: string }> = [
  { key: 'needs', label: 'Needs you' },
  { key: 'running', label: 'Running' },
  { key: 'review', label: 'Ready for review' },
  { key: 'failed', label: 'Failed' },
  { key: 'drafts', label: 'Drafts' },
  { key: 'done', label: 'Done' }
]

const WHERE_ITEMS: ReadonlyArray<{ key: NavWhereFilter; label: string }> = [
  { key: 'inPlace', label: 'In place' },
  { key: 'worktree', label: 'In a worktree' }
]

function toggled<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item]
}

/**
 * What the list shows: a checklist of states and of where a task runs (every
 * one ticked until you untick it), Unread only, archived tasks, and folding
 * every workspace at once. A dot on the icon says a filter is hiding something.
 */
function ViewMenu({
  view,
  grouped,
  openPaths,
  onChange
}: {
  view: NavigatorView
  grouped: boolean
  openPaths: readonly string[]
  onChange: ViewUpdate
}) {
  const [open, setOpen] = useState(false)
  const filterOn = navFilterActive(view)
  const foldReason = 'Only while every workspace is listed'
  const items: ActionMenuItem[] = [
    ...STATE_ITEMS.map(({ key, label }) => ({
      id: `state:${key}`,
      label,
      checked: !view.hiddenStates.includes(key),
      keepOpen: true,
      onSelect: () => onChange((prev) => ({ ...prev, hiddenStates: toggled(prev.hiddenStates, key) }))
    })),
    {
      id: 'unread',
      label: 'Unread only',
      checked: view.unreadOnly,
      keepOpen: true,
      onSelect: () => onChange((prev) => ({ ...prev, unreadOnly: !prev.unreadOnly }))
    },
    ...WHERE_ITEMS.map(({ key, label }, i) => ({
      id: `where:${key}`,
      label,
      checked: !view.hiddenWhere.includes(key),
      separatorBefore: i === 0,
      keepOpen: true,
      onSelect: () => onChange((prev) => ({ ...prev, hiddenWhere: toggled(prev.hiddenWhere, key) }))
    })),
    {
      id: 'archived',
      label: 'Show archived',
      checked: view.showArchived,
      separatorBefore: true,
      keepOpen: true,
      onSelect: () => onChange((prev) => ({ ...prev, showArchived: !prev.showArchived }))
    },
    {
      id: 'collapse',
      label: 'Collapse all',
      separatorBefore: true,
      disabled: !grouped,
      disabledReason: foldReason,
      onSelect: () => onChange((prev) => ({ ...prev, collapsed: [...openPaths] }))
    },
    {
      id: 'expand',
      label: 'Expand all',
      disabled: !grouped,
      disabledReason: foldReason,
      onSelect: () => onChange((prev) => ({ ...prev, collapsed: [] }))
    },
    ...(filterOn
      ? [
          {
            id: 'reset',
            label: 'Show all tasks',
            separatorBefore: true,
            onSelect: () => onChange((prev) => ({ ...prev, ...NO_NAV_FILTER }))
          }
        ]
      : [])
  ]
  return (
    <ActionMenu
      open={open}
      onOpenChange={setOpen}
      placement="down"
      align="end"
      aria-label="View"
      items={items}
      trigger={(t) => (
        <span className="relative inline-flex">
          <IconButton
            ref={t.ref}
            icon="filter"
            label={filterOn ? 'View, filtered' : 'View'}
            size="xs"
            active={open}
            aria-expanded={t['aria-expanded']}
            aria-controls={t['aria-controls']}
            aria-haspopup={t['aria-haspopup']}
            data-navigator-view
            onClick={t.onClick}
          />
          {filterOn ? (
            <span
              aria-hidden="true"
              data-filter-dot
              className="pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-accent"
            />
          ) : null}
        </span>
      )}
    />
  )
}

/**
 * A group's name, said once: the name on the left edge, and on the right its
 * state glyph (none for history) beside its count.
 */
function GroupHeading({ id, glyph, label, count }: { id: string; glyph: TaskState | null; label: string; count: number }) {
  return (
    <h3 id={id} className="flex h-7 items-center gap-2 px-2 text-xs font-medium text-muted">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {glyph ? <StatusGlyph state={glyph} size={14} /> : null}
      <span className="shrink-0 font-mono text-caption font-normal text-tertiary tnum">{count}</span>
    </h3>
  )
}

function TaskSection({
  id,
  section,
  date,
  selected,
  isRunOpen,
  actions,
  onNavKeyDown,
  trailing = null
}: {
  id: string
  section: NavSection
  /** Set for one of Earlier's days. */
  date?: string
  selected: { workspacePath: string; runId: string } | null
  isRunOpen?: (workspacePath: string, runId: string) => boolean
  actions: NavigatorRowActions
  onNavKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void
  trailing?: ReactNode
}) {
  const group = GROUP_STATE[section.key]
  return (
    <section
      aria-labelledby={id}
      data-nav-section={date ? undefined : section.key}
      data-nav-date={date}
    >
      <GroupHeading id={id} glyph={group.glyph} label={section.label} count={section.rows.length} />
      <ul className="space-y-px">
        {section.rows.map((row: NavRow) => (
          <NavigatorTaskRow
            key={`${row.workspacePath}::${row.runId}`}
            row={row}
            groupState={group.rows}
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
      {trailing}
    </section>
  )
}

/** A place in the foot: an icon, named by its tooltip, filled while you're on it. */
function PlaceButton({
  icon,
  label,
  place,
  active,
  onClick
}: {
  icon: IconName
  label: string
  place: string
  active: boolean
  onClick: () => void
}) {
  return (
    <IconButton
      icon={icon}
      label={label}
      size="md"
      active={active}
      aria-current={active ? 'page' : undefined}
      data-place={place}
      onClick={onClick}
    />
  )
}

/**
 * Filters the list, and is where workspaces are opened and closed. Close names
 * the one workspace the list is showing; while it shows all of them there is
 * no single one to close, so the item is not offered.
 */
function WorkspaceScope({
  openPaths,
  scopePath,
  onScopeChange,
  onAddWorkspace,
  recentPaths,
  onOpenRecent,
  onCloseWorkspace
}: {
  openPaths: readonly string[]
  scopePath: string | null
  onScopeChange: (path: string | null) => void
  onAddWorkspace: () => void
  recentPaths: readonly string[]
  onOpenRecent?: (path: string) => void
  onCloseWorkspace: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  // One workspace open: "All workspaces" would name a choice there isn't.
  const shown = scopePath ?? (openPaths.length === 1 ? openPaths[0]! : null)
  const label = shown ? formatWorkspaceName(shown) : openPaths.length > 0 ? 'All workspaces' : 'No workspace'
  const items: ActionMenuItem[] = [
    ...(openPaths.length > 1 || scopePath
      ? [{ id: 'all', label: 'All workspaces', checked: scopePath === null, onSelect: () => onScopeChange(null) }]
      : []),
    ...openPaths.map((path) => ({
      id: `ws:${path}`,
      label: formatWorkspaceName(path),
      checked: shown != null && workspacePathsEqual(shown, path),
      onSelect: () => onScopeChange(path)
    })),
    // Folders opened before and closed since: one click opens one again.
    ...(onOpenRecent
      ? recentPaths.map((path, i) => ({
          id: `recent:${path}`,
          label: formatWorkspaceName(path),
          heading: i === 0 ? 'Recent' : undefined,
          separatorBefore: i === 0,
          onSelect: () => onOpenRecent(path)
        }))
      : []),
    { id: 'add', label: 'Add workspace…', separatorBefore: true, onSelect: onAddWorkspace },
    ...(shown ? [{ id: 'close', label: `Close ${formatWorkspaceName(shown)}`, onSelect: () => onCloseWorkspace(shown) }] : [])
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
          title={shown ?? undefined}
          data-workspace-scope
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-sm font-medium text-fg-strong vy-transition hover:bg-surface focus-visible:vy-focus-ring"
        >
          <span className="min-w-0 truncate">{label}</span>
          <Icon name="chevron" size={11} className="shrink-0 text-tertiary" />
        </button>
      )}
    />
  )
}
