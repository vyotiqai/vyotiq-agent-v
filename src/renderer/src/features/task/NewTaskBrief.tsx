import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { AgentInteractionMode, McpServerStatus, ToolApprovalMode, ToolCatalogResult } from '@shared/ipc'
import { providerLabel } from '@shared/domain/providers'
import { modelSelectionKey } from '@shared/domain/modelSelection'
import { relativeTimeAgo } from '@shared/utils/timeFormat'
import { Button, IconButton, Menu, Segmented, StatusGlyph, cn, type MenuOption } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'
import { MODES } from '@renderer/features/chat/components/composer/ModePicker'
import { TaskOptions, capabilities, type TaskOptionsProps } from '@renderer/features/chat/components/composer/TaskOptions'
import {
  buildModes,
  modeIndex,
  modelShowsThinkingControls,
  resolveThinkingUiMeta
} from '@renderer/features/chat/components/composer/ThinkingControls'
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

const MODE_NOTE: Record<AgentInteractionMode, string> = {
  agent: 'Plans, edits files and runs commands in the workspace',
  ask: 'Reads and answers — changes nothing'
}

const MODE_NOTE_WORKTREE = 'Plans, edits files and runs commands in the new worktree'

const APPROVAL_NOTE: Record<ToolApprovalMode, string> = {
  off: 'Runs its tools without asking',
  mutating: 'Asks before edits and commands',
  all: 'Asks before every tool'
}

const INDEX_LABEL = { ready: 'Ready', building: 'Building', degraded: 'Degraded', off: 'Off', paused: 'Paused' } as const

function startChord(): string {
  return window.vyotiq?.platform === 'darwin' ? '⌘↵' : 'Ctrl+Enter'
}

/**
 * Starting a task is filling in a brief, not opening a chat: what to do, the
 * checks the run is judged against, how it runs, and — beside it — what the
 * agent will see. The brief itself is the composer's input, so @ context,
 * attachments and / skills work here as they do on the instruction line.
 */
export function NewTaskBrief({
  workspacePath,
  targets,
  brief,
  input,
  attachments,
  banners,
  fileInput,
  menus,
  attachLabel,
  attachDisabled,
  onAttach,
  onMention,
  options,
  canStart,
  startBlockedReason,
  onChecksChange,
  onStart,
  onOpenSettings,
  headerActions,
  mic,
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
  banners: ReactNode
  fileInput: ReactNode
  menus: ReactNode
  attachLabel: string
  attachDisabled: boolean
  onAttach: () => void
  onMention: () => void
  options: TaskOptionsProps
  canStart: boolean
  startBlockedReason: string | null
  /** The checks as they stand, a half-typed one included — whatever starts the task sends them. */
  onChecksChange: (doneWhen: string[]) => void
  onStart: () => void
  onOpenSettings?: (section: 'agent') => void
  /** The pane's own controls: show the inspector, close a split pane. */
  headerActions?: ReactNode
  /** Dictation, as on the instruction line. */
  mic?: ReactNode
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
  const [adding, setAdding] = useState(false)
  const [draftCheck, setDraftCheck] = useState('')
  const addRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (adding) addRef.current?.focus()
  }, [adding])

  // An empty "add a check" row folds away when focus leaves it. When a press
  // took focus (Start task, Save as draft), fold it only once that press is
  // over: folding at blur moves those buttons up under the pointer between
  // its down and its up, and the click is lost.
  const pointerDownRef = useRef(false)
  useEffect(() => {
    const down = (): void => {
      pointerDownRef.current = true
    }
    const up = (): void => {
      pointerDownRef.current = false
    }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', up, true)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', up, true)
    }
  }, [])
  const collapseEmptyCheck = (): void => {
    if (!pointerDownRef.current) {
      setAdding(false)
      return
    }
    const afterPress = (): void => {
      window.removeEventListener('pointerup', afterPress, true)
      window.removeEventListener('pointercancel', afterPress, true)
      // The click comes after pointerup in the same gesture; fold after it.
      window.setTimeout(() => setAdding(false), 0)
    }
    window.addEventListener('pointerup', afterPress, true)
    window.addEventListener('pointercancel', afterPress, true)
  }

  useEffect(() => {
    if (!clearToken) return
    setAdding(false)
    setDraftCheck('')
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
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setAdding(false)
      setDraftCheck('')
    }
  }

  return (
    // The pane around it is already the "New task" region.
    <div className="flex min-h-0 flex-1 flex-col bg-bg" data-new-task>
      <header
        className="flex h-10 shrink-0 items-center gap-1 border-b border-border pl-4 pr-2 text-xs text-muted"
        data-task-header
      >
        <h1 className="mr-2 text-sm font-semibold text-fg-strong">New task</h1>
        {workspacePath ? (
          <>
            {'in '}
            <WorkspaceSelect workspacePath={workspacePath} targets={targets} brief={brief} />
            <BranchSelect workspacePath={workspacePath} worktree={worktree} onWorktreeChange={onWorktreeChange} />
          </>
        ) : null}
        <span className="flex-1" />
        {headerActions}
      </header>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[1040px] grid-cols-[minmax(0,1fr)_260px] gap-12 px-8 pb-12 pt-6">
          <div className="min-w-0">
            {banners}
            <div
              className="rounded-lg border border-border bg-bg vy-transition focus-within:border-border-strong"
              data-brief
            >
              {fileInput}
              <div className="px-4 pt-3">{input}</div>
              <div className="flex flex-wrap items-center gap-1 px-3 pb-3 pt-1">
                <div className="min-w-0 flex-1">{attachments}</div>
                <IconButton
                  icon="at"
                  label="Add context (@)"
                  size="md"
                  tone="muted"
                  disabled={attachDisabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={onMention}
                />
                <IconButton
                  icon="paperclip"
                  label={attachLabel}
                  size="md"
                  tone="muted"
                  disabled={attachDisabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={onAttach}
                />
                {mic}
              </div>
            </div>
            {menus}

            <Block label="Done when" hint="The run is checked against these before it can finish">
              {checks.length > 0 || adding ? (
                <ul className="m-0 list-none divide-y divide-border border-y border-border p-0" aria-label="Done when">
                  {checks.map((text, index) => (
                    <li key={`${index}:${text}`} className="group flex h-9 items-center gap-2.5">
                      <StatusGlyph state="queued" size={14} />
                      <span className="min-w-0 flex-1 truncate text-sm text-fg" title={text}>
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
                  {adding ? (
                    <li className="flex h-9 items-center gap-2.5">
                      <StatusGlyph state="queued" size={14} />
                      <input
                        ref={addRef}
                        value={draftCheck}
                        maxLength={CHECK_MAX_CHARS}
                        onChange={(e) => setDraftCheck(e.target.value)}
                        onKeyDown={onCheckKeyDown}
                        onBlur={() => {
                          if (!draftCheck.trim()) collapseEmptyCheck()
                        }}
                        placeholder="A result you can check — a command that passes, a file that exists"
                        aria-label="New check"
                        className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-tertiary"
                      />
                    </li>
                  ) : null}
                </ul>
              ) : null}
              {checks.length < MAX_CHECKS ? (
                <button
                  type="button"
                  className="mt-1 inline-flex h-7 items-center gap-1.5 rounded-sm text-xs text-muted vy-transition hover:text-fg focus-visible:vy-focus-ring"
                  onClick={() => (adding ? addCheck() : setAdding(true))}
                >
                  <Icon name="plus" size={13} />
                  Add a check
                </button>
              ) : null}
            </Block>

            <Block label="How it runs">
              <HowItRuns options={options} onOpenSettings={onOpenSettings} worktree={worktree} />
            </Block>

            <div className="mt-8 flex items-center gap-2">
              <Button
                variant="primary"
                size="md"
                icon="play"
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
            </div>
          </div>

          {workspacePath ? <WhatTheAgentSees workspacePath={workspacePath} worktree={worktree} /> : null}
        </div>
      </div>
    </div>
  )
}

function Block({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-2 flex items-baseline gap-3">
        <h2 className={cn(SECTION_LABEL, 'shrink-0 whitespace-nowrap')}>{label}</h2>
        {hint ? <span className="min-w-0 truncate text-xs text-tertiary">{hint}</span> : null}
      </div>
      {children}
    </section>
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

const WHERE_OPTIONS: MenuOption[] = [
  { value: 'here', label: 'This folder' },
  { value: 'worktree', label: 'New worktree' }
]

/**
 * The branch the task starts on (picking another checks it out), and where it
 * works: in this folder, or in a new worktree branched from it — only offered
 * when there is a branch with a commit to branch from.
 */
function BranchSelect({
  workspacePath,
  worktree,
  onWorktreeChange
}: {
  workspacePath: string
  worktree: boolean
  onWorktreeChange?: (worktree: boolean) => void
}) {
  const [revision, setRevision] = useState(0)
  const git = useGitStatus(workspacePath, revision, true, 0)
  const [branches, setBranches] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
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
        onChange={(name) => {
          if (name === branch) return
          const dirty = (git.status?.fileCount ?? 0) > 0
          if (
            dirty &&
            !window.confirm(`The working tree has uncommitted changes. Git refuses to check out "${name}" if they would be overwritten.`)
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
      {onWorktreeChange && git.status?.hasCommits ? (
        <>
          <span aria-hidden="true" className="px-1 text-tertiary">
            ·
          </span>
          <Menu
            value={worktree ? 'worktree' : 'here'}
            options={WHERE_OPTIONS}
            onChange={(where) => onWorktreeChange(where === 'worktree')}
            aria-label="Where it works"
            placement="down"
            bare
            quiet
          />
        </>
      ) : null}
      {error ? (
        <span className="ml-2 min-w-0 truncate text-danger" role="alert" title={error}>
          {error}
        </span>
      ) : null}
    </>
  )
}

function HowItRuns({
  options,
  onOpenSettings,
  worktree
}: {
  options: TaskOptionsProps
  onOpenSettings?: (section: 'agent') => void
  worktree: boolean
}) {
  const { provider, model, modelMetaByValue, agentMode, onAgentModeChange, chatSettings, onChatSettingsChange } = options
  const locked = Boolean(options.disabled)
  const meta = modelMetaByValue[modelSelectionKey(provider, model)] ?? modelMetaByValue[model]
  const thinkingUi = resolveThinkingUiMeta(provider, model, meta)
  const effortModes = buildModes(
    thinkingUi.supportedThinkingEfforts,
    thinkingUi.thinkingCanDisable,
    thinkingUi.thinkingMode,
    thinkingUi.thinkingDefaultEffort
  )
  const showsEffort = modelShowsThinkingControls(provider, model, meta)
  const effortAt = modeIndex(effortModes, chatSettings.thinkingEnabled, chatSettings.thinkingEffort)
  const can = capabilities(meta).map((c) => c.label.toLowerCase())
  const approval = chatSettings.toolApproval
  const approvalNote = [
    APPROVAL_NOTE[approval.mode],
    approval.mode !== 'all' && approval.mcpProtection !== false ? 'MCP tools ask first' : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <dl className="m-0 grid grid-cols-[88px_1fr] items-center gap-y-2.5 text-sm">
      <dt className="text-muted">Mode</dt>
      <dd className="m-0 flex min-w-0 items-center gap-3">
        <Segmented
          label="Mode"
          value={agentMode}
          // Agent first: it is what a task usually is.
          items={[...MODES].sort((a, b) => Number(b.value === 'agent') - Number(a.value === 'agent')).map((m) => ({ id: m.value, label: m.label }))}
          onChange={onAgentModeChange}
          disabled={locked}
        />
        <span className="min-w-0 truncate text-xs text-tertiary">
          {worktree && agentMode === 'agent' ? MODE_NOTE_WORKTREE : MODE_NOTE[agentMode]}
        </span>
      </dd>
      <dt className="text-muted">Model</dt>
      <dd className="m-0 flex min-w-0 items-center gap-3">
        <TaskOptions {...options} trigger="model" />
        <span className="min-w-0 truncate text-xs text-tertiary">
          {[providerLabel(provider), ...can].join(' · ')}
        </span>
      </dd>
      {showsEffort ? (
        <>
          <dt className="text-muted">Effort</dt>
          <dd className="m-0">
            <Segmented
              label="Effort"
              value={String(effortAt)}
              items={effortModes.map((m, i) => ({ id: String(i), label: m.short, title: m.label }))}
              onChange={(id) => {
                const next = effortModes[Number(id)]
                if (!next) return
                onChatSettingsChange(
                  next.enabled ? { thinkingEnabled: true, thinkingEffort: next.effort } : { thinkingEnabled: false }
                )
              }}
              disabled={locked}
            />
          </dd>
        </>
      ) : null}
      <dt className="text-muted">Approvals</dt>
      <dd className="m-0 flex min-w-0 items-center gap-2 text-xs text-secondary">
        <span className="min-w-0 truncate">{approvalNote}</span>
        {onOpenSettings ? (
          <button
            type="button"
            className="shrink-0 rounded-sm font-medium text-muted underline-offset-2 vy-transition hover:text-fg hover:underline focus-visible:vy-focus-ring"
            onClick={() => onOpenSettings('agent')}
          >
            Change
          </button>
        ) : null}
      </dd>
    </dl>
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

function WhatTheAgentSees({ workspacePath, worktree }: { workspacePath: string; worktree: boolean }) {
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
        <dl className="m-0 mt-3 space-y-3">
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
          />
          <Fact
            k="Memory"
            v={context ? (context.memoryNotes > 0 ? `${context.memoryNotes} ${context.memoryNotes === 1 ? 'note' : 'notes'}` : 'None') : null}
            d={context?.memoryNoteNames?.join(', ') ?? null}
          />
          <Fact k="Index" v={context ? INDEX_LABEL[context.codeIndex.state] : null} d={context ? indexDetail(context.codeIndex) : null} />
          <Fact
            k="Tools"
            v={tools ? `${tools.builtin} built-in · ${tools.servers} MCP ${tools.servers === 1 ? 'server' : 'servers'}` : null}
            d={tools?.problem ?? null}
            warn={Boolean(tools?.problem)}
          />
        </dl>
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

function Fact({ k, v, d, warn = false }: { k: string; v: ReactNode; d?: string | null; warn?: boolean }) {
  return (
    <div>
      <dt className="text-caption text-tertiary">{k}</dt>
      <dd className="m-0 flex min-h-5 items-center gap-1.5 text-sm text-fg">
        {v === null ? (
          <span className="h-3 w-24 rounded-sm bg-surface" aria-label="Loading" />
        ) : (
          <span className="min-w-0 truncate">{v}</span>
        )}
        {warn ? <Icon name="warningCircle" size={13} className="shrink-0 text-warning" /> : null}
      </dd>
      {d ? <dd className={cn('m-0 truncate text-xs', warn ? 'text-warning' : 'text-muted')}>{d}</dd> : null}
    </div>
  )
}
