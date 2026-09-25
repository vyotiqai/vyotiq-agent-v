import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActionMenu, Button, IconButton, MarkdownContent, cn } from '@renderer/lib/ui'
import { CHAT_RIGHT_PANEL_BODY, SECTION_LABEL } from '@renderer/lib/utils/layout'
import type { RunReceipt } from '@shared/ipc'
import { RunReceiptSchema } from '@shared/ipc'
import { useRunChecks } from '@renderer/features/task/useRunChecks'
import { EmptyPanel } from './PanelChrome'
import { isPlanDraftReady } from '../utils/planDraft'
import { useRunTodos } from '../hooks/useRunTodos'
import type { WorkspaceFileOpenOptions } from './FilesPanel'

type ArtifactView = 'plan' | 'contract' | 'receipt'

const POLL_MS = 2000

const VIEW_TITLE: Record<ArtifactView, string> = {
  plan: 'Plan',
  contract: 'Contract',
  receipt: 'Receipt'
}

const VIEW_FILE: Record<ArtifactView, 'plan.md' | 'contract.md' | 'receipt.json'> = {
  plan: 'plan.md',
  contract: 'contract.md',
  receipt: 'receipt.json'
}

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

export type PlanDocument = {
  /** The `# Title` create_plan writes, when there is one. */
  title: string | null
  /** Anything between the title and the first section. */
  lead: string
  sections: Array<{ heading: string; body: string }>
}

/**
 * plan.md as the Plan tab lays it out: its title, then one section per `## `
 * heading. A heading inside fenced code stays code.
 */
export function planDocument(markdown: string): PlanDocument {
  let title: string | null = null
  const lead: string[] = []
  const sections: Array<{ heading: string; lines: string[] }> = []
  let fence: string | null = null
  for (const line of markdown.split(/\r?\n/)) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (mark) {
      if (fence === null) fence = mark[0]!
      else if (mark[0] === fence) fence = null
    } else if (fence === null) {
      const h1 = /^#\s+(.+?)\s*#*\s*$/.exec(line)
      if (h1 && title === null && sections.length === 0 && !lead.some((l) => l.trim())) {
        title = h1[1]!
        continue
      }
      const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line)
      if (h2) {
        sections.push({ heading: h2[1]!, lines: [] })
        continue
      }
    }
    ;(sections[sections.length - 1]?.lines ?? lead).push(line)
  }
  return {
    title,
    lead: lead.join('\n').trim(),
    sections: sections.map((section) => ({ heading: section.heading, body: section.lines.join('\n').trim() }))
  }
}

/**
 * The record already shows these live — the run's steps from todos.json and
 * its done-when checks from checks.json — so the document leaves them out
 * when the run has them, and keeps them when it does not.
 */
function recordShows(heading: string, live: { steps: boolean; checks: boolean }): boolean {
  const h = heading.trim().toLowerCase()
  return (live.steps && h === 'steps') || (live.checks && h === 'done when')
}

function receiptStatusTone(status: RunReceipt['status']): string {
  switch (status) {
    case 'done':
      return 'bg-success-soft text-success'
    case 'error':
      return 'bg-danger-soft text-danger'
    case 'cancelled':
      return 'bg-warning-soft text-warning'
    case 'running':
      return 'bg-surface-2 text-muted'
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
      <h3 className={SECTION_LABEL}>{label}</h3>
      <ul className="mt-2 list-none space-y-1 p-0">
        {shown.map((p) => (
          <li key={p} className="min-w-0">
            {onOpenFile ? (
              <button
                type="button"
                className="block max-w-full truncate font-mono text-xs text-secondary underline-offset-2 hover:text-fg hover:underline"
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
    ? 'bg-warning-soft text-warning'
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
  if (receipt.verificationGate?.wouldFire) {
    // Files changed with no passing check after them. Reported, not enforced.
    contextChips.push({
      label: 'unchecked',
      value: receipt.verificationGate.reason === 'check_failed' ? 'check failed' : 'no check'
    })
  }

  return (
    <div className="mt-4 space-y-5 text-sm" data-receipt-summary>
      <section className="min-w-0">
        <h3 className={SECTION_LABEL}>Status</h3>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
          <span
            className={cn(
              'inline-flex h-[18px] shrink-0 items-center rounded-sm px-1.5 text-caption font-medium leading-none',
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
          <div className="mt-3">
            <p className={SECTION_LABEL}>Contract</p>
            <p className="m-0 mt-1 whitespace-pre-wrap text-xs text-secondary [overflow-wrap:anywhere]">
              {receipt.contractExcerpt.trim()}
            </p>
          </div>
        ) : null}
      </section>

      <section className="min-w-0">
        <h3 className={SECTION_LABEL}>Tools</h3>
        <div className="mt-2 flex flex-wrap gap-1.5">
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
                className="min-w-0 rounded-md bg-danger-soft px-2 py-1.5 font-mono text-caption text-secondary [overflow-wrap:anywhere]"
              >
                <span className="text-fg">{f.count}×</span> {f.key}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section>
        <h3 className={SECTION_LABEL}>Diagnostics</h3>
        <p className="m-0 mt-2 text-xs tabular-nums text-fg">
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
          <h3 className={SECTION_LABEL}>Context</h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
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

/**
 * The inspector's Plan tab: the plan document only. Its steps, the done-when
 * checks and the receipt already live in the record with live state; the
 * contract and the full receipt stay one menu away.
 * Identity must be passed as props — this panel sits outside RunSessionProvider.
 */
export const PlanPanel = memo(function PlanPanel({
  workspacePath,
  runId,
  running = false,
  invokeId = null,
  active = true,
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
  onOpenFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  className?: string
}) {
  const [tab, setTab] = useState<ArtifactView>('plan')
  const [menuOpen, setMenuOpen] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<RunReceipt | null>(null)
  /** True when a live run hid a prior/mismatched receipt (not a true absence). */
  const [receiptDeferred, setReceiptDeferred] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wasRunningRef = useRef(running)
  const loadSeqRef = useRef(0)
  const scrollRootRef = useRef<HTMLDivElement | null>(null)
  const { data: todosData } = useRunTodos({
    workspacePath,
    runId,
    running,
    active: active && tab === 'plan'
  })
  const hasTodos = (todosData?.items.length ?? 0) > 0
  // create_plan writes checks.json with plan.md, so the plan's text is the
  // moment to look again.
  const checks = useRunChecks(workspacePath, runId, tab === 'plan' ? (content ?? '') : '')

  useEffect(() => {
    setTab('plan')
    setOpenError(null)
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
          setReceiptDeferred(false)
          setError(res.error)
          return
        }
        if (!res.data.exists) {
          setContent(null)
          setReceipt(null)
          setReceiptDeferred(false)
          setError(null)
          return
        }
        if (requestedTab === 'receipt') {
          const parsed = parseReceiptText(res.data.content ?? '')
          setReceipt(parsed.receipt)
          setReceiptDeferred(parsed.deferred)
          setContent(null)
          setError(parsed.error)
        } else {
          setContent(res.data.content)
          setReceipt(null)
          setReceiptDeferred(false)
          setError(null)
        }
      } catch (err) {
        if (seq !== loadSeqRef.current) return
        setContent(null)
        setReceipt(null)
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
      setReceiptDeferred(true)
    }
  }, [running, invokeId, receipt])

  // Poll while the panel is visible — mid-run edits and idle post-write refresh.
  useEffect(() => {
    if (!active || !workspacePath || !runId) return
    const id = window.setInterval(() => {
      void load({ quiet: true })
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [active, workspacePath, runId, load])

  const emptyTitle =
    tab === 'plan'
      ? 'No plan yet'
      : tab === 'contract'
        ? 'No contract yet'
        : receiptDeferred
          ? 'Receipt updating'
          : 'No receipt yet'
  const emptyBody =
    tab === 'plan'
      ? 'Publish plan.md with create_plan — Goal, Steps, and Done when. Done when is copied into the contract.'
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
        // Every run seeds a plan.md stub now that Plan mode is merged in, so
        // `content` is non-empty from step 0 — readiness, not length, decides.
        // Steps alone are not a plan: the record shows them.
        : !isPlanDraftReady(content))

  const doc = useMemo(() => (tab === 'plan' && content?.trim() ? planDocument(content) : null), [tab, content])
  const live = { steps: hasTodos, checks: checks.length > 0 }
  const sections = doc ? doc.sections.filter((section) => !recordShows(section.heading, live)) : []
  const heading = tab === 'plan' ? (doc?.title ?? 'Plan') : VIEW_TITLE[tab]
  const openName = tab === 'receipt' ? null : VIEW_FILE[tab]
  const canOpen = Boolean(openName && content?.trim() && workspacePath && runId && window.vyotiq?.openRunArtifact)

  const openArtifact = useCallback(async () => {
    if (!workspacePath || !runId || tab === 'receipt') return
    setOpenError(null)
    const res = await window.vyotiq.openRunArtifact?.({ workspacePath, runId, name: VIEW_FILE[tab] as 'plan.md' | 'contract.md' })
    if (res && !res.ok) setOpenError(res.error)
  }, [runId, tab, workspacePath])


  const select = (next: ArtifactView): void => {
    setOpenError(null)
    setTab(next)
  }

  return (
    <div
      className={cn(CHAT_RIGHT_PANEL_BODY, className)}
      data-plan-panel
      role="region"
      aria-label={`${VIEW_TITLE[tab]} panel`}
    >
      <div
        ref={scrollRootRef}
        className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-5 py-4"
        data-plan-doc={tab === 'plan' ? '' : undefined}
      >
        <div className="flex items-start gap-2">
          {tab !== 'plan' ? (
            <IconButton icon="arrowLeft" label="Back to the plan" size="sm" tone="muted" onClick={() => select('plan')} />
          ) : null}
          <h2 className="min-w-0 flex-1 text-heading font-semibold tracking-[var(--vy-tracking-tight)] text-fg-strong">
            {heading}
          </h2>
          {canOpen && openName ? (
            <IconButton
              icon="external"
              label={`Open ${openName}`}
              size="sm"
              tone="muted"
              onClick={() => void openArtifact()}
            />
          ) : null}
          <ActionMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            placement="down"
            align="end"
            aria-label="Run documents"
            items={(['plan', 'contract', 'receipt'] as const).map((id) => ({
              id,
              label: `${VIEW_TITLE[id]} · ${VIEW_FILE[id]}`,
              checked: tab === id,
              onSelect: () => select(id)
            }))}
            trigger={(t) => (
              <IconButton
                ref={t.ref}
                icon="more"
                label="More — contract, receipt"
                size="sm"
                tone="muted"
                aria-expanded={t['aria-expanded']}
                aria-controls={t['aria-controls']}
                aria-haspopup={t['aria-haspopup']}
                onClick={t.onClick}
              />
            )}
          />
        </div>
        {openError ? (
          <p role="alert" className="m-0 mt-2 text-xs text-danger">
            {openError}
          </p>
        ) : null}
        {loading ? (
          <p className="m-0 mt-4 text-xs text-muted">Loading…</p>
        ) : error ? (
          <p className="m-0 mt-4 text-xs text-danger">{error}</p>
        ) : showEmpty ? (
          <EmptyPanel icon={tab === 'receipt' ? 'receipt' : 'plan'} title={emptyTitle} body={emptyBody} centered />
        ) : tab === 'receipt' && receipt ? (
          <ReceiptSummary receipt={receipt} onOpenFile={onOpenFile} />
        ) : doc ? (
          <>
            {doc.lead ? (
              <div className="mt-3">
                <MarkdownContent content={doc.lead} readOnlyTasks wrapTables tone="secondary" />
              </div>
            ) : null}
            {sections.map((section, index) => (
              <section key={`${index}:${section.heading}`} className="mt-5">
                <h3 className={SECTION_LABEL}>{section.heading}</h3>
                {section.body ? (
                  <div className="mt-2">
                    <MarkdownContent content={section.body} readOnlyTasks wrapTables tone="secondary" />
                  </div>
                ) : null}
              </section>
            ))}
          </>
        ) : (
          <div className="mt-3">
            <MarkdownContent content={content ?? ''} readOnlyTasks wrapTables tone="secondary" />
          </div>
        )}
      </div>
    </div>
  )
})
