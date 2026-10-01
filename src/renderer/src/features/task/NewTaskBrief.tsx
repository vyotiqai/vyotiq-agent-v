import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { McpServerStatus, ToolApprovalMode, ToolApprovalSettings, ToolCatalogResult } from '@shared/ipc'
import { relativeTimeAgo } from '@shared/utils/timeFormat'
import { Button, IconButton, Menu, Segmented, StatusGlyph, cn, type MenuOption } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { BORDER_DIVIDER, ROW_HOVER, SECTION_LABEL } from '@renderer/lib/utils/layout'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { useAgentContext } from '@renderer/features/chat/components/useAgentContext'
import { useGitInit } from '@renderer/features/chat/components/useGitInit'
import { useGitStatus } from '@renderer/features/chat/components/useGitStatus'

/** Where a new task can be moved to: the open workspaces. */
export type NewTaskTargets = {
  workspaces: ReadonlyArray<{ path: string; name: string }>
  /** Start the new task over in another workspace, carrying the brief across. */
  onMove: (workspacePath: string, brief: string) => void
}

/** The schema's bounds on the brief's checks. */
const MAX_CHECKS = 20
const CHECK_MAX_CHARS = 500

const APPROVAL_NOTE: Record<ToolApprovalMode, string> = {
  off: 'Runs its tools without asking',
  mutating: 'Asks before edits and commands',
  all: 'Asks before every tool'
}

const INDEX_LABEL = { ready: 'Ready', building: 'Building', degraded: 'Degraded', off: 'Off', paused: 'Paused' } as const

function startChord(): string {
  return window.vyotiq?.platform === 'darwin' ? '⌘↵' : 'Ctrl+Enter'
}

/** Where the facts beside the brief lead: the page where each one is changed. */
export type NewTaskFactTarget = 'agent' | 'tools' | 'indexing'

/**
 * Starting a task is filling in a brief, not opening a chat. The brief is one
 * box: what to do, the checks the run is judged against, and how it runs (the
 * composer's own control row). Where it runs is the header; beside it, what
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
  startBlockedReason,
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
  onWorktreeChange
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
  startBlockedReason: string | null
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
            {'in '}
            <WorkspaceSelect workspacePath={workspacePath} targets={targets} brief={brief} />
            <BranchSelect workspacePath={workspacePath} />
          </>
        ) : null}
        <span className="flex-1" />
        {workspacePath && onWorktreeChange ? (
          <WhereItWorks workspacePath={workspacePath} worktree={worktree} onWorktreeChange={onWorktreeChange} />
        ) : null}
        {headerActions}
      </header>

      {/* The column is what is narrow, not the window: with the inspector open
          beside it, what the agent will see goes under the brief. */}
      <div className="@container scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[1040px] grid-cols-1 gap-10 px-5 pb-12 pt-6 @[720px]:grid-cols-[minmax(0,1fr)_260px] @[720px]:gap-12 @[720px]:px-8">
          <div className="min-w-0">
            {banners}
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
                  <ul className="m-0 list-none p-0" aria-label="Done when">
                    {checks.map((text, index) => (
                      <li key={`${index}:${text}`} className="group flex h-7 items-center gap-2.5">
                        <StatusGlyph state="queued" size={14} />
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
                  <label className="flex h-7 cursor-text items-center gap-2.5">
                    <Icon name="plus" size={14} className="shrink-0 text-tertiary" />
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
              <div className="pb-1 pl-4 pr-3 @container">{controls}</div>
            </div>
            {menus}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                size="md"
                title={startBlockedReason ?? `Start task (${startChord()})`}
                disabled={!canStart}
                onClick={onStart}
              >
                Start task
              </Button>
              {draft ? (
                <Button
                  variant="ghost"
                  size="md"
                  disabled={!draft.canSave || draft.saving}
                  pending={draft.saving}
                  title={draft.canSave ? undefined : 'Write a brief or a check first'}
                  onClick={draft.onSave}
                >
                  {draft.continuing ? 'Update draft' : 'Save as draft'}
                </Button>
              ) : null}
              {approval ? <ApprovalNote approval={approval} onOpenSettings={onOpenSettings} /> : null}
            </div>
          </div>

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
      <span className="pl-1">{'on '}</span>
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
    const off = window.vyotiq.onToolsCatalogChanged?.((next) => {
      if (!cancelled) setCatalog(next)
    })
    void window.vyotiq.toolsCatalogGet?.({ workspacePath }).then((res) => {
      if (!cancelled && res.ok) setCatalog(res.data)
    })
    void window.vyotiq.mcpStatus?.({ workspacePath }).then((res) => {
      if (!cancelled && res.ok) setMcp(res.data.servers)
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [workspacePath])

  if (!catalog) return null
  const builtin = catalog.entries.filter((e) => e.source === 'builtin' && e.active).length
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
  const ruleFiles = rules
    ? [rules.agentsMd ? 'AGENTS.md' : null, rules.claudeMd ? 'CLAUDE.md' : null, rules.cursorrules ? '.cursorrules' : null].filter(
        (n): n is string => Boolean(n)
      )
    : []

  return (
    <aside className="min-w-0 pt-1" aria-label="What the agent will see" data-agent-sees>
      <h2 className={SECTION_LABEL}>What the agent will see</h2>
      {failed ? (
        <p className="mt-3 text-xs text-muted">This workspace’s context could not be read.</p>
      ) : (
        <ul className="m-0 mt-1.5 list-none p-0">
          <Fact
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
          />
          <Fact
            k="Index"
            v={context ? INDEX_LABEL[context.codeIndex.state] : null}
            d={context ? indexDetail(context.codeIndex) : null}
            open={onOpenSettings ? { label: 'Settings', run: () => onOpenSettings('indexing') } : undefined}
          />
          <Fact
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

function ruleFileCountLabel(n: number): string {
  return `${n} rule ${n === 1 ? 'file' : 'files'}`
}

/** "12,408 files · updated 4m ago" — this workspace's own index, when it has one. */
function indexDetail(index: { files?: number; indexedAt?: string }): string | null {
  if (index.files == null) return null
  const files = `${index.files.toLocaleString('en-US')} ${index.files === 1 ? 'file' : 'files'}`
  const ago = index.indexedAt ? relativeTimeAgo(index.indexedAt) : ''
  return ago ? `${files} · updated ${ago}` : files
}

/**
 * One fact the task starts from. A fact you can change is a way to where you
 * change it: the whole row is the link, its text still on the column's edge.
 */
function Fact({
  k,
  v,
  d,
  warn = false,
  open
}: {
  k: string
  v: ReactNode
  d?: string | null
  warn?: boolean
  /** Where it is changed: the page's name (said to screen readers) and how to get there. */
  open?: { label: string; run: () => void }
}) {
  const body = (
    <>
      {/* The separators are heard, not seen: a link's name reads "Index: Ready, …". */}
      <span className="block text-caption text-tertiary">{k}</span>
      <span className="sr-only">: </span>
      <span className="flex min-h-5 items-center gap-1.5 text-sm text-fg">
        {v === null ? (
          <span className="h-3 w-24 rounded-sm bg-surface" aria-label="Loading" />
        ) : (
          <span className="min-w-0 truncate">{v}</span>
        )}
        {warn ? <Icon name="warningCircle" size={13} className="shrink-0 text-warning" /> : null}
      </span>
      {d ? (
        <>
          <span className="sr-only">, </span>
          <span className={cn('block truncate text-xs', warn ? 'text-warning' : 'text-muted')}>{d}</span>
        </>
      ) : null}
    </>
  )
  return (
    <li data-fact={k}>
      {open ? (
        <button
          type="button"
          onClick={open.run}
          className={cn(
            '-mx-2 block w-[calc(100%+16px)] rounded-md px-2 py-1.5 text-left vy-transition focus-visible:vy-focus-ring',
            ROW_HOVER
          )}
        >
          {body}
          <span className="sr-only">, change in {open.label}</span>
        </button>
      ) : (
        <div className="py-1.5">{body}</div>
      )}
    </li>
  )
}
