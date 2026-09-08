import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefCallback
} from 'react'
import type {
  AgentInteractionMode,
  AttachedFile,
  ComposerSendExtras,
  ProviderId,
  RunSummary,
  SecretProvider,
  ServiceTier
} from '@shared/ipc'
import type { ChatSettingsPatch, EffectiveChatSettings } from '@shared/effectiveSettings'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { Icon } from '@renderer/lib/icons'
import { Button, IconButton, cn } from '@renderer/lib/ui'
import { useRovingTabIndex } from '@renderer/lib/a11y'
import { Composer } from '@renderer/features/chat/components/composer'
import { buildComposerSendProps } from '@renderer/features/chat/hooks/composerShared'
import type { SlashClientHandlers } from '@renderer/features/chat/components/composer/slashCommandExecute'
import { groupRunsByRecency } from '@renderer/lib/utils/groupRunsByRecency'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { runTitle } from '@renderer/app/sidebar/runTitle'
import { InlineConfirmActions } from '@renderer/app/sidebar/InlineConfirmActions'
import type { WorkspaceSidebarRuns } from '@renderer/app/sidebar/types'
import { pinnedRunKey } from './pinnedRuns'
import { useRunStats } from './useRunStats'
import { ContinueStrip } from './ContinueStrip'
import { filterRecentEntries } from './sessionFilter'
import { useWorkspaceGitSummaries } from './useWorkspaceGitSummaries'

/** Cross-workspace recency cap for the Home surface. */
const RECENT_RUN_CAP = 24
const SECTION_LABEL = 'text-xs font-medium uppercase tracking-wider text-muted'

type RecentEntry = { workspacePath: string; run: RunSummary }

/** Compact integer formatting for the usage strip (999 / 12.3K / 1.23M). */
function fmtCompact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function pinnedKeyOf(entry: RecentEntry): string {
  return pinnedRunKey(entry.workspacePath, entry.run.runId)
}

function WorkspaceCard({
  path,
  name,
  sessionCount,
  running,
  gitSummary,
  onSwitch,
  onNewChat
}: {
  path: string
  name: string
  sessionCount: number
  running: boolean
  gitSummary?: { branch: string | null; changedFiles: number }
  onSwitch: (path: string) => void
  onNewChat: (path: string) => void
}) {
  return (
    <div className="group relative min-h-[7rem] overflow-hidden rounded-xl border border-border bg-surface/40 vy-transition focus-within:border-border-strong hover:border-border-strong hover:bg-surface/70">
      {/* Full-card switch target: a real button keeps click + keyboard parity
          without nesting interactive elements (jsx-a11y). */}
      <button
        type="button"
        className="absolute inset-0 z-0 rounded-xl focus-visible:vy-focus-ring"
        aria-label={`Open workspace ${name}`}
        onClick={() => onSwitch(path)}
      />
      <div className="pointer-events-none relative z-10 flex items-start gap-3 p-4">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-surface text-muted">
          <Icon name="folder" size={15} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{name}</p>
          <p className="mt-1 flex items-center gap-1.5 text-caption text-muted">
            {running ? (
              <span className="inline-flex shrink-0 items-center gap-1" title="Running in background">
                <span className="inline-block size-1.5 rounded-full bg-fg" aria-hidden="true" />
                Running
              </span>
            ) : null}
            <span className="min-w-0 truncate">
              {running ? '· ' : ''}
              {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'}
            </span>
            {gitSummary ? (
              <span className="min-w-0 truncate" title={gitSummary.branch ?? undefined}>
                {'· '}
                {gitSummary.branch ? `${gitSummary.branch} · ` : ''}
                {gitSummary.changedFiles > 0
                  ? `${gitSummary.changedFiles} changed`
                  : 'clean'}
              </span>
            ) : null}
          </p>
        </div>
      </div>
      <div className="pointer-events-none relative z-10 flex justify-end p-2 pt-0">
        <Button
          variant="subtle"
          className="pointer-events-auto min-h-7 gap-1 px-2 text-xs"
          onClick={() => onNewChat(path)}
        >
          <Icon name="plus" size={12} aria-hidden="true" />
          New chat
        </Button>
      </div>
    </div>
  )
}

function RecentRunRow({
  entry,
  running,
  active,
  focused,
  showWorkspaceBadge,
  pinned,
  labelContext,
  onTogglePinned,
  tabIndex,
  rowRef,
  onNavKeyDown,
  onSelect,
  onRename,
  onDelete,
  onExport
}: {
  entry: RecentEntry
  running: boolean
  active: boolean
  focused: boolean
  showWorkspaceBadge: boolean
  pinned: boolean
  /** Disambiguates the accessible name when the same run renders in two sections. */
  labelContext?: string
  onTogglePinned?: () => void
  tabIndex?: number
  rowRef?: RefCallback<HTMLElement>
  onNavKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void
  onSelect: (path: string, runId: string) => void
  onRename?: (path: string, runId: string, goal: string) => void
  onDelete?: (path: string, runId: string) => void
  onExport?: (path: string, runId: string) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [draft, setDraft] = useState(entry.run.goal ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  const renameCancelledRef = useRef(false)

  useEffect(() => {
    if (!renaming) return
    renameCancelledRef.current = false
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [renaming])

  const title = runTitle(entry.run)
  const workspace = formatWorkspaceName(entry.workspacePath)
  // With a single open workspace the badge is pure noise — every row shows the
  // same name — so the workspace context is only surfaced when it disambiguates.
  const rowAriaLabel = [
    title,
    showWorkspaceBadge ? `in ${workspace}` : null,
    running ? 'Running' : null,
    labelContext
  ]
    .filter((part): part is string => part != null)
    .join(', ')

  const commitRename = (): void => {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false
      return
    }
    const next = draft.trim()
    setRenaming(false)
    if (next && next !== (entry.run.goal ?? '').trim()) {
      onRename?.(entry.workspacePath, entry.run.runId, next)
    }
  }

  const hasHoverActions = Boolean(onTogglePinned || onRename || onDelete || onExport)

  return (
    <div role="listitem" className="group relative min-w-0">
      {renaming ? (
        <input
          ref={inputRef}
          type="text"
          data-vy-text-entry
          className="w-full rounded-md border border-border/50 bg-surface/60 px-2 py-1.5 text-sm text-fg outline-none focus:border-border-strong focus:bg-surface focus:vy-focus-ring"
          value={draft}
          aria-label="Rename chat"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename()
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              renameCancelledRef.current = true
              setRenaming(false)
              setDraft(entry.run.goal ?? '')
            }
          }}
          onBlur={commitRename}
        />
      ) : (
        <button
          type="button"
          ref={rowRef}
          tabIndex={tabIndex}
          className={cn(
            'app-region-no-drag flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm vy-transition',
            'group-hover:pr-24 group-focus-within:pr-24 [@media(hover:none)]:pr-24',
            'focus-visible:vy-focus-ring',
            active
              ? 'bg-surface text-fg-strong'
              : cn('text-fg/85', 'hover:bg-surface hover:text-fg')
          )}
          aria-current={focused ? 'page' : undefined}
          aria-label={rowAriaLabel}
          data-session-open={active ? '1' : '0'}
          data-session-focused={focused ? '1' : '0'}
          onClick={() => onSelect(entry.workspacePath, entry.run.runId)}
          onKeyDown={onNavKeyDown}
        >
          {running ? (
            <span className="inline-flex shrink-0" title="Running">
              <Icon name="loader" size={12} className="animate-spin text-fg" aria-hidden="true" />
            </span>
          ) : null}
          {pinned ? (
            <span className="shrink-0" title="Pinned">
              <Icon name="star" size={12} className="text-warning" aria-hidden="true" />
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {showWorkspaceBadge ? (
            <span className="shrink-0 rounded border border-border/60 px-1.5 py-0.5 text-[11px] text-muted">
              {workspace}
            </span>
          ) : null}
        </button>
      )}

      {!renaming && hasHoverActions ? (
        <div
          className={cn(
            'app-region-no-drag absolute inset-y-0 right-0 z-sticky flex items-center gap-0.5 pr-1 vy-transition pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
            '[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100',
            confirmingDelete && 'pointer-events-auto opacity-100'
          )}
        >
          {confirmingDelete && onDelete ? (
            <InlineConfirmActions
              size="sm"
              confirmLabel={`Confirm delete ${title}`}
              cancelLabel={`Cancel delete ${title}`}
              onConfirm={() => {
                setConfirmingDelete(false)
                onDelete(entry.workspacePath, entry.run.runId)
              }}
              onCancel={() => setConfirmingDelete(false)}
            />
          ) : (
            <>
              {onTogglePinned ? (
                <IconButton
                  icon="star"
                  label={pinned ? `Unpin ${title}` : `Pin ${title}`}
                  size="xs"
                  variant="bare"
                  className={pinned ? 'text-warning' : 'text-muted hover:text-fg'}
                  onClick={(e) => {
                    e.stopPropagation()
                    onTogglePinned()
                  }}
                />
              ) : null}
              {onRename ? (
                <IconButton
                  icon="edit"
                  label={`Rename ${title}`}
                  size="xs"
                  variant="bare"
                  className="text-muted hover:text-fg"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmingDelete(false)
                    // Re-sync to the current title — the mount-time seed goes
                    // stale after an external rename.
                    setDraft(entry.run.goal ?? '')
                    setRenaming(true)
                  }}
                />
              ) : null}
              {onExport ? (
                <IconButton
                  icon="download"
                  label={`Export ${title} as Markdown`}
                  size="xs"
                  variant="bare"
                  className="text-muted hover:text-fg"
                  onClick={(e) => {
                    e.stopPropagation()
                    onExport(entry.workspacePath, entry.run.runId)
                  }}
                />
              ) : null}
              {onDelete ? (
                <IconButton
                  icon="trash"
                  label={`Delete ${title}`}
                  size="xs"
                  variant="bare"
                  className="text-muted hover:text-danger"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmingDelete(true)
                  }}
                />
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

export function HomePage({
  openWorkspaces,
  activeWorkspacePath,
  runsByWorkspacePath,
  activeRuns,
  workspaceHasBackgroundRun,
  onNewSessionInWorkspace,
  onSelectRunInWorkspace,
  onSwitchWorkspace,
  onAddWorkspace,
  onSendInWorkspace,
  onDraftChangeInWorkspace,
  onRenameRunInWorkspace,
  onDeleteRunInWorkspace,
  onExportRunInWorkspace,
  isRunOpenInPane,
  isRunFocusedInPane,
  pinnedRunKeys,
  onTogglePinnedRun,
  provider,
  model,
  ollamaBaseUrl,
  customOpenAiBaseUrl,
  modelsRefreshKey,
  secrets,
  onProviderModel,
  favoriteModels = [],
  recentModels = [],
  serviceTier = 'default',
  onToggleFavorite = () => {},
  onServiceTierChange = () => {},
  chatSettings,
  onChatSettingsChange,
  agentMode = 'agent',
  onAgentModeChange = () => {},
  slashHandlers
}: {
  openWorkspaces: string[]
  activeWorkspacePath: string | null
  runsByWorkspacePath: Record<string, WorkspaceSidebarRuns>
  activeRuns?: { runId: string; workspacePath: string }[]
  workspaceHasBackgroundRun?: (path: string) => boolean
  onNewSessionInWorkspace: (path: string, goal: string) => void
  onSelectRunInWorkspace: (path: string, runId: string) => void
  onSwitchWorkspace: (path: string) => void
  onAddWorkspace: () => void
  /** Real composer send: starts the session in `path` with this first message. */
  onSendInWorkspace: (
    path: string,
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras
  ) => boolean | void | Promise<boolean | void>
  /** Composer draft persistence keyed to (path, null) — the fresh-chat draft. */
  onDraftChangeInWorkspace: (path: string, draft: string) => void
  onRenameRunInWorkspace?: (path: string, runId: string, goal: string) => void
  onDeleteRunInWorkspace?: (path: string, runId: string) => void
  onExportRunInWorkspace?: (path: string, runId: string) => void
  isRunOpenInPane?: (path: string, runId: string) => boolean
  isRunFocusedInPane?: (path: string, runId: string) => boolean
  /** Session keys (pinnedRunKey) pinned above the recency list. */
  pinnedRunKeys: string[]
  onTogglePinnedRun: (key: string) => void
  // — Real composer wiring (same sources the dock composer gets from App). —
  provider: ProviderId
  model: string
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  modelsRefreshKey?: string | number
  secrets: Record<SecretProvider, boolean>
  onProviderModel: (provider: ProviderId, model: string) => void
  favoriteModels?: string[]
  recentModels?: string[]
  serviceTier?: ServiceTier
  onToggleFavorite?: (provider: ProviderId, model: string) => void
  onServiceTierChange?: (tier: ServiceTier) => void
  chatSettings: EffectiveChatSettings
  onChatSettingsChange: (patch: ChatSettingsPatch) => void
  agentMode?: AgentInteractionMode
  onAgentModeChange?: (mode: AgentInteractionMode) => void
  slashHandlers?: SlashClientHandlers
}) {
  const hasWorkspaces = openWorkspaces.length > 0

  const [selectedPathOverride, setSelectedPathOverride] = useState<string | null>(null)
  const [sessionFilterQuery, setSessionFilterQuery] = useState('')

  // Composer target defaults to the active workspace, else the first open one.
  const selectedPath = useMemo(() => {
    if (
      selectedPathOverride &&
      openWorkspaces.some((p) => workspacePathsEqual(p, selectedPathOverride))
    ) {
      return selectedPathOverride
    }
    if (
      activeWorkspacePath &&
      openWorkspaces.some((p) => workspacePathsEqual(p, activeWorkspacePath))
    ) {
      return activeWorkspacePath
    }
    return openWorkspaces[0] ?? null
  }, [activeWorkspacePath, openWorkspaces, selectedPathOverride])

  const startFromHome = useCallback(
    async (
      text: string,
      images?: string[],
      files?: AttachedFile[],
      extras?: ComposerSendExtras
    ): Promise<boolean> => {
      if (!selectedPath) return false
      return (await onSendInWorkspace(selectedPath, text, images, files, extras)) !== false
    },
    [onSendInWorkspace, selectedPath]
  )

  const changeHomeDraft = useCallback(
    (draft: string): void => {
      if (selectedPath) onDraftChangeInWorkspace(selectedPath, draft)
    },
    [onDraftChangeInWorkspace, selectedPath]
  )

  // Same prop bag the dock composer receives — full model/mode/attachment
  // surface. `running` is always false on Home (no run to stop); onStop stays
  // a no-op that Composer never renders while idle.
  const composerProps = buildComposerSendProps({
    provider,
    model,
    running: false,
    hasWorkspace: Boolean(selectedPath),
    hasTranscript: false,
    workspacePath: selectedPath,
    ollamaBaseUrl,
    customOpenAiBaseUrl,
    modelsRefreshKey,
    secrets,
    onDraftChange: changeHomeDraft,
    onProviderModel,
    favoriteModels,
    recentModels,
    serviceTier,
    onToggleFavorite,
    onServiceTierChange,
    chatSettings,
    onChatSettingsChange,
    agentMode,
    onAgentModeChange,
    onSend: startFromHome,
    onStop: () => {},
    bannerError: null,
    secondaryBannerError: null,
    activeRunId: null,
    slashHandlers
  })

  const recentEntries = useMemo<RecentEntry[]>(() => {
    const out: RecentEntry[] = []
    for (const workspacePath of openWorkspaces) {
      const workspace = runsByWorkspacePath[workspacePath]
      if (!workspace) continue
      // Parent sessions only — instance runs stay folded under their parent in
      // the sidebar; surfacing them here duplicated one session as many rows.
      for (const run of workspace.runs) out.push({ workspacePath, run })
    }
    out.sort((a, b) =>
      a.run.updatedAt < b.run.updatedAt ? 1 : a.run.updatedAt > b.run.updatedAt ? -1 : 0
    )
    return out.slice(0, RECENT_RUN_CAP)
  }, [openWorkspaces, runsByWorkspacePath])

  // Same recency pattern as the sidebar (useSidebarChats): the util owns `now`.
  const recentGroups = useMemo(() => {
    const groups = groupRunsByRecency(recentEntries.map((entry) => entry.run))
    return groups.map((group) => ({
      id: group.id,
      label: group.label,
      entries: group.runs
        .map((run) => recentEntries.find((entry) => entry.run === run))
        .filter((entry): entry is RecentEntry => entry != null)
    }))
  }, [recentEntries])

  const flatEntries = useMemo(
    () => recentGroups.flatMap((group) => group.entries),
    [recentGroups]
  )

  const activeRunIds = useMemo(
    () => new Set((activeRuns ?? []).map((r) => r.runId)),
    [activeRuns]
  )

  // Live runs resolved to their summaries; a run beyond the recent cap is
  // recovered from the full per-workspace runs so the section never drops a
  // live run just because it is old.
  const runningNowEntries = useMemo<RecentEntry[]>(() => {
    if (!activeRuns || activeRuns.length === 0) return []
    const byKey = new Map(flatEntries.map((entry) => [pinnedKeyOf(entry), entry]))
    const out: RecentEntry[] = []
    for (const active of activeRuns) {
      const recent = byKey.get(pinnedRunKey(active.workspacePath, active.runId))
      if (recent) {
        out.push(recent)
        continue
      }
      const run = runsByWorkspacePath[active.workspacePath]?.runs.find(
        (r) => r.runId === active.runId
      )
      if (run) out.push({ workspacePath: active.workspacePath, run })
    }
    return out
  }, [activeRuns, flatEntries, runsByWorkspacePath])

  // Keys of the runs that render in Running now; the Recent list must not
  // repeat them — a live session owns exactly one row.
  const runningNowKeys = useMemo(
    () => new Set(runningNowEntries.map((entry) => pinnedKeyOf(entry))),
    [runningNowEntries]
  )

  // Pinned sessions resolve from every run in runsByWorkspacePath — not the
  // recency-capped recent list — so a pin older than the cap still renders.
  // Stale keys (deleted sessions) simply never match a listed run.
  const pinnedEntries = useMemo<RecentEntry[]>(() => {
    const out: RecentEntry[] = []
    for (const [workspacePath, workspace] of Object.entries(runsByWorkspacePath)) {
      for (const run of workspace.runs) {
        if (pinnedRunKeys.includes(pinnedRunKey(workspacePath, run.runId))) {
          out.push({ workspacePath, run })
        }
      }
    }
    out.sort((a, b) =>
      a.run.updatedAt < b.run.updatedAt ? 1 : a.run.updatedAt > b.run.updatedAt ? -1 : 0
    )
    return out
  }, [runsByWorkspacePath, pinnedRunKeys])

  // Final rendered set for Recent: client-side filter (title + workspace name)
  // over the recency-ordered entries, minus the live runs shown in Running now.
  const displayedEntries = useMemo(
    () =>
      filterRecentEntries(flatEntries, sessionFilterQuery).filter(
        (entry) => !runningNowKeys.has(pinnedKeyOf(entry))
      ),
    [flatEntries, sessionFilterQuery, runningNowKeys]
  )

  // Same groups as the unfiltered list, narrowed to the rendered entries —
  // no second recency pass.
  const displayedGroups = useMemo(() => {
    const shown = new Set(displayedEntries.map((entry) => pinnedKeyOf(entry)))
    return recentGroups
      .map((group) => ({
        id: group.id,
        label: group.label,
        entries: group.entries.filter((entry) => shown.has(pinnedKeyOf(entry)))
      }))
      .filter((group) => group.entries.length > 0)
  }, [recentGroups, displayedEntries])

  const [navIndex, setNavIndex] = useState(0)

  const navIndexByKey = useMemo(() => {
    const map = new Map<string, number>()
    displayedEntries.forEach((entry, index) => {
      map.set(pinnedKeyOf(entry), index)
    })
    return map
  }, [displayedEntries])

  const { tabIndexFor, setOptionRef, onContainerKeyDown } = useRovingTabIndex({
    count: displayedEntries.length,
    activeIndex: navIndex,
    onActiveIndexChange: setNavIndex,
    orientation: 'vertical'
  })

  // Keep the roving tab stop inside the filtered list: a stale navIndex past
  // the end would leave every row at tabIndex -1 with no Tab entry point.
  useEffect(() => {
    setNavIndex((i) => Math.min(i, Math.max(0, displayedEntries.length - 1)))
  }, [displayedEntries.length])

  // Continue cards resume idle sessions; live ones already own Running now.
  const continueEntries = useMemo(
    () =>
      flatEntries.filter(
        (entry) => entry.run.status !== 'running' && !activeRunIds.has(entry.run.runId)
      ),
    [flatEntries, activeRunIds]
  )

  const stats = useRunStats(openWorkspaces, runsByWorkspacePath)
  // One-shot per workspace set while Home is mounted — no polling (perf rule).
  const gitSummaries = useWorkspaceGitSummaries(openWorkspaces, hasWorkspaces)

  // Real aggregates over the displayed sessions only. Token sums come from
  // receipt.json tokenUsage; runs without receipts contribute nothing (the
  // segments stay hidden rather than showing fake zeros).
  const usage = useMemo(() => {
    let messages = 0
    let billedInput = 0
    let output = 0
    let withTokens = false
    for (const entry of displayedEntries) {
      const stat = stats[entry.run.runId]
      if (!stat) continue
      messages += stat.messages
      if (stat.tokenUsage) {
        withTokens = true
        billedInput += stat.tokenUsage.billedInputTokens ?? 0
        output += stat.tokenUsage.outputTokens ?? 0
      }
    }
    return { messages, billedInput, output, withTokens }
  }, [displayedEntries, stats])
  const showUsage = displayedEntries.length > 0 && Object.keys(stats).length > 0

  if (!hasWorkspaces) {
    return (
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[960px] px-6 py-10">
          <section
            aria-labelledby="home-empty-heading"
            className="flex flex-col items-center gap-3 py-24 text-center"
          >
            <Icon name="folderPlus" size={28} className="text-muted" aria-hidden="true" />
            <h2 id="home-empty-heading" className="text-lg font-semibold text-fg">
              Add your first workspace
            </h2>
            <p className="max-w-sm text-sm text-muted">
              Point Vyotiq at a project folder to start sessions, track runs, and review changes.
            </p>
            <Button onClick={onAddWorkspace}>
              <Icon name="plus" size={14} aria-hidden="true" />
              Add workspace
            </Button>
          </section>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[960px] px-6 pb-16 pt-12">
      <div className="flex flex-col items-center text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">
          What should we work on?
        </h1>
        <p className="mt-2 max-w-md text-sm text-muted">
          {openWorkspaces.length === 1 && selectedPath
            ? `Describe the task and send — the session starts in ${formatWorkspaceName(selectedPath)}.`
            : 'Pick a workspace, describe the task, and send — the session starts right here.'}
        </p>
      </div>

      {openWorkspaces.length > 1 ? (
        <div
          role="group"
          aria-label="Session workspace"
          className="mt-6 flex flex-wrap items-center justify-center gap-1.5"
        >
          {openWorkspaces.map((path) => {
            const selected = Boolean(selectedPath && workspacePathsEqual(selectedPath, path))
            return (
              <button
                key={path}
                type="button"
                aria-pressed={selected}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium vy-transition focus-visible:vy-focus-ring',
                  selected
                    ? 'border-border-strong bg-surface text-fg'
                    : 'border-border/60 text-muted hover:border-border-strong hover:bg-surface/60 hover:text-fg'
                )}
                onClick={() => setSelectedPathOverride(path)}
              >
                <Icon name="folder" size={12} className="mr-1.5 inline-block align-[-1px]" aria-hidden="true" />
                {formatWorkspaceName(path)}
              </button>
            )
          })}
        </div>
      ) : null}

      {/* The real composer — identical model picker, mode, attachments, slash,
          mentions, and dictation as the chat dock. Drafts and attachments key
          to (workspace, null), so a draft typed here is waiting in the chat. */}
      <div className="mx-auto mt-8 w-full max-w-[760px]">
        <Composer {...composerProps} variant="hero" />
      </div>

      {continueEntries.length > 0 ? (
        <div className="mt-12">
          <ContinueStrip
            entries={continueEntries}
            runningRunIds={activeRunIds}
            onSelect={onSelectRunInWorkspace}
          />
        </div>
      ) : null}

      {runningNowEntries.length > 0 ? (
        <section aria-labelledby="home-running-heading" className="mt-12">
          <h2 id="home-running-heading" className={SECTION_LABEL}>
            Running now
          </h2>
          <div role="list" className="mt-2 flex flex-col gap-1">
            {runningNowEntries.map((entry) => (
              <RecentRunRow
                key={`running:${pinnedKeyOf(entry)}`}
                entry={entry}
                running
                active={isRunOpenInPane?.(entry.workspacePath, entry.run.runId) ?? false}
                focused={isRunFocusedInPane?.(entry.workspacePath, entry.run.runId) ?? false}
                showWorkspaceBadge={openWorkspaces.length > 1}
                pinned={pinnedRunKeys.includes(pinnedKeyOf(entry))}
                labelContext="from Running now"
                onTogglePinned={() => onTogglePinnedRun(pinnedKeyOf(entry))}
                onSelect={onSelectRunInWorkspace}
                onRename={onRenameRunInWorkspace}
                onDelete={onDeleteRunInWorkspace}
                onExport={onExportRunInWorkspace}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="home-workspaces-heading" className="mt-14">
        <h2 id="home-workspaces-heading" className={SECTION_LABEL}>
          Workspaces
        </h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {openWorkspaces.map((path) => {
            const workspace = runsByWorkspacePath[path]
            // Instances are sub-runs of a session, not sessions themselves.
            const sessionCount = workspace?.runs.length ?? 0
            return (
              <WorkspaceCard
                key={path}
                path={path}
                name={formatWorkspaceName(path)}
                sessionCount={sessionCount}
                running={workspaceHasBackgroundRun?.(path) ?? false}
                gitSummary={gitSummaries[path]}
                onSwitch={onSwitchWorkspace}
                onNewChat={(p) => onNewSessionInWorkspace(p, '')}
              />
            )
          })}
          <button
            type="button"
            className="flex min-h-[7rem] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-transparent text-muted vy-transition hover:border-border-strong hover:bg-surface hover:text-fg focus-visible:vy-focus-ring"
            onClick={onAddWorkspace}
          >
            <Icon name="folderPlus" size={20} aria-hidden="true" />
            <span className="text-sm font-medium">Add workspace</span>
          </button>
        </div>
      </section>

      {pinnedEntries.length > 0 ? (
        <section aria-labelledby="home-pinned-heading" className="mt-12">
          <h2 id="home-pinned-heading" className={SECTION_LABEL}>
            Pinned
          </h2>
          <div role="list" className="mt-2 flex flex-col gap-1">
            {pinnedEntries.map((entry) => {
              const key = pinnedKeyOf(entry)
              return (
                <RecentRunRow
                  key={key}
                  entry={entry}
                  running={entry.run.status === 'running' || activeRunIds.has(entry.run.runId)}
                  active={isRunOpenInPane?.(entry.workspacePath, entry.run.runId) ?? false}
                  focused={
                    isRunFocusedInPane?.(entry.workspacePath, entry.run.runId) ?? false
                  }
                  showWorkspaceBadge={openWorkspaces.length > 1}
                  pinned
                  onTogglePinned={() => onTogglePinnedRun(key)}
                  onSelect={onSelectRunInWorkspace}
                  onRename={onRenameRunInWorkspace}
                  onDelete={onDeleteRunInWorkspace}
                  onExport={onExportRunInWorkspace}
                />
              )
            })}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="home-recent-heading" className="mt-12">
        <h2 id="home-recent-heading" className={SECTION_LABEL}>
          Recent sessions
        </h2>
        {flatEntries.length > 0 ? (
          <input
            type="search"
            value={sessionFilterQuery}
            aria-label="Filter sessions"
            placeholder="Filter sessions…"
            data-vy-text-entry
            className="mt-3 w-full max-w-sm rounded-md border border-border/50 bg-surface/60 px-3 py-1.5 text-sm text-fg outline-none focus:border-border-strong focus:bg-surface focus:vy-focus-ring"
            onChange={(e) => setSessionFilterQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                setSessionFilterQuery('')
              }
            }}
          />
        ) : null}
        {showUsage ? (
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span>
              {displayedEntries.length}{' '}
              {displayedEntries.length === 1 ? 'session' : 'sessions'}
            </span>
            <span>
              {fmtCompact(usage.messages)} {usage.messages === 1 ? 'message' : 'messages'}
            </span>
            {usage.withTokens ? (
              <>
                <span title="Cumulative billed input tokens across run receipts">
                  {fmtCompact(usage.billedInput)} billed input
                </span>
                <span title="Cumulative output tokens across run receipts">
                  {fmtCompact(usage.output)} output
                </span>
              </>
            ) : null}
          </p>
        ) : null}
        {displayedEntries.length > 0 ? (
          <div role="list" className="mt-2 flex flex-col gap-1">
            {displayedGroups.map((group) => (
              <div key={group.id} className="flex flex-col gap-1">
                <p className={cn(SECTION_LABEL, 'mt-3 opacity-80')}>{group.label}</p>
                <div className="flex flex-col gap-px">
                  {group.entries.map((entry) => {
                    const key = pinnedKeyOf(entry)
                    const index = navIndexByKey.get(key) ?? -1
                    return (
                      <RecentRunRow
                        key={key}
                        entry={entry}
                        // Sidebar derives the spinner from run.status
                        // (ChatRow RunStatusDot); activeRuns covers live
                        // controllers the runs list may not reflect yet.
                        running={
                          entry.run.status === 'running' ||
                          activeRunIds.has(entry.run.runId)
                        }
                        active={isRunOpenInPane?.(entry.workspacePath, entry.run.runId) ?? false}
                        focused={
                          isRunFocusedInPane?.(entry.workspacePath, entry.run.runId) ?? false
                        }
                        showWorkspaceBadge={openWorkspaces.length > 1}
                        pinned={pinnedRunKeys.includes(key)}
                        onTogglePinned={() => onTogglePinnedRun(key)}
                        tabIndex={index >= 0 ? tabIndexFor(index) : undefined}
                        rowRef={index >= 0 ? setOptionRef(index) : undefined}
                        onNavKeyDown={onContainerKeyDown}
                        onSelect={onSelectRunInWorkspace}
                        onRename={onRenameRunInWorkspace}
                        onDelete={onDeleteRunInWorkspace}
                        onExport={onExportRunInWorkspace}
                      />
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : flatEntries.length === 0 ? (
          <p className="mt-2 text-sm text-muted">
            No sessions yet — start your first session.
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted">No sessions match this filter.</p>
        )}
      </section>
      </div>
    </main>
  )
}
