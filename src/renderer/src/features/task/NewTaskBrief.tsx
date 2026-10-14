import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  TASK_DRAFT_CHECK_CHARS_MAX,
  TASK_DRAFT_CHECKS_MAX,
  type ComposerAttachmentsBucket,
  type McpServerStatus,
  type ToolCatalogResult
} from '@shared/ipc'
import { relativeTimeAgo } from '@shared/utils/timeFormat'
import { extraRootLabel } from '@shared/extraRoots'
import { IconButton, Menu, Segmented, cn, type MenuOption } from '@renderer/lib/ui'
import { Icon, type IconName } from '@renderer/lib/icons'
import { BORDER_DIVIDER, NUM, ROW_HOVER, SECTION_LABEL, SELECTED } from '@renderer/lib/utils/layout'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { draftTitle, requestOpenTaskDraft, useTaskDrafts } from '@renderer/lib/drafts/taskDraftStore'
import { useAgentContext } from '@renderer/features/chat/components/useAgentContext'
import { useGitInit } from '@renderer/features/chat/components/useGitInit'
import type { GitStatusState } from '@renderer/features/chat/components/useGitStatus'
import { ruleFileCountLabel, ruleRootFiles } from './ruleSummary'

/** Everything a brief is, as it moves to another workspace. */
export type MovedBrief = {
  text: string
  checks: string[]
  extraRoots: string[]
  worktree: boolean
  attachments: ComposerAttachmentsBucket
}

/** Where a new task can be moved to: the open workspaces. */
export type NewTaskTargets = {
  workspaces: ReadonlyArray<{ path: string; name: string }>
  /** Start the new task over in another workspace, carrying the whole brief. False when it stayed. */
  onMove: (from: string, to: string, brief: MovedBrief) => Promise<boolean>
}

/** The schema's bounds on the brief's checks — the same Structure's Done when moves within. */
const MAX_CHECKS = TASK_DRAFT_CHECKS_MAX
const CHECK_MAX_CHARS = TASK_DRAFT_CHECK_CHARS_MAX
/** Drafts listed under the box; the navigator lists them all. */
const DRAFTS_SHOWN = 5

const INDEX_LABEL = { ready: 'Ready', building: 'Building', degraded: 'Degraded', off: 'Off', paused: 'Paused' } as const

export function startChord(): string {
  return window.vyotiq?.platform === 'darwin' ? '⌘↵' : 'Ctrl+Enter'
}

/** The chord as the Start button says it: short, in words a keycap would hold. */
export function startChordLabel(): string {
  return window.vyotiq?.platform === 'darwin' ? '⌘↵' : 'Ctrl ↵'
}

/** Where the facts beside the brief lead: the page where each one is changed. */
export type NewTaskFactTarget = 'agent' | 'tools' | 'indexing'

/**
 * Starting a task is filling in a brief, not opening a chat. The header says
 * where it runs, as a sentence: New task in this workspace on this branch,
 * in this folder or a new worktree. The box is the brief: what to do, what
 * goes with it (files and folders), the checks it is judged against, and how
 * it runs, ending in Start. Under it, this workspace's drafts; beside it (or
 * folded under it in a narrow column), what the agent will see, each fact a
 * way to where you change it. The brief is the composer's own input, so @
 * context, attachments and / skills work here as on the instruction line.
 */
export function NewTaskBrief({
  workspacePath,
  targets,
  input,
  attachments,
  notice,
  controls,
  banners,
  fileInput,
  menus,
  onDragOver,
  onDrop,
  canStart,
  onChecksChange,
  onStart,
  onOpenSettings,
  onOpenRules,
  headerActions,
  checks,
  onChecksEdit,
  clearToken,
  onSaveDraft,
  continuingDraftId = null,
  git,
  worktree = false,
  worktreeOffered = false,
  onWorktreeChange,
  extraRoots = NO_FOLDERS,
  onExtraRootsChange,
  locked = false,
  voice
}: {
  workspacePath: string | null
  targets?: { workspaces: ReadonlyArray<{ path: string; name: string }>; onMove: (path: string) => void }
  input: ReactNode
  attachments: ReactNode
  /** A banner that belongs to this box (the model is not ready), above the field. */
  notice?: ReactNode
  /**
   * Mode, model · effort, permissions, then structure, attach, mic and voice,
   * ending in Start — the row every composer ends with. A dictation take's
   * strip stands in for it while there is one.
   */
  controls: ReactNode
  banners: ReactNode
  fileInput: ReactNode
  menus: ReactNode
  /** Files dropped anywhere on the box attach. */
  onDragOver?: (event: DragEvent<HTMLElement>) => void
  onDrop?: (event: DragEvent<HTMLElement>) => void
  canStart: boolean
  /** The checks as they stand, a half-typed one included — whatever starts the task sends them. */
  onChecksChange: (doneWhen: string[]) => void
  onStart: () => void
  /** Settings → Agent, Tools and Indexing from the facts. */
  onOpenSettings?: (section: NewTaskFactTarget) => void
  /** Extensions → Rules, from the Rules fact. */
  onOpenRules?: () => void
  /** The pane's own controls: show the inspector, close a split pane. */
  headerActions?: ReactNode
  /** The checks added so far — kept per workspace, so leaving New task keeps them. */
  checks: string[]
  onChecksEdit: (next: string[]) => void
  /** Changes when the page was emptied (a draft saved, a task started): drops a half-typed check. */
  clearToken?: number
  /** Ctrl/Cmd+S anywhere in the box: Save as draft (Update draft when continuing one). */
  onSaveDraft?: { run: () => void; canSave: boolean }
  /** The draft this page continues, marked in the drafts list. */
  continuingDraftId?: string | null
  /** This workspace's git state, kept current while the page is open. */
  git: GitStatusState
  /** Start it in a new worktree of this workspace instead of in this folder. */
  worktree?: boolean
  /** There is a commit to branch a worktree from. */
  worktreeOffered?: boolean
  onWorktreeChange?: (worktree: boolean) => void
  /** Folders outside the workspace the task may also read and edit (absolute). */
  extraRoots?: readonly string[]
  onExtraRootsChange?: (next: string[]) => void
  /** The box is read-only: the task is starting, or a draft is being saved. */
  locked?: boolean
  /**
   * Voice mode's bar, while it's open here: it takes the brief's place, and
   * the first thing said starts the task (docs/voice-mode.md §13.5).
   */
  voice?: ReactNode
}) {
  const [draftCheck, setDraftCheck] = useState('')
  const newCheckRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (clearToken) setDraftCheck('')
  }, [clearToken])

  // Ctrl/Cmd+Enter in the brief starts the task too, so the composer holds
  // the checks as they are now rather than being handed them on a click.
  const pending = draftCheck.trim().slice(0, CHECK_MAX_CHARS)
  const onChecksChangeRef = useRef(onChecksChange)
  onChecksChangeRef.current = onChecksChange
  useEffect(() => {
    const room = checks.length < MAX_CHECKS
    const fresh = pending && !checks.includes(pending)
    onChecksChangeRef.current(room && fresh ? [...checks, pending] : checks)
  }, [checks, pending])

  const addCheck = (): void => {
    const text = draftCheck.trim().slice(0, CHECK_MAX_CHARS)
    if (!text || checks.length >= MAX_CHECKS) return
    // The same check twice is one check.
    if (!checks.includes(text)) onChecksEdit([...checks, text])
    setDraftCheck('')
  }

  const removeCheck = (index: number): void => {
    onChecksEdit(checks.filter((_, i) => i !== index))
    // The row under the pointer is gone; the field for the next check is where focus goes.
    requestAnimationFrame(() => newCheckRef.current?.focus())
  }

  const onCheckKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // Read-only while the brief starts or saves: no check is added to a brief on its way.
    if (locked && event.key === 'Enter') {
      event.preventDefault()
      return
    }
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

  // Ctrl/Cmd+S anywhere in the box puts the brief aside, as Save as draft does.
  const boxRef = useRef<HTMLDivElement>(null)
  const saveDraftRef = useRef(onSaveDraft)
  saveDraftRef.current = onSaveDraft
  const lockedRef = useRef(locked)
  lockedRef.current = locked
  useEffect(() => {
    const box = boxRef.current
    if (!box) return undefined
    const onKey = (event: globalThis.KeyboardEvent): void => {
      const save = saveDraftRef.current
      if (!save || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return
      // By the key's place, not its letter, so a non-Latin layout saves too.
      if (event.code !== 'KeyS' && event.key.toLowerCase() !== 's') return
      event.preventDefault()
      if (save.canSave && !lockedRef.current) save.run()
    }
    box.addEventListener('keydown', onKey)
    return () => box.removeEventListener('keydown', onKey)
  }, [voice])

  const full = checks.length >= MAX_CHECKS
  const folders =
    extraRoots.length > 0 ? (
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Added folders" data-added-folders>
        {extraRoots.map((root) => (
          <li
            key={root}
            className="inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md bg-surface pl-2 pr-0.5 text-xs text-fg"
            title={root}
          >
            <Icon name="folder" size={12} className="shrink-0 text-tertiary" />
            <span className="truncate">{extraRootLabel(root)}</span>
            <span className="shrink-0 text-tertiary">· can edit</span>
            <IconButton
              icon="close"
              label={`Remove folder ${root}`}
              size="xs"
              tone="onSurface"
              disabled={locked}
              onClick={() => onExtraRootsChange?.(extraRoots.filter((r) => r !== root))}
            />
          </li>
        ))}
      </ul>
    ) : null

  return (
    // The pane around it is already the "New task" region.
    <div className="flex min-h-0 flex-1 flex-col bg-bg" data-new-task>
      <header
        className="@container flex h-10 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2 text-xs text-tertiary"
        data-task-header
      >
        <h1 className="mr-1 shrink-0 whitespace-nowrap text-sm font-semibold text-fg-strong">New task</h1>
        {workspacePath ? (
          <>
            {/* One sentence: a new task, in this workspace, on this branch, here or in a
                worktree. The joining words stay quieter than the names they hold. */}
            <span className="shrink-0 @max-[560px]:hidden">in</span>
            <span className="flex min-w-0 items-center">
              <WorkspaceSelect workspacePath={workspacePath} targets={targets} disabled={locked} />
            </span>
            <BranchSelect workspacePath={workspacePath} git={git} disabled={locked} />
            {onWorktreeChange && worktreeOffered ? (
              <WhereItWorks worktree={worktree} onWorktreeChange={onWorktreeChange} disabled={locked} />
            ) : null}
          </>
        ) : null}
        <span className="flex-1" />
        {headerActions}
      </header>

      {/* The workbench: the brief keeps the record's measure on the left, and
          what the agent will see reads beside it on the right. Under 1100px of
          column the rail folds under the brief — the field keeps the whole
          width there, which is what a split pane or an open inspector leaves. */}
      <div className="@container scroll-thin min-h-0 flex-1 overflow-y-auto">
        {/* 1180 = the record's 780 measure + the 40px gutter + the 296px rail,
            so the brief is exactly as wide as the steps it becomes. */}
        <div className="mx-auto min-h-full w-full max-w-[1180px] px-5 pb-16 pt-10 @[720px]:px-8 @[900px]:pt-16 @[1100px]:grid @[1100px]:grid-cols-[minmax(0,1fr)_296px] @[1100px]:items-start @[1100px]:gap-x-10">
          <div className="mx-auto flex w-full max-w-[780px] flex-col gap-10">
            <div>
              {banners}
              {voice ?? (
                <div
                  className="rounded-lg border border-border bg-bg vy-transition focus-within:border-border-strong"
                  data-brief
                  // The composer's shell: Ctrl+. typed in the brief switches this box's mode.
                  data-composer-shell
                  aria-busy={locked || undefined}
                  onDragOver={onDragOver}
                  onDrop={onDrop}
                  ref={boxRef}
                >
                  {fileInput}
                  {notice ? <div className={cn('border-b px-1.5 py-1', BORDER_DIVIDER)}>{notice}</div> : null}
                  <div className="px-4 pt-3.5">{input}</div>
                  {attachments || folders ? (
                    <div className="flex flex-col gap-1.5 px-4 pt-2">
                      {attachments}
                      {folders}
                    </div>
                  ) : null}
                  {/* The checks the run is judged against are part of the brief: the
                      field for the next one is always there, so the first check is one
                      click into it, not two. Numbers are the checks' ids in the record. */}
                  <div className={cn('mt-3 border-t py-1 pl-4 pr-2', BORDER_DIVIDER)} data-done-when>
                    {checks.length > 0 ? (
                      <ol className="m-0 list-none p-0" aria-label="Done when">
                        {checks.map((text, index) => (
                          <li
                            key={`${index}:${text}`}
                            className={cn('group -mx-1 flex h-7 items-center gap-2.5 rounded-md px-1', ROW_HOVER)}
                          >
                            <span className={cn(NUM, 'w-4 shrink-0 text-right text-tertiary')}>{index + 1}</span>
                            <span className="min-w-0 flex-1 truncate text-xs text-fg" title={text}>
                              {text}
                            </span>
                            <IconButton
                              icon="close"
                              label={`Remove “${text}”`}
                              size="xs"
                              tone="muted"
                              disabled={locked}
                              className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                              onClick={() => removeCheck(index)}
                            />
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    <label className="group/check flex h-7 cursor-text items-center gap-2.5">
                      {/* The field has no box of its own inside the brief's: its + says
                          where focus is, beside the outline the field draws when it has it. */}
                      <span className="flex w-4 shrink-0 justify-center">
                        <Icon name="plus" size={14} className="text-tertiary group-focus-within/check:text-fg" />
                      </span>
                      <input
                        ref={newCheckRef}
                        value={draftCheck}
                        maxLength={CHECK_MAX_CHARS}
                        readOnly={locked}
                        // At the limit the field stays, so a half-typed check stays in view.
                        aria-disabled={full || undefined}
                        onChange={(e) => setDraftCheck(e.target.value)}
                        onKeyDown={onCheckKeyDown}
                        placeholder={full ? `${MAX_CHECKS} checks is the limit` : 'Done when… a command passes, a file exists'}
                        aria-label="New check"
                        className="min-w-0 flex-1 rounded-sm bg-transparent text-xs text-fg outline-none placeholder:text-tertiary focus-visible:vy-focus-ring"
                      />
                    </label>
                  </div>
                  {/* The control row is the box's action edge: how it runs, then
                      the one action that starts it (with the brief's other endings). */}
                  <div className={cn('border-t pb-1 pl-4 pr-2 @container', BORDER_DIVIDER)}>{controls}</div>
                </div>
              )}
              {menus}
            </div>
            {workspacePath ? <DraftsList workspacePath={workspacePath} continuingDraftId={continuingDraftId} /> : null}
          </div>
          {/* The rail: what the agent will see, where you change it. Beside
              the brief on a wide column; folded under it on a narrow one. */}
          {workspacePath ? (
            <WhatTheAgentSees
              workspacePath={workspacePath}
              worktree={worktree}
              git={git}
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
 * This workspace's saved drafts, newest first, under the box: the other way
 * into a task. Opening one goes through the app (it asks first when the page
 * holds unsaved work); the one this page continues is marked.
 */
function DraftsList({ workspacePath, continuingDraftId }: { workspacePath: string; continuingDraftId: string | null }) {
  const all = useTaskDrafts([workspacePath])
  if (all.length === 0) return null
  const shown = all.slice(0, DRAFTS_SHOWN)
  return (
    <section aria-labelledby="new-task-drafts" data-new-task-drafts>
      <h2 id="new-task-drafts" className={cn(SECTION_LABEL, 'flex h-7 items-center gap-2')}>
        Drafts
        <span className={cn(NUM, 'font-normal tracking-normal')}>{all.length}</span>
      </h2>
      <ul className="m-0 list-none p-0">
        {shown.map(({ draft }) => {
          const current = draft.id === continuingDraftId
          return (
            <li key={draft.id}>
              <button
                type="button"
                aria-current={current ? 'true' : undefined}
                onClick={() => requestOpenTaskDraft(workspacePath, draft)}
                className={cn(
                  '-mx-2 flex h-8 w-[calc(100%+16px)] items-center gap-2.5 rounded-md px-2 text-left text-sm vy-transition focus-visible:vy-focus-ring',
                  current ? SELECTED : cn('text-fg', ROW_HOVER)
                )}
              >
                <Icon name="note" size={14} className="shrink-0 text-tertiary" />
                <span className="min-w-0 flex-1 truncate">{draftTitle(draft)}</span>
                <span className="shrink-0 text-caption text-tertiary">
                  {current ? 'Open here' : relativeTimeAgo(draft.updatedAt)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {all.length > shown.length ? (
        <p className="m-0 mt-1 text-caption text-tertiary">
          {all.length - shown.length} more in the sidebar
        </p>
      ) : null}
    </section>
  )
}

function WorkspaceSelect({
  workspacePath,
  targets,
  disabled
}: {
  workspacePath: string
  targets?: { workspaces: ReadonlyArray<{ path: string; name: string }>; onMove: (path: string) => void }
  disabled: boolean
}) {
  const name = formatWorkspaceName(workspacePath)
  if (!targets || targets.workspaces.length < 2) {
    return (
      <span className="min-w-0 truncate px-1.5 text-xs text-fg" title={workspacePath}>
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
        if (path !== workspacePath) targets.onMove(path)
      }}
      aria-label="Workspace"
      placement="down"
      size="xs"
      disabled={disabled}
      bare
    />
  )
}

const WHERE_ITEMS = [
  { id: 'here', label: 'This folder', icon: 'folder', title: 'Edits this folder directly' },
  { id: 'worktree', label: 'New worktree', icon: 'fork', title: 'Its own branch and folder; merge it back when you are happy' }
] as const

/** Where it works, both answers in view: this folder, or a new worktree branched from it. */
function WhereItWorks({
  worktree,
  onWorktreeChange,
  disabled
}: {
  worktree: boolean
  onWorktreeChange: (worktree: boolean) => void
  disabled: boolean
}) {
  return (
    <Segmented
      size="xs"
      label="Where it works"
      value={worktree ? 'worktree' : 'here'}
      onChange={(where) => {
        if (!disabled) onWorktreeChange(where === 'worktree')
      }}
      items={WHERE_ITEMS}
      // Shown as unavailable while the brief starts or saves, not just inert.
      disabled={disabled}
      // In a narrow column the icons carry it; the words stay its names and tooltips.
      className="ml-1 shrink-0 @max-[640px]:[&_[data-segmented-label]]:sr-only"
    />
  )
}

/** The branch the task starts on: picking another checks it out. */
function BranchSelect({ workspacePath, git, disabled }: { workspacePath: string; git: GitStatusState; disabled: boolean }) {
  const [branches, setBranches] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { confirm, dialog: confirmDialog } = useConfirm()
  const branch = git.status?.branch ?? null

  // A branch switched anywhere — here, Changes, a merged PR's Clean up — makes
  // an old checkout error stale.
  useEffect(() => {
    setError(null)
  }, [branch])

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
    <span className="flex min-w-0 items-center gap-1">
      <span className="shrink-0 @max-[560px]:hidden">on</span>
      <Menu
        value={branch}
        options={options}
        onChange={async (name) => {
          if (name === branch || busy) return
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
          setBusy(true)
          try {
            const res = await window.vyotiq.gitCheckout(workspacePath, name)
            if (res.ok) git.refresh()
            else setError(res.error)
          } finally {
            setBusy(false)
          }
        }}
        aria-label="Branch"
        placement="down"
        searchable={options.length > 8}
        searchPlaceholder="Find a branch"
        size="xs"
        disabled={disabled || busy}
        bare
        mono
      />
      {error ? (
        <span className="ml-1 flex min-w-0 items-center gap-1 text-danger" role="alert" title={error}>
          <Icon name="warningCircle" size={13} className="shrink-0" />
          <span className="min-w-0 truncate">{error}</span>
        </span>
      ) : null}
      {confirmDialog}
    </span>
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
  git,
  onOpenSettings,
  onOpenRules
}: {
  workspacePath: string
  worktree: boolean
  git: GitStatusState
  onOpenSettings?: (section: NewTaskFactTarget) => void
  onOpenRules?: () => void
}) {
  const { context, failed, reload } = useAgentContext(workspacePath)
  // Read again after an init: a watcher may not carry a `.git` just created.
  const gitInit = useGitInit(workspacePath, () => {
    reload()
    git.refresh()
  })
  const tools = useToolsSummary(workspacePath)
  // Folded under the box in a narrow column; the summary line says it all at a glance.
  const [open, setOpen] = useState(false)

  const status = git.status
  // A new worktree starts from the branch's last commit; what is uncommitted here stays here.
  const inWorktree = worktree && Boolean(context?.branch)
  const changed = status ? (status.fileCount > 0 ? `${status.fileCount.toLocaleString()} changed` : 'Clean') : null
  const treeValue: ReactNode = context
    ? context.branch
      ? inWorktree
        ? 'New worktree'
        : (changed ?? <span className="font-mono">{context.branch}</span>)
      : (
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
    : null
  const treeDetail = context?.branch
    ? inWorktree
      ? [
          `from ${status?.branch ?? context.branch}`,
          status && status.fileCount > 0
            ? `${status.fileCount.toLocaleString()} uncommitted ${status.fileCount === 1 ? 'file stays' : 'files stay'} here`
            : null
        ]
          .filter(Boolean)
          .join(' · ')
      : status
        ? [status.ahead ? `${status.ahead} ahead` : null, status.behind ? `${status.behind} behind` : null]
            .filter(Boolean)
            .join(' · ') || null
        : null
    : (gitInit.error ?? null)

  // The prompt is pre-loaded from index.md and state.md, so those count as
  // memory even when the note store is empty.
  const memoryFiles = context
    ? [context.memoryState ? 'state.md' : null, context.memoryIndex ? 'index.md' : null].filter(
        (n): n is string => Boolean(n)
      )
    : []

  const rules = context?.rules
  const ruleFiles = ruleRootFiles(rules)
  const ruleCount = ruleFiles.length + (rules?.ruleFileCount ?? 0)
  const memoryValue = context
    ? context.memoryNotes > 0
      ? `${context.memoryNotes} ${context.memoryNotes === 1 ? 'note' : 'notes'}`
      : memoryFiles.length > 0
        ? memoryFiles.join(' · ')
        : 'None'
    : null

  const summary = [
    inWorktree ? 'new worktree' : status ? (status.fileCount > 0 ? `${status.fileCount.toLocaleString()} changed` : 'clean') : null,
    context ? `${ruleCount} ${ruleCount === 1 ? 'rule' : 'rules'}` : null,
    memoryValue && memoryValue !== 'None' ? memoryValue : null,
    context ? `index ${INDEX_LABEL[context.codeIndex.state].toLowerCase()}` : null,
    tools ? `${tools.builtin} tools` : null
  ]
    .filter(Boolean)
    .join(' · ')
  const warn = Boolean(tools?.problem) || (!context?.branch && Boolean(gitInit.error))

  return (
    // The rail beside the brief on a wide column, and its own sticky block:
    // the facts hold still while the brief scrolls. Under 1100px of column it
    // reads under the box, two facts to a line; only a narrow column (under
    // 640px: a split pane, an open inspector) folds it to one line, the whole
    // line its own toggle.
    <aside
      className={cn(
        // Under the box it keeps the brief's 780 measure and centre, so the
        // two share a left edge; beside it, the rail's own column.
        'mx-auto mt-10 w-full min-w-0 max-w-[780px] border-t pt-3 @[1100px]:sticky @[1100px]:top-6 @[1100px]:mx-0 @[1100px]:mt-0 @[1100px]:max-w-none @[1100px]:border-t-0 @[1100px]:pt-0',
        BORDER_DIVIDER
      )}
      aria-label="What the agent will see"
      data-agent-sees
    >
      <h2 className={cn(SECTION_LABEL, '@max-[640px]:hidden')}>What the agent will see</h2>
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? 'Fold what the agent will see' : 'Show what the agent will see'}
        className={cn(
          '-mx-1 flex h-7 w-[calc(100%+0.5rem)] min-w-0 items-center gap-3 rounded-md px-1 text-left vy-transition focus-visible:vy-focus-ring @[640px]:hidden',
          ROW_HOVER
        )}
        onClick={() => setOpen((v) => !v)}
        data-agent-sees-toggle
      >
        <span className={cn(SECTION_LABEL, 'shrink-0')}>What the agent will see</span>
        <span className={cn('min-w-0 flex-1 truncate text-xs', warn ? 'text-warning' : 'text-muted')}>
          {open ? '' : summary}
        </span>
        <Icon name={open ? 'chevronUp' : 'chevron'} size={14} className="shrink-0 text-muted" />
      </button>
      {failed ? (
        <p className="mt-3 text-xs text-muted">This workspace’s context could not be read.</p>
      ) : (
        // Two facts to a line when the ledger is open under the box, one when it
        // is the 296px rail: the rows never wrap mid-value.
        <ul
          className={cn(
            'm-0 mt-1 list-none grid-cols-1 gap-x-8 p-0 @[640px]:grid @[640px]:grid-cols-2 @[1100px]:grid-cols-1',
            open ? 'grid' : 'hidden'
          )}
          data-agent-facts
        >
          <Fact icon={inWorktree ? 'fork' : 'branch'} k="Working tree" v={treeValue} d={treeDetail} warn={!context?.branch && Boolean(gitInit.error)} />
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
            v={memoryValue}
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
            <span className="h-3.5 w-24 rounded-sm bg-surface" role="status" aria-label="Loading" />
          ) : (
            <span className="min-w-0 truncate">{v}</span>
          )}
          {warn ? <Icon name="warningCircle" size={13} className="shrink-0 text-warning" /> : null}
        </span>
        {d ? (
          <span className="mt-px block min-w-0 truncate text-caption">
            {/* The comma is heard, not seen: a link's name reads "Index: Ready, …". */}
            <span className="sr-only">, </span>
            <span className={warn ? 'text-warning' : 'text-tertiary'}>{d}</span>
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
