import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@renderer/lib/ui'
import { MarkdownContent } from '@renderer/lib/ui'
import { allocateHeadingId } from '@renderer/lib/markdown/headingIds'
import { CHAT_RIGHT_PANEL_BODY } from '@renderer/lib/utils/layout'
import { handleTabListKeyDown } from '@renderer/lib/utils/tabListKeyboard'
import type { RunReceipt } from '@shared/ipc'
import { RunReceiptSchema } from '@shared/ipc'
import { EmptyPanel, PANEL_SUBTAB_BAR, panelSubtabClass } from './PanelChrome'
import { TodoChecklist } from './TodoChecklist'
import { TodoProgressBar } from './TasksCeilingBand'
import { isPlanDraftReady } from '../utils/planDraft'
import { useRunTodos } from '../hooks/useRunTodos'
import type { WorkspaceFileOpenOptions } from './FilesPanel'

type ArtifactTab = 'plan' | 'contract' | 'receipt'

const POLL_MS = 2000

const TAB_IDS: Record<ArtifactTab, string> = {
  plan: 'plan-tab-plan',
  contract: 'plan-tab-contract',
  receipt: 'plan-tab-receipt'
}

const PANEL_IDS: Record<ArtifactTab, string> = {
  plan: 'plan-panel-plan',
  contract: 'plan-panel-contract',
  receipt: 'plan-panel-receipt'
}

const TAB_TITLE: Record<ArtifactTab, string> = {
  plan: 'Plan',
  contract: 'Contract',
  receipt: 'Receipt'
}

const ARTIFACT_TABS: ReadonlyArray<{ id: ArtifactTab; label: string; file: string }> = [
  { id: 'plan', label: 'Plan', file: 'plan.md' },
  { id: 'contract', label: 'Contract', file: 'contract.md' },
  { id: 'receipt', label: 'Receipt', file: 'receipt.json' }
]

/** Prior-invoke receipt while a new turn is live — hide until interim/final aligns. */
export function isReceiptStaleForLiveRun(
  receipt: RunReceipt,
  opts: { running: boolean; invokeId?: number | null }
): boolean {
  if (!opts.running) return false
  if (receipt.status === 'done') return true
  if (
    opts.invokeId != null &&
    receipt.invokeId != null &&
    receipt.invokeId !== opts.invokeId
  ) {
    return true
  }
  return false
}

type OutlineHeading = { text: string; id: string; level: 1 | 2 | 3 }

/** Max outline rows before “+N more” (h1 omitted from nav when deeper headings exist). */
export const PLAN_OUTLINE_MAX = 12

export function parsePlanOutline(markdown: string): {
  headings: OutlineHeading[]
  checked: number
  unchecked: number
} {
  const all: OutlineHeading[] = []
  const used = new Map<string, number>()
  let checked = 0
  let unchecked = 0
  for (const line of markdown.split(/\r?\n/)) {
    const h = line.match(/^(#{1,3})\s+(.+)$/)
    if (h?.[1] && h[2]) {
      const level = h[1].length as 1 | 2 | 3
      const text = h[2].trim()
      // Always allocate so ids stay aligned with MarkdownContent headingIds.
      const id = allocateHeadingId(text, used)
      all.push({ text, id, level })
    }
    if (/^\s*[-*]\s+\[[xX]\]\s+/.test(line)) checked += 1
    else if (/^\s*[-*]\s+\[\s\]\s+/.test(line)) unchecked += 1
  }
  // Skip H1 in the nav when any H2/H3 exists — title already shows in the body.
  const hasDeeper = all.some((h) => h.level > 1)
  const headings = hasDeeper ? all.filter((h) => h.level > 1) : all
  return { headings, checked, unchecked }
}

/** Indent outline rows relative to the shallowest level shown. */
export function outlineIndentRem(level: 1 | 2 | 3, shallowest: 1 | 2 | 3): number {
  return Math.max(0, level - shallowest) * 0.65
}

function scrollToHeading(id: string, root: HTMLElement | null): void {
  // Prefer getElementById — CSS.escape is missing in some jsdom versions.
  const el =
    (root?.ownerDocument ?? document).getElementById(id) ??
    root?.querySelector(`[id="${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`)
  el?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

function receiptStatusTone(status: RunReceipt['status']): string {
  switch (status) {
    case 'done':
      return 'bg-success/15 text-success'
    case 'error':
      return 'bg-danger/15 text-danger'
    case 'cancelled':
      return 'bg-warning/15 text-warning'
    case 'running':
      return 'bg-surface text-muted'
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}

function PathList({
  paths,
  onOpenFile,
  label
}: {
  paths: string[]
  onOpenFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  label: string
}) {
  if (paths.length === 0) return null
  const shown = paths.slice(0, 12)
  const more = paths.length - shown.length
  return (
    <section>
      <h3 className="m-0 text-xs font-medium uppercase tracking-wide text-muted">{label}</h3>
      <ul className="mt-1.5 list-none space-y-1 p-0">
        {shown.map((p) => (
          <li key={p} className="min-w-0">
            {onOpenFile ? (
              <button
                type="button"
                className="block max-w-full truncate font-mono text-xs text-fg/80 underline-offset-2 hover:underline"
                title={p}
                onClick={() => onOpenFile(p)}
              >
                {p}
              </button>
            ) : (
              <span className="block truncate font-mono text-xs" title={p}>
                {p}
              </span>
            )}
          </li>
        ))}
        {more > 0 ? (
          <li className="text-caption text-muted">+{more} more</li>
        ) : null}
      </ul>
    </section>
  )
}

function ReceiptSummary({
  receipt,
  onOpenFile
}: {
  receipt: RunReceipt
  onOpenFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
}) {
  const failTop = receipt.failureClusters.slice(0, 5)
  const incomplete = Boolean(receipt.incomplete)
  const statusTone = incomplete
    ? 'bg-warning/15 text-warning'
    : receiptStatusTone(receipt.status)
  const statusLabel = incomplete ? 'incomplete' : receipt.status

  const contextChips: { label: string; value: string }[] = []
  if (receipt.tokenUsage?.billedInputTokens != null) {
    contextChips.push({ label: 'billed in', value: String(receipt.tokenUsage.billedInputTokens) })
  } else if (receipt.tokenUsage?.inputTokens != null) {
    contextChips.push({ label: 'in', value: String(receipt.tokenUsage.inputTokens) })
  }
  if (
    receipt.tokenUsage?.inputTokens != null &&
    receipt.tokenUsage?.billedInputTokens != null &&
    receipt.tokenUsage.billedInputTokens !== receipt.tokenUsage.inputTokens
  ) {
    contextChips.push({ label: 'window', value: String(receipt.tokenUsage.inputTokens) })
  }
  if (receipt.tokenUsage?.outputTokens != null) {
    contextChips.push({ label: 'out', value: String(receipt.tokenUsage.outputTokens) })
  }
  if (receipt.tokenUsage?.reasoningTokens != null && receipt.tokenUsage.reasoningTokens > 0) {
    contextChips.push({ label: 'reason', value: String(receipt.tokenUsage.reasoningTokens) })
  }
  if (receipt.compactionCount > 0) {
    contextChips.push({ label: 'compact', value: `×${receipt.compactionCount}` })
  }
  if (receipt.incomplete) {
    contextChips.push({ label: 'incomplete', value: receipt.incomplete.reason })
  }

  return (
    <div className="space-y-4 text-sm" data-receipt-summary>
      <section className="min-w-0">
        <h3 className="m-0 text-xs font-medium uppercase tracking-wide text-muted">Status</h3>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
          <span
            className={cn(
              'inline-flex shrink-0 rounded-md px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide',
              statusTone
            )}
            data-receipt-status={statusLabel}
          >
            {statusLabel}
          </span>
          <p className="m-0 min-w-0 text-xs text-muted [overflow-wrap:anywhere]">
            {receipt.statusError ? <span className="text-danger">{receipt.statusError}</span> : null}
            {receipt.statusError ? ' · ' : null}
            step {receipt.step}
            {receipt.mode ? ` · ${receipt.mode}` : ''}
          </p>
        </div>
        {receipt.goal ? (
          <p
            className="m-0 mt-2 line-clamp-3 text-xs text-muted [overflow-wrap:anywhere]"
            title={receipt.goal}
          >
            {receipt.goal}
          </p>
        ) : null}
        {receipt.contractExcerpt.trim() ? (
          <div className="mt-2 rounded-md border border-border/40 bg-surface/60 px-2.5 py-2">
            <p className="m-0 text-2xs font-medium uppercase tracking-wide text-muted">
              Contract
            </p>
            <p className="m-0 mt-1 whitespace-pre-wrap text-xs text-secondary [overflow-wrap:anywhere]">
              {receipt.contractExcerpt.trim()}
            </p>
          </div>
        ) : null}
      </section>

      <section className="min-w-0">
        <h3 className="m-0 text-xs font-medium uppercase tracking-wide text-muted">Tools</h3>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <span className="rounded-md bg-surface px-1.5 py-0.5 text-caption tabular-nums text-fg">
            {receipt.toolStats.totalCalls} calls
          </span>
          <span className="rounded-md bg-surface px-1.5 py-0.5 text-caption tabular-nums text-success">
            {receipt.toolStats.ok} ok
          </span>
          <span
            className={cn(
              'rounded-md bg-surface px-1.5 py-0.5 text-caption tabular-nums',
              receipt.toolStats.failed > 0 ? 'text-danger' : 'text-muted'
            )}
          >
            {receipt.toolStats.failed} failed
          </span>
        </div>
        {failTop.length > 0 ? (
          <ul className="mt-2 list-none space-y-1.5 p-0">
            {failTop.map((f) => (
              <li
                key={f.key}
                className="min-w-0 rounded-md border border-border/30 bg-surface/40 px-2 py-1.5 font-mono text-caption text-muted [overflow-wrap:anywhere]"
              >
                <span className="text-fg/80">{f.count}×</span> {f.key}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section>
        <h3 className="m-0 text-xs font-medium uppercase tracking-wide text-muted">Diagnostics</h3>
        <p className="m-0 mt-1.5 text-xs tabular-nums text-fg">
          {receipt.diagnostics.clean}/{receipt.diagnostics.calls} clean
        </p>
        {receipt.verification ? (
          <p
            className={cn(
              'm-0 mt-1 text-caption',
              receipt.verification.verifiedAfterLastMutation ? 'text-success' : 'text-warning'
            )}
            data-receipt-verification={String(receipt.verification.verifiedAfterLastMutation)}
          >
            {receipt.verification.verifiedAfterLastMutation
              ? 'Verified after last file mutation'
              : 'File mutations after last successful check (unverified)'}
          </p>
        ) : null}
      </section>

      <PathList
        label="Unread edits"
        paths={receipt.unreadEditPaths}
        onOpenFile={onOpenFile}
      />
      <PathList label="Wrote" paths={receipt.wroteFiles} onOpenFile={onOpenFile} />

      {contextChips.length > 0 ? (
        <section className="min-w-0">
          <h3 className="m-0 text-xs font-medium uppercase tracking-wide text-muted">Context</h3>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {contextChips.map((c) => (
              <span
                key={`${c.label}:${c.value}`}
                className="inline-flex max-w-full items-baseline gap-1 rounded-md bg-surface px-1.5 py-0.5 text-caption [overflow-wrap:anywhere]"
              >
                <span className="text-muted">{c.label}</span>
                <span className="tabular-nums text-fg">{c.value}</span>
              </span>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function receiptToolFailHint(receipt: RunReceipt): string | null {
  const { toolStats, failureClusters } = receipt
  if (toolStats.failed <= 0) return null
  const top = failureClusters[0]?.key
  return top
    ? `${toolStats.failed} tool failure${toolStats.failed === 1 ? '' : 's'} · ${top}`
    : `${toolStats.failed} tool failure${toolStats.failed === 1 ? '' : 's'} — check receipt.json`
}

/**
 * Docked panel for run plan.md / contract.md / receipt.json artifacts.
 * Identity must be passed as props — this panel sits outside RunSessionProvider.
 */
export const PlanPanel = memo(function PlanPanel({
  workspacePath,
  runId,
  running = false,
  invokeId = null,
  active = true,
  agentMode = 'agent',
  onContinueInAgent,
  onOpenFile,
  className
}: {
  workspacePath: string | null
  runId: string | null
  running?: boolean
  /** Live chatStart invoke; used to detect prior-invoke receipt drift. */
  invokeId?: number | null
  /** False while the plan dock tab is CSS-hidden — skip mid-run polling. */
  active?: boolean
  agentMode?: 'ask' | 'plan' | 'agent'
  onContinueInAgent?: () => void
  onOpenFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  className?: string
}) {
  const [tab, setTab] = useState<ArtifactTab>('plan')
  const [content, setContent] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<RunReceipt | null>(null)
  /** Receipt snapshot for Continue footer while viewing plan.md (not the receipt tab). */
  const [continueReceipt, setContinueReceipt] = useState<RunReceipt | null>(null)
  /** True when a live run hid a prior/mismatched receipt (not a true absence). */
  const [receiptDeferred, setReceiptDeferred] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wasRunningRef = useRef(running)
  const loadSeqRef = useRef(0)
  const scrollRootRef = useRef<HTMLDivElement | null>(null)
  const {
    data: todosData,
    error: todosError
  } = useRunTodos({
    workspacePath,
    runId,
    running,
    active: active && tab === 'plan'
  })
  const todoItems = todosData?.items ?? []
  const hasTodos = todoItems.length > 0

  useEffect(() => {
    setTab('plan')
  }, [runId])

  const parseReceiptText = useCallback(
    (rawText: string): { receipt: RunReceipt | null; deferred: boolean; error: string | null } => {
      let raw: unknown
      try {
        raw = JSON.parse(rawText) as unknown
      } catch {
        return { receipt: null, deferred: false, error: 'Invalid receipt.json' }
      }
      const parsed = RunReceiptSchema.safeParse(raw)
      if (!parsed.success) {
        return { receipt: null, deferred: false, error: 'Invalid receipt.json' }
      }
      if (isReceiptStaleForLiveRun(parsed.data, { running, invokeId })) {
        return { receipt: null, deferred: true, error: null }
      }
      return { receipt: parsed.data, deferred: false, error: null }
    },
    [running, invokeId]
  )

  const load = useCallback(
    async (opts?: { quiet?: boolean }) => {
      const seq = ++loadSeqRef.current
      const requestedTab = tab
      if (!workspacePath || !runId) {
        if (seq !== loadSeqRef.current) return
        setContent(null)
        setReceipt(null)
        setContinueReceipt(null)
        setReceiptDeferred(false)
        setError(null)
        setLoading(false)
        return
      }
      if (!opts?.quiet) {
        setLoading(true)
        setError(null)
      }
      try {
        const name =
          requestedTab === 'plan'
            ? 'plan.md'
            : requestedTab === 'contract'
              ? 'contract.md'
              : 'receipt.json'
        const res = await window.vyotiq.readRunArtifact({ workspacePath, runId, name })
        if (seq !== loadSeqRef.current) return
        if (!res.ok) {
          setContent(null)
          setReceipt(null)
          if (requestedTab === 'receipt') setContinueReceipt(null)
          setReceiptDeferred(false)
          setError(res.error)
          return
        }
        if (!res.data.exists) {
          setContent(null)
          setReceipt(null)
          if (requestedTab === 'receipt') setContinueReceipt(null)
          setReceiptDeferred(false)
          setError(null)
          return
        }
        if (requestedTab === 'receipt') {
          const parsed = parseReceiptText(res.data.content ?? '')
          setReceipt(parsed.receipt)
          setContinueReceipt(parsed.receipt)
          setReceiptDeferred(parsed.deferred)
          setContent(null)
          setError(parsed.error)
        } else {
          setContent(res.data.content)
          setReceipt(null)
          setReceiptDeferred(false)
          setError(null)
          // Keep Continue footer tool-fail hint accurate while on plan/contract.
          if (requestedTab === 'plan') {
            const receiptRes = await window.vyotiq.readRunArtifact({
              workspacePath,
              runId,
              name: 'receipt.json'
            })
            if (seq !== loadSeqRef.current) return
            if (receiptRes.ok && receiptRes.data.exists) {
              const parsed = parseReceiptText(receiptRes.data.content ?? '')
              setContinueReceipt(parsed.receipt)
            } else {
              setContinueReceipt(null)
            }
          }
        }
      } catch (err) {
        if (seq !== loadSeqRef.current) return
        setContent(null)
        setReceipt(null)
        setContinueReceipt(null)
        setReceiptDeferred(false)
        setError(err instanceof Error ? err.message : 'Failed to load artifact')
      } finally {
        // Latest load always clears loading — quiet polls must not leave a
        // superseded non-quiet load stuck on "Loading…".
        if (seq === loadSeqRef.current) setLoading(false)
      }
    },
    [workspacePath, runId, tab, parseReceiptText]
  )

  useEffect(() => {
    void load()
  }, [load])

  // Reload when the agent run finishes so post-write plan/contract/receipt appear.
  useEffect(() => {
    const wasRunning = wasRunningRef.current
    wasRunningRef.current = running
    if (wasRunning && !running) {
      void load({ quiet: true })
    }
  }, [running, load])

  // Drop a stale in-memory receipt when a new invoke starts (before poll lands).
  useEffect(() => {
    if (!running || !receipt) return
    if (isReceiptStaleForLiveRun(receipt, { running, invokeId })) {
      setReceipt(null)
      setContinueReceipt(null)
      setReceiptDeferred(true)
    }
  }, [running, invokeId, receipt])

  useEffect(() => {
    if (!running || !continueReceipt) return
    if (isReceiptStaleForLiveRun(continueReceipt, { running, invokeId })) {
      setContinueReceipt(null)
    }
  }, [running, invokeId, continueReceipt])

  // Poll while the panel is visible — mid-run edits and idle post-write refresh.
  useEffect(() => {
    if (!active || !workspacePath || !runId) return
    const id = window.setInterval(() => {
      void load({ quiet: true })
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [active, workspacePath, runId, load])

  const panelTitle = TAB_TITLE[tab]
  const emptyTitle =
    tab === 'plan'
      ? 'No plan drafted yet'
      : tab === 'contract'
        ? 'No contract yet'
        : receiptDeferred
          ? 'Receipt updating'
          : 'No receipt yet'
  const emptyBody =
    tab === 'plan'
      ? agentMode === 'plan'
        ? 'Draft plan.md for this run — Goal, Steps, and Done when. create_plan copies Done when into the contract.'
        : 'Switch to Plan mode and draft plan.md, or continue from an existing plan.'
      : tab === 'contract'
        ? 'The run contract is created when a chat starts.'
        : receiptDeferred
          ? 'Prior receipt is hidden while this run is live. A new receipt appears when the turn writes it.'
          : 'receipt.json appears when the run writes it.'

  const showEmpty =
    !loading &&
    !error &&
    (tab === 'receipt'
      ? !receipt
      : tab === 'contract'
        ? !content
        : !hasTodos && !content?.trim())

  const planOutline =
    tab === 'plan' && content && isPlanDraftReady(content) ? parsePlanOutline(content) : null

  const showContinue =
    Boolean(onContinueInAgent) &&
    agentMode === 'plan' &&
    !running &&
    tab === 'plan' &&
    isPlanDraftReady(content)
  const toolFailHint = continueReceipt ? receiptToolFailHint(continueReceipt) : null

  const tasksBlock =
    tab === 'plan' && hasTodos ? (
      <div className="mb-3 min-w-0" data-plan-tasks>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <p className="m-0 text-2xs font-medium uppercase tracking-[var(--vy-tracking-caps)] text-muted">
            Tasks
          </p>
          <span className="shrink-0 tabular-nums text-caption text-muted">
            {todosData!.done}/{todosData!.total}
          </span>
        </div>
        {todosError ? (
          <p className="m-0 text-caption text-danger">{todosError}</p>
        ) : (
          <>
            <TodoProgressBar done={todosData!.done} total={todosData!.total} />
            <TodoChecklist items={todoItems} className="mt-1.5" />
          </>
        )}
      </div>
    ) : null

  return (
    <div
      className={cn(CHAT_RIGHT_PANEL_BODY, className)}
      data-plan-panel
      role="region"
      aria-label={`${panelTitle} panel`}
    >
      <div
        className={PANEL_SUBTAB_BAR}
        role="tablist"
        aria-label="Plan artifacts"
        tabIndex={-1}
        onKeyDown={(event) =>
          handleTabListKeyDown(event, {
            tabs: ARTIFACT_TABS.map((item) => item.id),
            activeId: tab,
            onSelect: (id) => setTab(id as ArtifactTab)
          })
        }
      >
        {ARTIFACT_TABS.map((item) => (
          <button
            key={item.id}
            id={TAB_IDS[item.id]}
            type="button"
            role="tab"
            className={panelSubtabClass(tab === item.id)}
            aria-selected={tab === item.id}
            aria-controls={PANEL_IDS[item.id]}
            title={item.file}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        id={PANEL_IDS[tab]}
        role="tabpanel"
        aria-labelledby={TAB_IDS[tab]}
        ref={scrollRootRef}
        className={cn(
          'min-h-0 min-w-0 flex-1 overflow-auto p-3',
          showEmpty && 'flex flex-col'
        )}
      >
        {loading ? (
          <p className="m-0 text-xs text-muted">Loading…</p>
        ) : error ? (
          <p className="m-0 text-xs text-danger">{error}</p>
        ) : showEmpty ? (
          <EmptyPanel icon="file" title={emptyTitle} body={emptyBody} centered />
        ) : tab === 'receipt' && receipt ? (
          <ReceiptSummary receipt={receipt} onOpenFile={onOpenFile} />
        ) : tab === 'plan' ? (
          <div data-plan-doc className="min-w-0">
            {tasksBlock}
            {planOutline ? (
              <>
                {planOutline.headings.length > 0 ||
                (!hasTodos && planOutline.checked + planOutline.unchecked > 0) ? (
                  <nav
                    className="mb-3 rounded-md border border-border/40 bg-surface px-2.5 py-2"
                    aria-label="Plan outline"
                  >
                    <p className="m-0 text-2xs font-medium uppercase tracking-[var(--vy-tracking-caps)] text-muted">
                      Outline
                    </p>
                    {/*
                      Markdown checkboxes are the draft's static record; the
                      Tasks section above is the live source of truth. Show
                      this count only when no todos.json exists for the run.
                    */}
                    {!hasTodos && planOutline.checked + planOutline.unchecked > 0 ? (
                      <p className="m-0 mt-1 text-caption text-muted">
                        Checklist {planOutline.checked}/
                        {planOutline.checked + planOutline.unchecked}
                      </p>
                    ) : null}
                    {planOutline.headings.length > 0 ? (
                      (() => {
                        const shallowest = planOutline.headings.reduce(
                          (min, row) => (row.level < min ? row.level : min),
                          planOutline.headings[0]!.level
                        )
                        const visible = planOutline.headings.slice(0, PLAN_OUTLINE_MAX)
                        const hidden = planOutline.headings.length - visible.length
                        return (
                          <ul className="m-0 mt-1.5 list-none space-y-0.5 p-0">
                            {visible.map((h) => (
                              <li
                                key={h.id}
                                className="min-w-0"
                                style={{
                                  paddingLeft: `${outlineIndentRem(h.level, shallowest)}rem`
                                }}
                              >
                                <button
                                  type="button"
                                  className={cn(
                                    'block w-full whitespace-normal break-words text-left text-caption leading-snug underline-offset-2 hover:underline',
                                    h.level === 1 && 'font-medium text-fg',
                                    h.level === 2 && 'text-fg/90',
                                    h.level === 3 && 'text-fg/75'
                                  )}
                                  title={h.text}
                                  onClick={() => scrollToHeading(h.id, scrollRootRef.current)}
                                >
                                  {h.text}
                                </button>
                              </li>
                            ))}
                            {hidden > 0 ? (
                              <li className="pt-0.5 text-caption text-muted">+{hidden} more</li>
                            ) : null}
                          </ul>
                        )
                      })()
                    ) : null}
                  </nav>
                ) : null}
                <MarkdownContent
                  content={content!}
                  headingIds
                  readOnlyTasks
                  className="text-sm"
                />
              </>
            ) : content && !isPlanDraftReady(content) ? (
              <MarkdownContent content={content} readOnlyTasks className="text-sm" />
            ) : null}
          </div>
        ) : (
          <MarkdownContent
            content={content ?? ''}
            readOnlyTasks
            className="text-sm"
          />
        )}
      </div>
      {showContinue ? (
        <div
          className="flex shrink-0 items-center gap-3 border-t border-border/40 px-3 py-2"
          data-plan-continue
        >
          <div className="min-w-0 flex-1">
            {toolFailHint ? (
              <p className="m-0 truncate text-caption text-warning" title={toolFailHint}>
                {toolFailHint}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onContinueInAgent}
            className="shrink-0 rounded-xl border border-border px-2.5 py-1.5 text-caption font-medium text-fg transition-colors hover:bg-surface"
          >
            Continue in Agent
          </button>
        </div>
      ) : null}
    </div>
  )
})
