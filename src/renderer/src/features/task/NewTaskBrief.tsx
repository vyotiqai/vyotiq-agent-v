import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { CompareModelOption } from './compareModels'
import {
  TASK_DRAFT_CHECK_CHARS_MAX,
  TASK_DRAFT_CHECKS_MAX,
  type McpServerStatus,
  type ToolApprovalMode,
  type ToolApprovalSettings,
  type ToolCatalogResult
} from '@shared/ipc'
import { relativeTimeAgo } from '@shared/utils/timeFormat'
import { MAX_EXTRA_ROOTS, extraRootLabel } from '@shared/extraRoots'
import { Button, IconButton, Keys, Menu, Segmented, cn, type MenuOption } from '@renderer/lib/ui'
import { Icon, type IconName } from '@renderer/lib/icons'
import { BORDER_DIVIDER, NUM, ROW_HOVER, SECTION_LABEL } from '@renderer/lib/utils/layout'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { useAgentContext } from '@renderer/features/chat/components/useAgentContext'
import { useGitInit } from '@renderer/features/chat/components/useGitInit'
import { useGitStatus } from '@renderer/features/chat/components/useGitStatus'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { ruleFileCountLabel, ruleRootFiles } from './ruleSummary'
import { requestRepeatTask } from '@renderer/features/schedules/scheduleRequests'

/** Where a new task can be moved to: the open workspaces. */
export type NewTaskTargets = {
  workspaces: ReadonlyArray<{ path: string; name: string }>
  /** Start the new task over in another workspace, carrying the brief across. */
  onMove: (workspacePath: string, brief: string) => void
}

/** The schema's bounds on the brief's checks — the same Structure's Done when moves within. */
const MAX_CHECKS = TASK_DRAFT_CHECKS_MAX
const CHECK_MAX_CHARS = TASK_DRAFT_CHECK_CHARS_MAX

const APPROVAL_NOTE: Record<ToolApprovalMode, string> = {
  off: 'Runs its tools without asking',
  mutating: 'Asks before edits and commands',
  all: 'Asks before every tool'
}

const INDEX_LABEL = { ready: 'Ready', building: 'Building', degraded: 'Degraded', off: 'Off', paused: 'Paused' } as const

export function startChord(): string {
  return window.vyotiq?.platform === 'darwin' ? '⌘↵' : 'Ctrl+Enter'
}

/** The same chord as keycaps, for the quiet line under the box. */
export function startChordKeys(): string[] {
  return window.vyotiq?.platform === 'darwin' ? ['⌘', '↵'] : ['Ctrl', '↵']
}

/** Where the facts beside the brief lead: the page where each one is changed. */
export type NewTaskFactTarget = 'agent' | 'tools' | 'indexing'

/**
 * Starting a task is filling in a brief, not opening a chat. The brief is one
 * box: what to do, the checks the run is judged against, and how it runs (the
 * composer's own control row, which ends in the page's one action, Start task.
 * Where it runs is the header, as icons; under the box, what
 * the agent will see, each fact a way to where you change it. The brief
 * itself is the composer's input, so @ context, attachments and / skills
 * work here as they do on the instruction line.
 */
export function NewTaskBrief({
  workspacePath,
  targets,
  brief,
  input,
  attachments,
  controls,
  banners,
  fileInput,
  menus,
  onDragOver,
  onDrop,
  approval,
  canStart,
  onChecksChange,
  onStart,
  onOpenSettings,
  onOpenRules,
  headerActions,
  checks,
  onChecksEdit,
  clearToken,
  draft,
  worktree = false,
  onWorktreeChange,
  extraRoots = NO_FOLDERS,
  onAddFolder,
  onExtraRootsChange,
  compare,
  voice
}: {
  workspacePath: string | null
  targets?: NewTaskTargets
  /** The brief as typed — carried across when the task moves workspace. */
  brief: string
  input: ReactNode
  attachments: ReactNode
  /**
   * Mode, model · effort, attach and mic — the row every composer ends with.
   * A dictation take's strip stands in for it while there is one.
   */
  controls: ReactNode
  banners: ReactNode
  fileInput: ReactNode
  menus: ReactNode
  /** Files dropped anywhere on the box attach. */
  onDragOver?: (event: DragEvent<HTMLElement>) => void
  onDrop?: (event: DragEvent<HTMLElement>) => void
  /** How tools ask before they run — said once, beside Start task. */
  approval?: ToolApprovalSettings | null
  canStart: boolean
  /** The checks as they stand, a half-typed one included — whatever starts the task sends them. */
  onChecksChange: (doneWhen: string[]) => void
  onStart: () => void
  /** Settings → Agent from the approvals line; Tools and Indexing from their facts. */
  onOpenSettings?: (section: NewTaskFactTarget) => void
  /** Extensions → Rules, from the Rules fact. */
  onOpenRules?: () => void
  /** The pane's own controls: show the inspector, close a split pane. */
  headerActions?: ReactNode
  /** The checks added so far — kept per workspace, so leaving New task keeps them. */
  checks: string[]
  onChecksEdit: (next: string[]) => void
  /** Changes when the page was emptied (a draft saved): drops a half-typed check. */
  clearToken?: number
  /** Save as draft: put this brief aside. `continuing` when it came from one. */
  draft?: { onSave: () => void; canSave: boolean; saving: boolean; continuing: boolean }
  /** Start it in a new worktree of this workspace instead of in this folder. */
  worktree?: boolean
  onWorktreeChange?: (worktree: boolean) => void
  /** Folders outside the workspace the task may also read and edit (absolute). */
  extraRoots?: readonly string[]
  /** Add folder…: the OS picker, checked by main. Absent hides the row. */
  onAddFolder?: () => void
  onExtraRootsChange?: (next: string[]) => void
  /**
   * Also run on: a second model for the same brief. Start then makes two
   * tasks, each in its own worktree, to compare side by side. Absent hides it.
   */
  compare?: { options: readonly CompareModelOption[]; value: string | null; onChange: (next: string | null) => void }
  /**
   * Voice mode's bar, while it's open here: it takes the brief's place, and
   * the first thing said starts the task (docs/voice-mode.md §13.5).
   */
  voice?: ReactNode
}) {
  const [draftCheck, setDraftCheck] = useState('')

  useEffect(() => {
    if (clearToken) setDraftCheck('')
  }, [clearToken])

  // Ctrl/Cmd+Enter in the brief starts the task too, so the composer holds
  // the checks as they are now rather than being handed them on a click.
  const pending = draftCheck.trim().slice(0, CHECK_MAX_CHARS)
  const onChecksChangeRef = useRef(onChecksChange)
  onChecksChangeRef.current = onChecksChange
  useEffect(() => {
    onChecksChangeRef.current(pending && checks.length < MAX_CHECKS ? [...checks, pending] : checks)
  }, [checks, pending])

  const addCheck = (): void => {
    const text = draftCheck.trim().slice(0, CHECK_MAX_CHARS)
    if (!text || checks.length >= MAX_CHECKS) return
    onChecksEdit([...checks, text])
    setDraftCheck('')
  }

  const onCheckKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      if (canStart) onStart()
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      addCheck()
    } else if (event.key === 'Escape' && draftCheck) {
      // Only a half-typed check is Escape's here; an empty field lets it through.
      event.preventDefault()
      event.stopPropagation()
      setDraftCheck('')
    }
  }

  return (
    // The pane around it is already the "New task" region.
    <div className="flex min-h-0 flex-1 flex-col bg-bg" data-new-task>
      <header
        className="@container flex h-10 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2 text-xs text-muted"
        data-task-header
      >
        <h1 className="mr-2 shrink-0 whitespace-nowrap text-sm font-semibold text-fg-strong">New task</h1>
        {workspacePath ? (
          <>
            {/* The header reads as a line: a new task, in this folder, on this
                branch. The words stay quieter than the two names they hold. */}
            <span className="shrink-0 text-tertiary">in</span>
            <span className="flex min-w-0 items-center gap-1">
              <Icon name="workspace" size={13} className="shrink-0 text-tertiary" />
              <WorkspaceSelect workspacePath={workspacePath} targets={targets} brief={brief} />
            </span>
            <span className="ml-1 flex min-w-0 items-center gap-1">
              <Icon name="branch" size={13} className="shrink-0 text-tertiary" />
              <BranchSelect workspacePath={workspacePath} />
            </span>
          </>
        ) : null}
        <span className="flex-1" />
        {workspacePath && onWorktreeChange ? (
          <WhereItWorks workspacePath={workspacePath} worktree={worktree} onWorktreeChange={onWorktreeChange} />
        ) : null}
        {headerActions}
      </header>

      {/* The workbench: the brief keeps the record's measure on the left, and
          what the agent will see reads beside it on the right. Under 1100px of
          column the rail falls under the brief — the field keeps the whole
          width there, which is what a split pane or an open inspector leaves. */}
      <div className="@container scroll-thin min-h-0 flex-1 overflow-y-auto">
        {/* 1180 = the record's 780 measure + the 40px gutter + the 296px rail,
            so the brief is exactly as wide as the steps it becomes. */}
        <div className="mx-auto min-h-full w-full max-w-[1180px] px-5 pb-16 pt-10 @[720px]:px-8 @[900px]:pt-16 @[1100px]:grid @[1100px]:grid-cols-[minmax(0,1fr)_296px] @[1100px]:items-start @[1100px]:gap-x-10 @[1400px]:pt-24">
          <div className="mx-auto w-full max-w-[780px]">
            {banners}
            {voice ?? (
              <>
            <div
              className="rounded-lg border border-border bg-bg vy-transition focus-within:border-border-strong"
              data-brief
              // The composer's shell: Ctrl+. typed in the brief switches this box's mode.
              data-composer-shell
              onDragOver={onDragOver}
              onDrop={onDrop}
            >
              {fileInput}
              <div className="px-4 pt-3.5">{input}</div>
              {attachments ? <div className="px-4 pt-2">{attachments}</div> : null}
              {/* The checks the run is judged against are part of the brief:
                  the field for the next one is always there, so the first
                  check is one click into it, not two. */}
              <div className={cn('mt-3 border-t py-1 pl-4 pr-2', BORDER_DIVIDER)} data-done-when>
                {checks.length > 0 ? (
                  <div className="flex items-baseline gap-2 pb-0.5 pt-1">
                    <span className={SECTION_LABEL}>Done when</span>
                    <span className={cn(NUM, 'text-tertiary')}>{checks.length}</span>
                  </div>
                ) : null}
                {checks.length > 0 ? (
                  <ul className="m-0 list-none p-0" aria-label="Done when">
                    {checks.map((text, index) => (
                      // The row number is the check's id in the record (c1, c2…),
                      // so the brief and the run's ledger read one list.
                      <li key={`${index}:${text}`} className="group flex h-7 items-center gap-2.5">
                        <span className={cn(NUM, 'w-4 shrink-0 text-right text-tertiary')}>{index + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-xs text-fg" title={text}>
                          {text}
                        </span>
                        <IconButton
                          icon="close"
                          label={`Remove “${text}”`}
                          size="xs"
                          tone="muted"
                          className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                          onClick={() => onChecksEdit(checks.filter((_, i) => i !== index))}
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
                {checks.length < MAX_CHECKS ? (
                  <label className="group/check flex h-7 cursor-text items-center gap-2.5">
                    {/* The field has no box of its own inside the brief's: its + says where focus is.
                        It sits in the same gutter as the rows' numbers, so both lists share one edge. */}
                    <span className="flex w-4 shrink-0 justify-center">
                      <Icon name="plus" size={14} className="text-tertiary group-focus-within/check:text-fg" />
                    </span>
                    <input
                      value={draftCheck}
                      maxLength={CHECK_MAX_CHARS}
                      onChange={(e) => setDraftCheck(e.target.value)}
                      onKeyDown={onCheckKeyDown}
                      placeholder="Done when… a command passes, a file exists"
                      aria-label="New check"
                      className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-tertiary"
                    />
                  </label>
                ) : null}
              </div>
              {/* The control row is the box's action edge: how it runs, then
                  the one word that starts it (Composer's own primary). */}
              <div className={cn('border-t pb-1 pl-4 pr-3 @container', BORDER_DIVIDER)}>{controls}</div>
            </div>
            {menus}

            {/* What is not the run itself sits under the box on one quiet
                row: scope on the left, its manners and the way aside right. */}
            <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
              {onAddFolder ? (
                <AddedFolders
                  roots={extraRoots}
                  onAdd={onAddFolder}
                  onRemove={(root) => onExtraRootsChange?.(extraRoots.filter((r) => r !== root))}
                />
              ) : null}
              <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
                {/* The keys, so the chord is learnt by looking rather than by
                    hovering the one button that takes it. */}
                <span className="hidden items-center gap-1.5 text-xs text-tertiary @[720px]:flex">
                  <Keys keys={startChordKeys()} />
                  <span>start</span>
                </span>
                {draft ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={!draft.canSave || draft.saving}
                    pending={draft.saving}
                    title={draft.canSave ? undefined : 'Write a brief or a check first'}
                    onClick={draft.onSave}
                  >
                    {draft.continuing ? 'Update draft' : 'Save as draft'}
                  </Button>
                ) : null}
                {workspacePath ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    icon="repeat"
                    disabled={!brief.trim()}
                    title={brief.trim() ? 'Run this brief on a schedule, a new task each time' : 'Write a brief first'}
                    onClick={() =>
                      void requestRepeatTask({
                        workspacePath,
                        title: brief.trim().split('\n')[0]!.slice(0, 120),
                        instruction: brief.trim(),
                        ...(checks.length ? { doneWhen: checks } : {}),
                        worktree
                      })
                    }
                  >
                    Schedule…
                  </Button>
                ) : null}
                {workspacePath && compare && compare.options.length > 0 ? (
                  <CompareModels workspacePath={workspacePath} compare={compare} />
                ) : null}
                {approval ? <ApprovalNote approval={approval} onOpenSettings={onOpenSettings} /> : null}
              </div>
            </div>
              </>
            )}
          </div>
          {/* The rail: what the agent will see, where you change it. Beside
              the brief on a wide column; under it on a narrow one, where the
              field needs the whole width. */}
          {workspacePath ? (
            <WhatTheAgentSees
              workspacePath={workspacePath}
              worktree={worktree}
              onOpenSettings={onOpenSettings}
              onOpenRules={onOpenRules}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
}

const NO_FOLDERS: readonly string[] = []

/**
 * The folders outside the workspace the task may also work in, as quiet chips
 * on the row under the box, and the way to add one. The workspace stays where
 * the task runs; these are reached by absolute path.
 */
function AddedFolders({
  roots,
  onAdd,
  onRemove
}: {
  roots: readonly string[]
  onAdd: () => void
  onRemove: (root: string) => void
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1" data-added-folders>
      {roots.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap items-center gap-x-3 gap-y-1 p-0" aria-label="Added folders">
          {roots.map((root) => (
            <li key={root} className="group flex min-w-0 items-center gap-1.5 text-xs">
              <Icon name="folder" size={13} className="shrink-0 text-muted" />
              <span className="shrink-0 text-fg">{extraRootLabel(root)}</span>
              <span className="min-w-0 truncate font-mono text-caption text-tertiary" title={root}>
                {root}
              </span>
              <IconButton
                icon="close"
                label={`Remove ${root}`}
                size="xs"
                tone="muted"
                className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                onClick={() => onRemove(root)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {roots.length < MAX_EXTRA_ROOTS ? (
        <button
          type="button"
          onClick={onAdd}
          className="flex h-7 items-center gap-2.5 rounded-sm text-xs text-tertiary vy-transition hover:text-fg focus-visible:vy-focus-ring"
          title="Also let the task read and edit another folder, by absolute path"
        >
          <Icon name="folderPlus" size={14} className="shrink-0" />
          Add folder…
        </button>
      ) : null}
    </div>
  )
}

function WorkspaceSelect({
  workspacePath,
  targets,
  brief
}: {
  workspacePath: string
  targets?: NewTaskTargets
  brief: string
}) {
  const name = formatWorkspaceName(workspacePath)
  if (!targets || targets.workspaces.length < 2) {
    return (
      <span className="px-1.5 text-xs text-fg" title={workspacePath}>
        {name}
      </span>
    )
  }
  const options: MenuOption[] = targets.workspaces.map((w) => ({ value: w.path, label: w.name }))
  return (
    <Menu
      value={workspacePath}
      options={options}
      onChange={(path) => {
        if (path !== workspacePath) targets.onMove(path, brief)
      }}
      aria-label="Workspace"
      placement="down"
      size="xs"
      bare
    />
  )
}

const WHERE_ITEMS = [
  { id: 'here', label: 'This folder', icon: 'folder', title: 'Edits this folder directly' },
  { id: 'worktree', label: 'New worktree', icon: 'fork', title: 'Its own branch and folder; merge it back when you are happy' }
] as const

/**
 * Where it works, both answers in view: in this folder, or in a new worktree
 * branched from it — only offered when there is a commit to branch from.
 */
/**
 * "One model" / "Also on {model}": the brief again on a second model. Each copy
 * runs in a worktree of its own, so it is offered only where one can be made —
 * the same test as Where it works.
 */
function CompareModels({
  workspacePath,
  compare
}: {
  workspacePath: string
  compare: { options: readonly CompareModelOption[]; value: string | null; onChange: (next: string | null) => void }
}) {
  const git = useGitStatus(workspacePath, 0, true, 0)
  if (git.result?.kind !== 'ok' || !git.status?.branch || !git.status.hasCommits) return null
  return (
    <Menu
      value={compare.value ?? ''}
      options={[
        { value: '', label: 'One model' },
        ...compare.options.map((o) => ({ value: o.value, label: `Also on ${o.label}`, group: o.group }))
      ]}
      onChange={(next) => compare.onChange(next || null)}
      aria-label="Also run on another model"
      title="Run the same brief on a second model, each in its own worktree, to compare"
      icon="columns"
      size="xs"
      bare
      quiet={!compare.value}
    />
  )
}

function WhereItWorks({
  workspacePath,
  worktree,
  onWorktreeChange
}: {
  workspacePath: string
  worktree: boolean
  onWorktreeChange: (worktree: boolean) => void
}) {
  const git = useGitStatus(workspacePath, 0, true, 0)
  if (git.result?.kind !== 'ok' || !git.status?.branch || !git.status.hasCommits) return null
  return (
    <Segmented
      size="xs"
      label="Where it works"
      value={worktree ? 'worktree' : 'here'}
      onChange={(where) => onWorktreeChange(where === 'worktree')}
      items={WHERE_ITEMS}
      // In a narrow column the icons carry it; the words stay its names and tooltips.
      className="mr-1 shrink-0 @max-[640px]:[&_[data-segmented-label]]:sr-only"
    />
  )
}

/** The branch the task starts on: picking another checks it out. */
function BranchSelect({ workspacePath }: { workspacePath: string }) {
  const [revision, setRevision] = useState(0)
  const git = useGitStatus(workspacePath, revision, true, 0)
  // A branch switched anywhere else — Changes, a merged PR's Clean up — is the one named here.
  useEffect(() => {
    const off = window.vyotiq?.onGitStatusChanged?.((payload) => {
      if (workspacePathsEqual(payload.workspacePath, workspacePath)) setRevision((r) => r + 1)
    })
    return () => off?.()
  }, [workspacePath])
  const [branches, setBranches] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const { confirm, dialog: confirmDialog } = useConfirm()
  const branch = git.status?.branch ?? null

  useEffect(() => {
    if (!branch || !window.vyotiq?.gitBranches) return undefined
    let cancelled = false
    void window.vyotiq.gitBranches(workspacePath).then((res) => {
      if (!cancelled && res.ok) setBranches(res.data.map((b) => b.name))
    })
    return () => {
      cancelled = true
    }
  }, [workspacePath, branch])

  if (git.result?.kind !== 'ok' || !branch) return null
  const options: MenuOption[] = (branches.includes(branch) ? branches : [branch, ...branches]).map((name) => ({
    value: name,
    label: name
  }))
  return (
    <>
      <Menu
        value={branch}
        options={options}
        onChange={async (name) => {
          if (name === branch) return
          const dirty = (git.status?.fileCount ?? 0) > 0
          if (
            dirty &&
            !(await confirm(
              `The working tree has uncommitted changes. Git refuses to check out "${name}" if they would be overwritten.`,
              { title: 'Switch branch', confirmLabel: 'Switch branch' }
            ))
          ) {
            return
          }
          setError(null)
          void window.vyotiq.gitCheckout(workspacePath, name).then((res) => {
            if (res.ok) setRevision((r) => r + 1)
            else setError(res.error)
          })
        }}
        aria-label="Branch"
        placement="down"
        searchable={options.length > 8}
        searchPlaceholder="Find a branch"
        size="xs"
        bare
        mono
      />
      {error ? (
        <span className="ml-2 min-w-0 truncate text-danger" role="alert" title={error}>
          {error}
        </span>
      ) : null}
      {confirmDialog}
    </>
  )
}

/**
 * How tools ask before they run: the one run setting the control row does
 * not carry, set in Settings → Agent. Quiet — it is usually the default.
 */
function ApprovalNote({
  approval,
  onOpenSettings
}: {
  approval: ToolApprovalSettings
  onOpenSettings?: (section: 'agent') => void
}) {
  const note = [
    APPROVAL_NOTE[approval.mode],
    approval.mode !== 'all' && approval.mcpProtection !== false ? 'MCP tools ask first' : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <p className="m-0 ml-auto flex min-w-0 items-center gap-2 text-xs text-muted" data-approval-note>
      <span className="min-w-0 truncate">{note}</span>
      {onOpenSettings ? (
        <button
          type="button"
          className="shrink-0 rounded-sm font-medium text-secondary underline-offset-2 vy-transition hover:text-fg hover:underline focus-visible:vy-focus-ring"
          onClick={() => onOpenSettings('agent')}
        >
          Change
        </button>
      ) : null}
    </p>
  )
}

/** Built-in and MCP tools the next run gets, and any server that cannot connect. */
function useToolsSummary(workspacePath: string): {
  builtin: number
  servers: number
  problem: string | null
} | null {
  const [catalog, setCatalog] = useState<ToolCatalogResult | null>(null)
  const [mcp, setMcp] = useState<McpServerStatus[] | null>(null)

  useEffect(() => {
    let cancelled = false
    // Read for this workspace: what a run here leaves out depends on it, and a
    // pushed catalog is the active workspace's.
    const read = (): void => {
      void window.vyotiq.toolsCatalogGet?.({ workspacePath }).then((res) => {
        if (!cancelled && res.ok) setCatalog(res.data)
      })
    }
    const off = window.vyotiq.onToolsCatalogChanged?.(read)
    read()
    void window.vyotiq.mcpStatus?.({ workspacePath }).then((res) => {
      if (!cancelled && res.ok) setMcp(res.data.servers)
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [workspacePath])

  if (!catalog) return null
  // Counted as a run here sends them: no GitHub tools without a remote, no notebook tool without one.
  const leftOut = new Set(catalog.notApplicable ?? [])
  const builtin = catalog.entries.filter((e) => e.source === 'builtin' && e.active && !leftOut.has(e.name)).length
  const servers = catalog.servers.filter((s) => s.enabled).length
  const broken = (mcp ?? []).find((s) => s.enabled && !s.connected && !s.connecting && s.error)
  const problem = broken
    ? broken.errorKind === 'sign-in'
      ? `${broken.name} needs sign-in`
      : `${broken.name} can’t connect`
    : null
  return { builtin, servers, problem }
}

function WhatTheAgentSees({
  workspacePath,
  worktree,
  onOpenSettings,
  onOpenRules
}: {
  workspacePath: string
  worktree: boolean
  onOpenSettings?: (section: NewTaskFactTarget) => void
  onOpenRules?: () => void
}) {
  const { context, failed, reload } = useAgentContext(workspacePath)
  // Read again after an init: a watcher may not carry a `.git` just created.
  const gitInit = useGitInit(workspacePath, reload)
  const git = useGitStatus(workspacePath, 0, true, 0)
  const tools = useToolsSummary(workspacePath)

  const status = git.status
  // A new worktree starts from the branch's last commit; what is uncommitted here stays here.
  const inWorktree = worktree && Boolean(context?.branch)
  const branchDetail = status
    ? inWorktree
      ? [
          `from ${status.branch ?? context?.branch}`,
          status.fileCount > 0
            ? `${status.fileCount.toLocaleString()} uncommitted ${status.fileCount === 1 ? 'file stays' : 'files stay'} here`
            : null
        ]
          .filter(Boolean)
          .join(' · ')
      : [
          status.fileCount > 0 ? `${status.fileCount.toLocaleString()} changed` : 'clean',
          status.ahead ? `${status.ahead} ahead` : null,
          status.behind ? `${status.behind} behind` : null
        ]
          .filter(Boolean)
          .join(' · ')
    : null

  // The prompt is pre-loaded from index.md and state.md, so those count as
  // memory even when the note store is empty.
  const memoryFiles = context
    ? [context.memoryState ? 'state.md' : null, context.memoryIndex ? 'index.md' : null].filter(
        (n): n is string => Boolean(n)
      )
    : []

  const rules = context?.rules
  const ruleFiles = ruleRootFiles(rules)

  return (
    // The rail beside the brief on a wide column, and its own sticky block:
    // the facts hold still while the brief scrolls. Under 1100px it falls
    // under the box, where the rows read two to a line.
    <aside
      className={cn(
        // Under the box it keeps the brief's 780 measure and centre, so the
        // two share a left edge; beside it, the rail's own column.
        'mx-auto w-full min-w-0 max-w-[780px] border-t pt-4 @[1100px]:sticky @[1100px]:top-6 @[1100px]:mx-0 @[1100px]:max-w-none @[1100px]:border-t-0 @[1100px]:pt-0',
        BORDER_DIVIDER
      )}
      aria-label="What the agent will see"
      data-agent-sees
    >
      <h2 className={SECTION_LABEL}>What the agent will see</h2>
      {failed ? (
        <p className="mt-3 text-xs text-muted">This workspace’s context could not be read.</p>
      ) : (
        // Two facts to a line when the ledger is under the box, one when it is
        // the 296px rail: the rows never wrap mid-value.
        <ul className="m-0 mt-1 grid list-none grid-cols-1 gap-x-8 p-0 @[560px]:grid-cols-2 @[1100px]:grid-cols-1">
          <Fact
            icon="branch"
            k="Branch"
            v={
              context ? (
                context.branch ? (
                  inWorktree ? (
                    'New worktree'
                  ) : (
                    <span className="font-mono">{context.branch}</span>
                  )
                ) : (
                  <span className="flex items-center gap-2">
                    {gitInit.error ? 'Init failed' : 'Not a repository'}
                    <button
                      type="button"
                      className="rounded-sm text-xs font-medium text-muted underline-offset-2 vy-transition hover:text-fg hover:underline focus-visible:vy-focus-ring disabled:vy-disabled-state"
                      disabled={gitInit.busy}
                      aria-busy={gitInit.busy || undefined}
                      title={`Run git init in ${context.workspaceName}`}
                      onClick={() => void gitInit.init()}
                    >
                      Initialize
                    </button>
                  </span>
                )
              ) : null
            }
            d={context?.branch ? branchDetail : (gitInit.error ?? null)}
            warn={!context?.branch && Boolean(gitInit.error)}
          />
          <Fact
            icon="rules"
            k="Rules"
            v={
              context
                ? ruleFiles.length > 0
                  ? ruleFiles.join(' · ')
                  : rules?.ruleFileCount
                    ? ruleFileCountLabel(rules.ruleFileCount)
                    : 'None'
                : null
            }
            d={ruleFiles.length > 0 && rules?.ruleFileCount ? `+ ${ruleFileCountLabel(rules.ruleFileCount)}` : null}
            open={onOpenRules ? { label: 'Extensions', run: onOpenRules } : undefined}
          />
          <Fact
            icon="memory"
            k="Memory"
            v={
              context
                ? context.memoryNotes > 0
                  ? `${context.memoryNotes} ${context.memoryNotes === 1 ? 'note' : 'notes'}`
                  : memoryFiles.length > 0
                    ? memoryFiles.join(' · ')
                    : 'None'
                : null
            }
            d={context?.memoryNotes ? (context.memoryNoteNames?.join(', ') ?? null) : null}
            open={onOpenSettings ? { label: 'Settings', run: () => onOpenSettings('agent') } : undefined}
          />
          <Fact
            icon="database"
            k="Index"
            v={context ? INDEX_LABEL[context.codeIndex.state] : null}
            d={context ? indexDetail(context.codeIndex) : null}
            open={onOpenSettings ? { label: 'Settings', run: () => onOpenSettings('indexing') } : undefined}
          />
          <Fact
            icon="tool"
            k="Tools"
            v={tools ? `${tools.builtin} built-in · ${tools.servers} MCP ${tools.servers === 1 ? 'server' : 'servers'}` : null}
            d={tools?.problem ?? null}
            warn={Boolean(tools?.problem)}
            open={onOpenSettings ? { label: 'Settings', run: () => onOpenSettings('tools') } : undefined}
          />
        </ul>
      )}
    </aside>
  )
}

/**
 * "12,408 source files · updated 4m ago" — this workspace's own index, when it
 * has one. The index holds production source only (no tests, docs or config),
 * so a bare "2 files" for a four-file repository read as a miscount.
 */
function indexDetail(index: { files?: number; indexedAt?: string }): string | null {
  if (index.files == null) return null
  const files = `${index.files.toLocaleString('en-US')} source ${index.files === 1 ? 'file' : 'files'}`
  const ago = index.indexedAt ? relativeTimeAgo(index.indexedAt) : ''
  return ago ? `${files} · updated ${ago}` : files
}

/**
 * One fact the task starts from. A fact you can change is a way to where you
 * change it: the whole row is the link, its text still on the column's edge.
 */
function Fact({
  icon,
  k,
  v,
  d,
  warn = false,
  open
}: {
  icon: IconName
  k: string
  v: ReactNode
  d?: string | null
  warn?: boolean
  /** Where it is changed: the page's name (said to screen readers) and how to get there. */
  open?: { label: string; run: () => void }
}) {
  const body = (
    // One glyph, then the key over its value over its detail, all on one left
    // edge. In a 296px rail the three read as a row instead of a squeezed
    // table, and the glyph is what tells five lines apart at a glance.
    <span className="flex min-w-0 items-start gap-2.5">
      <Icon name={icon} size={14} className={cn('mt-[3px] shrink-0', warn ? 'text-warning' : 'text-tertiary')} />
      <span className="min-w-0 flex-1">
        {/* Labels in the app carry no colon; a screen reader still hears the pause. */}
        <span className="text-caption text-tertiary">
          {k}
          <span className="sr-only">:</span>
        </span>
        <span className="mt-px flex min-w-0 items-center gap-1.5 text-sm text-fg">
          {v === null ? (
            <span className="h-3.5 w-24 rounded-sm bg-surface" aria-label="Loading" />
          ) : (
            <span className="min-w-0 truncate">{v}</span>
          )}
          {warn ? <Icon name="warningCircle" size={13} className="shrink-0 text-warning" /> : null}
        </span>
        {d ? (
          <span className="mt-px block min-w-0 truncate text-caption">
            {/* The comma is heard, not seen: a link's name reads "Index: Ready, …". */}
            <span className="sr-only">, </span>
            <span className={warn ? 'text-warning' : 'text-muted'}>{d}</span>
          </span>
        ) : null}
      </span>
    </span>
  )
  return (
    <li data-fact={k}>
      {open ? (
        <button
          type="button"
          onClick={open.run}
          className={cn(
            '-mx-2 block w-[calc(100%+16px)] rounded-md px-2 py-1 text-left vy-transition focus-visible:vy-focus-ring',
            ROW_HOVER
          )}
        >
          {body}
          <span className="sr-only">, change in {open.label}</span>
        </button>
      ) : (
        // No inset: a button row's -mx-2/px-2 nets to zero, so the glyph
        // column lines up with these rows only when they have none either.
        <div className="py-1">{body}</div>
      )}
    </li>
  )
}
