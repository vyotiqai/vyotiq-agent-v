import { createContext, memo, useContext, useEffect, useState, type ReactNode } from 'react'
import type { UiItem } from '@shared/transcript'
import type { ToolApprovalGrant } from '@shared/ipc'
import { isRetryableTurnFailure } from '@shared/errors'
import { inferFileWriteAction, parseArgsRecord, summarizeToolArgs } from '@shared/toolSummary'
import { parseTerminalOutput } from '@shared/utils/terminalFormat'
import { formatElapsed } from '@shared/utils/timeFormat'
import { mockServiceInstruction } from '@shared/utils/unreachableService'
import {
  formatAgentInstanceShortId,
  parseAgentInstanceRunId,
  parseAgentInstanceRunIdFromArgs,
  type AgentInstanceUiState
} from '@shared/utils/agentInstance'
import { Icon } from '@renderer/lib/icons'
import { AgentVSpinner } from '@renderer/lib/brand/AgentVSpinner'
import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { Button, DiffStat, IconButton, MarkdownContent, STATE_LABEL, StatusGlyph, cn, type TaskState } from '@renderer/lib/ui'
import { BORDER_DIVIDER, ROW_HOVER } from '@renderer/lib/utils/layout'
import { useRunSession } from '@renderer/features/chat/RunSessionContext'
import { ToolRowOutput } from '@renderer/features/chat/components/ToolRow'
import { useFullToolContent } from '@renderer/features/chat/components/useFullToolContent'
import { CompactSummaryBlock } from '@renderer/features/chat/components/CompactSummaryBlock'
import { mapToolGroupProps } from '@renderer/features/chat/utils/toolGroupAdapter'
import { approvalRefusalOf, isInterruptedToolContent, toolLabel } from '@renderer/features/chat/toolUi'
import { ToolFileBadge } from '@renderer/features/chat/toolUi/chrome'
import { parseEditCardData } from '@renderer/features/chat/toolUi/parsers/edit'
import { parseStatusMessageData } from '@renderer/features/chat/toolUi/parsers/status'
import { toolImagesOf } from '@renderer/features/chat/toolUi/parsers/browser'
import { ToolImageStrip } from '@renderer/features/chat/toolUi/ToolImageStrip'
import { editStatOf } from '../editStat'
import { RecordOpenContext, thoughtOpenKey } from '../recordFind'
import type { WorkItem } from '../recordModel'
import { RecordProse } from './RecordProse'

type ToolItem = Extract<UiItem, { kind: 'tool' }>

/** Actions the record needs that the run session does not carry. */
export type RecordActions = {
  onOpenChanges?: (path?: string) => void
  onLoadToolContent?: (toolCallId: string) => Promise<string | null>
  mcpServerNames?: ReadonlyMap<string, string>
  /**
   * The one error row that offers Retry: the latest turn's, once the run has
   * stopped. Retry continues the run from that turn, so older rows are history.
   */
  retryableErrorId?: string | null
  onRetry?: () => void
  /**
   * What the latest failed turn could not reach ("Redis", "the service on
   * :8081"), read from its error and failed commands; the row that offers
   * Retry offers to mock it too.
   */
  mockTarget?: string | null
  /** Send an instruction to the task, as the line would. */
  onFollowUp?: (instruction: string) => void
  /** Hide one error row for good (kept with the run's reader state). */
  onDismissRunError?: (itemId: string) => void
}

/**
 * The id of the error that ended the latest turn, when nothing has been sent
 * since and the run has stopped; otherwise null.
 */
export function latestRetryableErrorId(items: readonly UiItem[], live: boolean): string | null {
  if (live) return null
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!
    if (item.kind === 'run_error') return item.id
    if (item.kind === 'message' && item.role === 'user') return null
  }
  return null
}

export const RecordActionsContext = createContext<RecordActions>({})

/** Measured duration of a call, or null when it has not finished. */
export function toolDurationMs(item: ToolItem): number | null {
  if (!item.at || !item.endedAt) return null
  const ms = Date.parse(item.endedAt) - Date.parse(item.at)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

function spanMs(tools: readonly ToolItem[]): number | null {
  let start: number | null = null
  let end: number | null = null
  for (const t of tools) {
    if (!t.at || !t.endedAt) return null
    const s = Date.parse(t.at)
    const e = Date.parse(t.endedAt)
    if (!Number.isFinite(s) || !Number.isFinite(e)) return null
    start = start == null ? s : Math.min(start, s)
    end = end == null ? e : Math.max(end, e)
  }
  return start != null && end != null ? end - start : null
}

function Duration({ ms, className }: { ms: number | null; className?: string }) {
  if (ms == null) return null
  return <span className={cn('shrink-0 font-mono text-caption text-tertiary tnum', className)}>{formatElapsed(ms)}</span>
}

function Chevron({ open }: { open: boolean }) {
  return (
    <Icon
      name={open ? 'chevron' : 'chevronRight'}
      size={11}
      className={cn('shrink-0 text-tertiary', open ? '' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100')}
    />
  )
}

/**
 * One line of work: verb, detail, trailing facts. No icon in front — the verb
 * says what kind of work it was, and every line starts on the column's edge.
 */
function WorkLine({
  verb,
  detail,
  trailing,
  tone,
  onToggle,
  open
}: {
  verb: ReactNode
  detail?: ReactNode
  trailing?: ReactNode
  tone?: 'danger' | 'accent'
  onToggle?: () => void
  open?: boolean
}) {
  const body = (
    <>
      <span className={cn('shrink-0 font-medium', tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent' : 'text-fg')}>
        {verb}
      </span>
      {detail ? <span className="min-w-0 truncate text-muted">{detail}</span> : null}
      <span className="flex-1" />
      {trailing}
      {/* The chevron's slot is kept on every line, so trailing facts share one right edge. */}
      {onToggle ? <Chevron open={Boolean(open)} /> : <span aria-hidden className="w-[11px] shrink-0" />}
    </>
  )
  if (!onToggle) return <div className="group flex min-h-6 items-center gap-2 text-xs">{body}</div>
  return (
    <button
      type="button"
      aria-expanded={Boolean(open)}
      onClick={onToggle}
      className="group flex min-h-6 w-full items-center gap-2 rounded-sm text-left text-xs focus-visible:vy-focus-ring"
    >
      {body}
    </button>
  )
}

function isSpawn(w: WorkItem): w is Extract<WorkItem, { kind: 'instance' }> {
  return w.kind === 'instance' && w.tool.tool.name === 'spawn_agent_instance'
}

/** Rows of a work list: one per item, except spawns made together, which are one block. */
export function groupWork(items: readonly WorkItem[]): (WorkItem | { kind: 'instances'; spawns: ToolItem[] })[] {
  const out: (WorkItem | { kind: 'instances'; spawns: ToolItem[] })[] = []
  for (let i = 0; i < items.length; ) {
    let j = i
    while (j < items.length && isSpawn(items[j]!)) j += 1
    if (j - i >= 2) {
      out.push({ kind: 'instances', spawns: items.slice(i, j).map((w) => (w as Extract<WorkItem, { kind: 'instance' }>).tool) })
      i = j
    } else {
      out.push(items[i]!)
      i += 1
    }
  }
  return out
}

export function WorkList({ items }: { items: readonly WorkItem[] }) {
  // A provider that reuses call ids across steps can give two rows one id; a
  // repeated key would make React drop or merge one of them.
  const seen = new Map<string, number>()
  const keyOf = (id: string): string => {
    const count = seen.get(id) ?? 0
    seen.set(id, count + 1)
    return count === 0 ? id : `${id}#${count}`
  }
  return (
    <div className="space-y-2">
      {groupWork(items).map((w) =>
        w.kind === 'instances' ? (
          <InstancesBlock key={keyOf(`instances:${rowKeyOf(w.spawns[0]!)}`)} spawns={w.spawns} />
        ) : (
          <WorkItemView key={keyOf(w.id)} item={w} />
        )
      )}
    </div>
  )
}

function rowKeyOf(item: ToolItem): string {
  return item.key ?? item.id
}

/** From this many rows, a settled run's work outside any step folds to one line. */
export const FOLD_LOOSE_AT = 4

export function counted(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`
}

export type WorkCounts = {
  lookups: number
  commands: number
  edits: number
  instances: number
  calls: number
  notes: number
}

/** How much of each kind of work a list holds. */
export function workCounts(items: readonly WorkItem[]): WorkCounts {
  const c: WorkCounts = { lookups: 0, commands: 0, edits: 0, instances: 0, calls: 0, notes: 0 }
  for (const w of items) {
    switch (w.kind) {
      case 'explore':
        c.lookups += w.tools.length
        break
      case 'card':
        if (w.tool.tool.name === 'terminal') c.commands += 1
        else c.edits += 1
        break
      case 'instance':
        if (w.tool.tool.name === 'spawn_agent_instance') c.instances += 1
        break
      case 'tool':
      case 'plan':
        c.calls += 1
        break
      case 'note':
        c.notes += 1
        break
      default:
        break
    }
  }
  return c
}

/** What a list of work amounts to, by kind: "12 lookups · 3 commands · 2 edits". */
export function workSummary(items: readonly WorkItem[]): string {
  const { lookups, commands, edits, instances, calls, notes } = workCounts(items)
  const parts = [
    lookups > 0 ? counted(lookups, 'lookup') : '',
    commands > 0 ? counted(commands, 'command') : '',
    edits > 0 ? counted(edits, 'edit') : '',
    instances > 0 ? counted(instances, 'instance') : '',
    calls > 0 ? counted(calls, 'call') : ''
  ].filter(Boolean)
  if (parts.length === 0 && notes > 0) parts.push(counted(notes, 'note'))
  return parts.join(' · ')
}

/**
 * Work outside any step. Once the run has settled with an answer, a longer
 * list folds to one line saying what it amounts to — the way a finished step
 * does — so the result is a few rows under the brief, not under all of it.
 * While the run is live, or when it ended without an answer (stopped, failed),
 * every row shows: the work is then all there is to read. An error stays in
 * view under the line: it may be the one that offers Retry.
 */
export function LooseWork({ items, fold, openKey }: { items: readonly WorkItem[]; fold: boolean; openKey: string }) {
  const [userOpen, setOpen] = useState(false)
  // Find in record opens a fold that holds a match.
  const forced = useContext(RecordOpenContext).has(openKey)
  if (!fold || items.length < FOLD_LOOSE_AT) return <WorkList items={items} />
  const open = userOpen || forced
  const errors = items.filter((w) => w.kind === 'error')
  const tools = items.flatMap((w) =>
    w.kind === 'explore' ? w.tools : w.kind === 'card' || w.kind === 'instance' || w.kind === 'tool' || w.kind === 'plan' ? [w.tool] : []
  )
  const summary = workSummary(items) || counted(items.length, 'item')
  const spanned = tools.length > 0 ? spanMs(tools) : null
  return (
    <div data-loose-work>
      <div className="-mx-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={cn(
            'group flex min-h-8 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm vy-transition focus-visible:vy-focus-ring',
            ROW_HOVER
          )}
        >
          <span className="min-w-0 flex-1 truncate text-secondary">{summary}</span>
          {errors.length > 0 ? <span className="shrink-0 text-xs text-danger">{counted(errors.length, 'error')}</span> : null}
          <span className="w-14 shrink-0 text-right font-mono text-caption text-tertiary tnum">
            {spanned != null && spanned >= 1000 ? formatElapsed(spanned) : ''}
          </span>
          <Icon
            name={open ? 'chevron' : 'chevronRight'}
            size={12}
            className={cn('shrink-0 text-tertiary', !open && 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100')}
          />
        </button>
      </div>
      {open ? (
        <div className="pb-1 pt-2">
          <WorkList items={items} />
        </div>
      ) : errors.length > 0 ? (
        <div className="pt-2">
          <WorkList items={errors} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * Same work, same transcript items: the model is rebuilt on every streamed
 * token, but the items under an unchanged row keep their identity, so the row
 * need not render again. Only the row that is streaming does.
 */
export function sameWork(a: WorkItem, b: WorkItem): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false
  switch (a.kind) {
    case 'explore': {
      const other = (b as typeof a).tools
      return a.tools.length === other.length && a.tools.every((t, i) => t === other[i])
    }
    case 'card':
    case 'instance':
    case 'tool':
      return a.tool === (b as typeof a).tool
    case 'plan':
      return a.tool === (b as typeof a).tool && a.title === (b as typeof a).title
    case 'note':
      return a.item === (b as typeof a).item && a.text === (b as typeof a).text
    case 'thought': {
      const o = b as typeof a
      return a.item === o.item && a.text === o.text && a.streaming === o.streaming
    }
    case 'error':
      return a.message === (b as typeof a).message && a.code === (b as typeof a).code
    case 'compaction':
      return a.item === (b as typeof a).item
    default: {
      const _exhaustive: never = a
      return _exhaustive
    }
  }
}

export const WorkItemView = memo(WorkItemViewImpl, (prev, next) => sameWork(prev.item, next.item))

/**
 * A turn's failure, with Retry on the latest one and a way to put it away.
 * When that one could not reach something it needed, it also offers to have
 * the task mock it — quieter than Retry, beside it.
 */
function ErrorItem({ id, message, code }: { id: string; message: string; code?: string | undefined }) {
  const { retryableErrorId, onRetry, mockTarget, onFollowUp, onDismissRunError } = useContext(RecordActionsContext)
  const latest = id === retryableErrorId
  const canRetry = Boolean(onRetry) && latest && isRetryableTurnFailure({ errorCode: code })
  const mock = latest && mockTarget && onFollowUp ? mockTarget : null
  return (
    // Wraps when the pane is narrow: the actions then keep the right edge.
    <div role="alert" className="flex flex-wrap items-start gap-x-2 gap-y-1 text-xs text-danger">
      <Icon name="xCircle" size={14} className="mt-px shrink-0" />
      <p className="min-w-0 grow basis-48 [overflow-wrap:anywhere]">{message}</p>
      {code ? <code className="shrink-0 font-mono text-caption text-tertiary">{code}</code> : null}
      {canRetry || mock || onDismissRunError ? (
        <div className="-my-1 ml-auto flex shrink-0 items-center gap-1">
          {canRetry ? (
            <Button size="xs" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
          {mock ? (
            <Button size="xs" variant="ghost" onClick={() => onFollowUp!(mockServiceInstruction(mock))}>
              Ask it to mock {mock}
            </Button>
          ) : null}
          {onDismissRunError ? (
            <IconButton icon="close" label="Dismiss error" size="xs" tone="muted" onClick={() => onDismissRunError(id)} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function WorkItemViewImpl({ item }: { item: WorkItem }) {
  switch (item.kind) {
    case 'explore':
      return <ExploreItem tools={item.tools} />
    case 'card':
      return (
        <WithApproval id={item.tool.id} grant={item.tool.tool.approvedBy}>
          {item.tool.tool.name === 'terminal' ? <TerminalCard item={item.tool} /> : <EditCard item={item.tool} />}
        </WithApproval>
      )
    case 'instance':
      return <InstanceItem item={item.tool} />
    case 'tool':
      return (
        <WithApproval id={item.tool.id} grant={item.tool.tool.approvedBy}>
          <ToolLine item={item.tool} />
        </WithApproval>
      )
    case 'plan':
      return <PlanItem title={item.title} running={item.tool.tool.status === 'running'} />
    case 'note':
      return <RecordProse text={item.text} streaming={Boolean(item.item.streaming)} tone="secondary" />
    case 'thought':
      return item.streaming ? <NowLine text={item.text} since={item.item.at} /> : <Thought id={item.id} text={item.text} />
    case 'error':
      return <ErrorItem id={item.id} message={item.message} code={item.code} />
    case 'compaction':
      return (
        <CompactSummaryBlock
          summary={item.item.summary}
          tokenEstimate={item.item.tokenEstimate}
          expanded={item.item.expanded}
          verifyStatus={item.item.verifyStatus}
          verifyFailures={item.item.verifyFailures}
          verifyCoverage={item.item.verifyCoverage}
        />
      )
  }
}

/** Lookups whose failure is said by the error's first line, not by their body. */
const ERROR_LINE_LOOKUPS: ReadonlySet<string> = new Set([
  'search',
  'glob',
  'grep',
  'codebase_search',
  'concept_search',
  'web_search'
])

function ExploreItem({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(false)
  const { onOpenWorkspaceFile } = useRunSession()
  const { onLoadToolContent, mcpServerNames } = useContext(RecordActionsContext)
  const group = mapToolGroupProps(tools.map((t) => t.tool))
  const running = group.state === 'pending'
  // A lookup stopped with the run did not fail: it is not counted as one.
  const broke = (t: ToolItem): boolean => t.tool.status === 'fail' && !isInterruptedToolContent(t.tool.content)
  const failed = tools.filter(broke).length
  // Screenshots stay in view with the line closed: seeing the page is the point.
  const images = tools.flatMap((t) => toolImagesOf(t.tool))
  return (
    <div>
      <WorkLine
        verb={running ? group.runningLabel : group.doneLabel}
        detail={group.summary}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        trailing={
          <>
            {failed > 0 ? <span className="text-caption text-danger">{failed} failed</span> : null}
            {running ? <AgentVSpinner size={11} /> : <Duration ms={spanMs(tools)} />}
          </>
        }
      />
      {images.length > 0 ? <ToolImageStrip images={images} className="mt-1" /> : null}
      {open ? (
        <ul className="mt-1 space-y-px border-l border-border pl-3">
          {group.nestedTools.map((nested, i) => {
            const t = tools[i]!
            const fail = broke(t)
            const label = nested.title || nested.subtitle || toolLabel(t.tool.name, t.tool.status, t.tool.content)
            return (
              <li key={nested.id}>
                <div className="flex h-6 items-center gap-2 text-xs">
                  {fail ? (
                    // Which one failed is said by its shape, not only its colour.
                    <Icon name="warningCircle" size={13} className="shrink-0 text-danger" aria-label="Failed" />
                  ) : nested.filePath ? (
                    <FileTypeIcon path={nested.filePath} size={13} />
                  ) : (
                    // A search or a listing has no file type to show: its slot
                    // is kept so every label in the list starts on one edge.
                    <span aria-hidden className="w-[13px] shrink-0" />
                  )}
                  {nested.filePath && onOpenWorkspaceFile ? (
                    <button
                      type="button"
                      onClick={() => onOpenWorkspaceFile(nested.filePath!, nested.fileLine ? { line: nested.fileLine } : undefined)}
                      className={cn(
                        'min-w-0 truncate text-left font-mono text-caption hover:text-fg-strong hover:underline focus-visible:vy-focus-ring',
                        fail ? 'text-danger' : 'text-secondary'
                      )}
                      title={nested.filePath}
                    >
                      {label}
                    </button>
                  ) : (
                    <span className={cn('min-w-0 truncate font-mono text-caption', fail ? 'text-danger' : 'text-secondary')}>{label}</span>
                  )}
                  <span className="flex-1" />
                  <Duration ms={toolDurationMs(t)} />
                </div>
                {fail && t.tool.content ? (
                  ERROR_LINE_LOOKUPS.has(t.tool.name) ? (
                    // These bodies have no error branch: they would read "No
                    // matches" and hide why the call failed.
                    <p className="m-0 line-clamp-2 pl-[21px] text-caption text-danger [overflow-wrap:anywhere]">
                      {t.tool.content.trim().split('\n').find((l) => l.trim()) ?? ''}
                    </p>
                  ) : (
                    <ToolRowOutput
                      tool={t.tool}
                      toolProgress={t.toolProgress}
                      onLoadFullContent={onLoadToolContent}
                      mcpServerNames={mcpServerNames}
                      inGroup
                      indent={false}
                    />
                  )
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

/** A call held for your approval says so; it has not started, so nothing spins. */
function AwaitingApproval() {
  return <span className="shrink-0 text-caption font-medium text-accent">Waiting for approval</span>
}

/** Who let a held call run, and for how long: "Allowed by you · always for this task". */
export function approvedByText(grant: ToolApprovalGrant): { lead: string; allow?: string; tail?: string } {
  if (grant.by === 'rule') {
    return { lead: grant.scope === 'task' ? 'Allowed by a rule for this task' : 'Allowed by a rule for this workspace' }
  }
  if (grant.scope === 'task') return { lead: 'Allowed by you · always for this task' }
  if (grant.scope === 'workspace') {
    return grant.allow
      ? { lead: 'Allowed by you · always for ', allow: grant.allow, tail: ' in this workspace' }
      : { lead: 'Allowed by you · always in this workspace' }
  }
  return { lead: 'Allowed by you' }
}

/**
 * The decision above the call it let through — muted, since the call is what
 * you read; it answers "why did this run without asking?" once asked.
 */
function ApprovedLine({ grant }: { grant: ToolApprovalGrant }) {
  const { lead, allow, tail } = approvedByText(grant)
  return (
    <p className="m-0 mb-1 flex min-w-0 items-center gap-1.5 text-caption text-tertiary" data-record-approved={`${grant.by}:${grant.scope}`}>
      <Icon name="check" size={12} className="shrink-0" />
      <span className="min-w-0 truncate">
        {lead}
        {allow ? <span className="font-mono">{allow}</span> : null}
        {tail}
      </span>
    </p>
  )
}

/**
 * The one call per run whose rule grant is said: after "Always allow edit",
 * every later edit would otherwise repeat "Allowed by a rule". Undefined outside
 * a run (every grant is said); null in a run no rule let anything through.
 */
export const FirstRuleGrantContext = createContext<string | null | undefined>(undefined)

/**
 * A call's row, with the decision that let it run above it when there was one.
 * Always the same wrapper, so the row under it is not remounted when the
 * decision lands.
 */
function WithApproval({ id, grant, children }: { id: string; grant: ToolApprovalGrant | undefined; children: ReactNode }) {
  const firstRuleGrant = useContext(FirstRuleGrantContext)
  const said = grant && (grant.by !== 'rule' || firstRuleGrant === undefined || firstRuleGrant === id)
  return (
    <div>
      {said ? <ApprovedLine grant={grant} /> : null}
      {children}
    </div>
  )
}

function TerminalCard({ item }: { item: ToolItem }) {
  const { onLoadToolContent, mcpServerNames } = useContext(RecordActionsContext)
  const { onOpenAgentTerminal } = useRunSession()
  const args = parseArgsRecord(item.tool.argsPreview)
  const command =
    (typeof args?.command === 'string' && args.command) || (typeof args?.cmd === 'string' && args.cmd) || item.tool.summary
  const parsed = item.tool.content ? parseTerminalOutput(item.tool.content) : null
  const awaiting = Boolean(item.approval) && item.tool.status === 'running'
  const running = !awaiting && (item.tool.status === 'running' || parsed?.sessionStatus === 'running')
  const exit = parsed?.exitCode ?? null
  const refused = item.tool.status === 'fail' ? approvalRefusalOf(item.tool.content) : null
  // Stopped with the run, not broken: no exit code to report and no failure colour.
  const stopped = !running && !awaiting && isInterruptedToolContent(item.tool.content)
  const failed = !refused && !stopped && (item.tool.status === 'fail' || (exit != null && exit !== 0 && exit !== -1))
  const hasOutput = Boolean(item.tool.content?.trim()) || (item.toolProgress?.length ?? 0) > 0
  // A running command opens once it has output to show — never onto an empty
  // box — and stays open when it finishes, unless you close it.
  const autoOpen = running && hasOutput
  const [open, setOpen] = useState(autoOpen)
  useEffect(() => {
    if (autoOpen) setOpen(true)
  }, [autoOpen])
  return (
    <div className="overflow-hidden rounded-lg border border-border" data-record-command>
      <div className="flex items-center bg-bg">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'group flex h-8 min-w-0 flex-1 items-center gap-2 text-left text-xs focus-visible:vy-focus-ring',
            running && onOpenAgentTerminal ? 'pl-3 pr-1' : 'px-3'
          )}
        >
          <code className="min-w-0 flex-1 truncate font-mono text-caption text-fg">
            <span className="text-tertiary">$ </span>
            {command}
          </code>
          {awaiting ? (
            <AwaitingApproval />
          ) : running ? (
            // The words carry the motion; the time counts up where the final one lands.
            <span className="shrink-0 text-caption vy-text-live">Running</span>
          ) : refused ? (
            // It never ran: there is no exit code to report.
            <span className="shrink-0 text-caption text-muted">{refused}</span>
          ) : stopped ? (
            <span className="shrink-0 text-caption text-tertiary">{item.tool.content}</span>
          ) : failed ? (
            // Word and colour: the exit code says it failed without the red.
            <span className="shrink-0 font-mono text-caption text-danger">exit {exit ?? '?'}</span>
          ) : exit != null ? (
            <span className="shrink-0 font-mono text-caption text-tertiary">exit {exit}</span>
          ) : null}
          {running ? (
            <ElapsedSince since={item.at} className="w-12 text-right" />
          ) : (
            <Duration ms={toolDurationMs(item)} className="w-12 text-right" />
          )}
          <Chevron open={open} />
        </button>
        {running && onOpenAgentTerminal ? (
          // Only while it runs: the mirror lives as long as the app does, and a
          // finished command's output is already in the card.
          <IconButton icon="expand" label="Open in Terminal" size="xs" tone="muted" onClick={onOpenAgentTerminal} className="mr-2" />
        ) : null}
      </div>
      {open ? (
        <div className="border-t border-border bg-sunken px-1 pt-1">
          <ToolRowOutput
            tool={item.tool}
            toolProgress={item.toolProgress}
            onLoadFullContent={onLoadToolContent}
            mcpServerNames={mcpServerNames}
            indent={false}
          />
        </div>
      ) : null}
    </div>
  )
}

function EditCard({ item }: { item: ToolItem }) {
  // Open while the edit streams, so its lines show as they arrive.
  const [open, setOpen] = useState(item.tool.status === 'running')
  const { onOpenChanges, onLoadToolContent, mcpServerNames } = useContext(RecordActionsContext)
  const stat = editStatOf(item.tool)
  const edit = parseEditCardData(item.tool)
  const path = stat?.path ?? (edit.path || item.tool.summary)
  const created = inferFileWriteAction(item.tool.name, item.tool.content) === 'created'
  const refused = item.tool.status === 'fail' ? approvalRefusalOf(item.tool.content) : null
  const failed = item.tool.status === 'fail' && !refused
  const running = item.tool.status === 'running'
  return (
    <div className="overflow-hidden rounded-lg border border-border" data-record-edit>
      <div className="flex h-8 items-center gap-2 bg-bg px-3 text-xs">
        {/* The file icon opens the file at its first changed line — its own
            control, never nested in the disclosure button. */}
        <ToolFileBadge filePath={edit.iconPath ?? path} fileLine={edit.changedLine ?? undefined} size={14} />
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${toolLabel(item.tool.name, item.tool.status, item.tool.content)}: ${path}`}
          onClick={() => setOpen((v) => !v)}
          className="group flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:vy-focus-ring"
        >
          <span className={cn('min-w-0 truncate font-mono text-caption', failed ? 'text-danger' : 'text-fg')} title={path}>
            {path}
          </span>
          {created ? <span className="shrink-0 text-caption text-success">new</span> : null}
          {failed ? <span className="shrink-0 text-caption text-danger">failed</span> : null}
          {refused ? <span className="shrink-0 text-caption text-muted">{refused}</span> : null}
          <span className="flex-1" />
          {running && item.approval ? (
            <AwaitingApproval />
          ) : running ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-caption text-tertiary">
              <AgentVSpinner size={10} />
              Editing
            </span>
          ) : stat?.exact && !failed && !refused ? (
            // Only an edit that landed has lines to count.
            <DiffStat add={stat.add} del={stat.del} />
          ) : null}
          <Chevron open={open} />
        </button>
        {onOpenChanges && !failed && !refused ? (
          <IconButton icon="external" label="Open in Changes" size="xs" tone="muted" onClick={() => onOpenChanges(path)} />
        ) : null}
      </div>
      {open ? (
        <div className="border-t border-border px-1 pt-1">
          <ToolRowOutput
            tool={item.tool}
            toolProgress={item.toolProgress}
            onLoadFullContent={onLoadToolContent}
            mcpServerNames={mcpServerNames}
            indent={false}
          />
        </div>
      ) : null}
    </div>
  )
}

/**
 * A call that is neither a lookup nor a card: a delete, an MCP call, a
 * question, an unknown tool. One line — verb, target, status — and, when it
 * failed, the reason under it without having to open it.
 */
function ToolLine({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false)
  const { onLoadToolContent, mcpServerNames } = useContext(RecordActionsContext)
  const tool = item.tool
  const running = tool.status === 'running'
  // Stopped with the run, not broken: it keeps its own verb and says how it
  // ended once, without the failure colour or a reason line repeating it.
  const stopped = !running && isInterruptedToolContent(tool.content)
  // Denied or timed out at approval: a decision, said once, muted.
  const refused = tool.status === 'fail' ? approvalRefusalOf(tool.content) : null
  const failed = tool.status === 'fail' && !stopped && !refused
  // Neither a stopped nor a refused call ran: each keeps the verb it would have had.
  const verb = toolLabel(tool.name, refused ? 'running' : tool.status, tool.content)
  // A stopped or refused call's summary is only why; what it was doing is in its args.
  const summary = stopped || refused ? summarizeToolArgs(tool.name, tool.argsPreview) : tool.summary
  const target = summary?.trim() && summary.trim() !== tool.name ? summary.trim() : ''
  const status = tool.name === 'ask_question' || tool.name === 'switch_mode' ? parseStatusMessageData(tool) : null
  // An answered question says what you answered, under it; "Answered" alone
  // would make you open it to find out.
  const answers = !stopped && !refused && tool.name === 'ask_question' ? (status?.answers ?? []) : []
  // Questions and mode switches settle with a word of their own.
  const chip = stopped ? tool.content! : refused ? refused : answers.length > 0 ? null : (status?.chip ?? null)
  const reason = failed ? (tool.content ?? '').trim().split('\n').find((l) => l.trim()) ?? '' : ''
  const images = toolImagesOf(tool)
  return (
    <div data-record-tool={tool.name}>
      <WorkLine
        verb={verb}
        detail={target || undefined}
        tone={failed ? 'danger' : undefined}
        open={open}
        // The answer under it is all its body would show.
        onToggle={tool.content && answers.length === 0 ? () => setOpen((v) => !v) : undefined}
        trailing={
          <>
            {chip && chip !== verb ? (
              <span className={cn('shrink-0 text-caption', failed ? 'text-danger' : 'text-tertiary')}>{chip}</span>
            ) : null}
            {running && item.approval ? (
              <AwaitingApproval />
            ) : running ? (
              <AgentVSpinner size={11} />
            ) : (
              <Duration ms={toolDurationMs(item)} />
            )}
          </>
        }
      />
      {reason && !open ? <p className="m-0 mt-0.5 line-clamp-2 text-caption text-danger">{reason}</p> : null}
      {answers.length > 0 ? <YouAnswered answers={answers} /> : null}
      {images.length > 0 ? <ToolImageStrip images={images} className="mt-1" /> : null}
      {open ? (
        <div className="mt-1 border-l border-border pl-3">
          <ToolRowOutput
            tool={tool}
            toolProgress={item.toolProgress}
            onLoadFullContent={onLoadToolContent}
            mcpServerNames={mcpServerNames}
            inGroup
          />
        </div>
      ) : null}
    </div>
  )
}

/**
 * Your answer to a question, under the question: the label quiet, the words
 * yours. A form of several questions lists each answer on its own line.
 */
function YouAnswered({ answers }: { answers: readonly string[] }) {
  return (
    <div className="mt-0.5 text-caption" data-record-answer>
      {answers.length === 1 ? (
        <p className="m-0 whitespace-pre-line [overflow-wrap:anywhere]">
          <span className="text-tertiary">You answered: </span>
          <span className="text-fg">{answers[0]}</span>
        </p>
      ) : (
        <>
          <p className="m-0 text-tertiary">You answered:</p>
          <ul className="m-0 list-none space-y-0.5 p-0">
            {answers.map((answer, i) => (
              <li key={i} className="whitespace-pre-line text-fg [overflow-wrap:anywhere]">
                {answer}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** The protocol line the instance tools prefix their output with. */
function displayInstanceContent(content: string | undefined): string {
  return (content ?? '').replace(/^Agent V Instance id;[^\r\n]*(?:\r?\n)?/i, '').trim()
}

/** An await's report: its output without the protocol, phase and branch lines. */
function instanceReport(content: string | undefined): string {
  return displayInstanceContent(content)
    .replace(/^(?:phase|worktree_branch):[^\r\n]*(?:\r?\n)?/gim, '')
    .trim()
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n').find((l) => l.trim())?.trim() ?? ''
}

/** A report's first line, as a title: its heading marks and emphasis dropped. */
function reportTitle(report: string): string {
  return firstLine(report)
    .replace(/^#+\s*/, '')
    .replace(/[*_`]/g, '')
    .trim()
}

/** A report under its row: its heading is already the row's title. */
function reportBody(report: string): string {
  const lines = report.split('\n')
  const first = lines.findIndex((l) => l.trim())
  return first >= 0 && /^#+\s/.test(lines[first]!.trim()) ? lines.slice(first + 1).join('\n').trim() : report
}

/** Open, for an instance: quiet, since every child has one and the rows are the point. */
function OpenInstance({ runId, shortId }: { runId: string; shortId: string }) {
  const { onOpenAgentInstance } = useRunSession()
  if (!onOpenAgentInstance) return null
  return (
    <button
      type="button"
      aria-label={`Open instance ${shortId}`}
      onClick={(e) => {
        e.stopPropagation()
        onOpenAgentInstance(runId)
      }}
      className="shrink-0 rounded-sm text-caption font-medium text-muted hover:text-fg-strong hover:underline focus-visible:vy-focus-ring"
    >
      Open
    </button>
  )
}

function InstanceItem({ item }: { item: ToolItem }) {
  return item.tool.name === 'spawn_agent_instance' ? <SpawnRow item={item} /> : <InstanceCallRow item={item} />
}

/**
 * The child itself: what it was asked, what it is doing, how long it has run,
 * and the one way into it. Its state is the child's own — a spawn that
 * returned only means it started.
 */
type SpawnFacts = {
  runId: string | null
  shortId: string
  /** What it was asked to deliver. */
  goal: string
  failed: boolean
  phase: AgentInstanceUiState['phase'] | null
  verb: string
  state: TaskState
  startedAt: string | undefined
  /** How long the child ran, once it has settled. */
  ranMs: number | null
  /** Its step and activity while it runs. */
  doing: string
  /** Why it failed, when it did. */
  reason: string
}

/**
 * The child a spawn started, as the record shows it: its state is the child's
 * own — a spawn that returned only means it started.
 */
function spawnFacts(item: ToolItem, agentInstances: Record<string, AgentInstanceUiState> | undefined): SpawnFacts {
  const tool = item.tool
  const runId = parseAgentInstanceRunId(tool.content)
  const instance = runId ? agentInstances?.[runId] : undefined
  const shortId = runId ? formatAgentInstanceShortId(runId) : ''
  const args = parseArgsRecord(tool.argsPreview)
  // The one deliverable reads at a glance; the goal is the child's background
  // and often opens with boilerplate ("Read-only task in this workspace…").
  const goal =
    typeof args?.outcome === 'string' && args.outcome.trim()
      ? args.outcome
      : typeof args?.goal === 'string'
        ? args.goal
        : (instance?.goal ?? '')
  const failed = tool.status === 'fail'
  const phase = tool.status === 'running' ? null : (instance?.phase ?? null)
  const verb =
    tool.status === 'running'
      ? 'Spawning instance'
      : failed
        ? 'Spawn failed'
        : phase === 'started'
          ? `Running instance ${shortId}`
          : phase === 'done'
            ? `Instance finished ${shortId}`
            : phase === 'error'
              ? `Instance failed ${shortId}`
              : phase === 'cancelled'
                ? `Instance cancelled ${shortId}`
                : `Spawned instance ${shortId}`
  const state: TaskState =
    tool.status === 'running' || phase === 'started'
      ? 'running'
      : failed || phase === 'error'
        ? 'failed'
        : phase === 'cancelled'
          ? 'stopped'
          : 'done'
  const ranMs =
    instance?.startedAt && instance.endedAt ? Date.parse(instance.endedAt) - Date.parse(instance.startedAt) : null
  const doing =
    phase === 'started'
      ? [instance?.step ? `Step ${instance.step}` : '', instance?.activity ?? ''].filter(Boolean).join(' · ')
      : ''
  const reason = failed ? firstLine(tool.content) : phase === 'error' ? firstLine(instance?.summary) : ''
  return {
    runId,
    shortId,
    goal,
    failed,
    phase,
    verb,
    state,
    startedAt: instance?.startedAt ?? item.endedAt,
    ranMs: ranMs != null && Number.isFinite(ranMs) && ranMs >= 0 ? ranMs : null,
    doing,
    reason
  }
}

function SpawnRow({ item }: { item: ToolItem }) {
  const { agentInstances } = useRunSession()
  const tool = item.tool
  const { runId, shortId, goal, failed, phase, verb, startedAt, ranMs, doing, reason } = spawnFacts(item, agentInstances)
  return (
    <div data-record-instance={shortId || undefined} data-instance-phase={phase ?? undefined}>
      <WorkLine
        verb={verb}
        tone={failed || phase === 'error' ? 'danger' : undefined}
        detail={goal || undefined}
        trailing={
          <>
            {/* Ahead of the time, so every row's time keeps one right edge. */}
            {runId ? <OpenInstance runId={runId} shortId={shortId} /> : null}
            {tool.status === 'running' || phase === 'started' ? (
              <>
                <AgentVSpinner size={11} />
                {phase === 'started' ? <ElapsedSince since={startedAt} /> : null}
              </>
            ) : (
              <Duration ms={ranMs ?? toolDurationMs(item)} />
            )}
          </>
        }
      />
      {doing ? (
        <p className="m-0 mt-0.5 truncate text-caption text-tertiary" aria-live="polite">
          {doing}
        </p>
      ) : null}
      {reason ? <p className="m-0 mt-0.5 line-clamp-2 text-caption text-danger">{reason}</p> : null}
    </div>
  )
}

/**
 * Several children started together: one block, a row each, instead of a row
 * of spawn lines. The header counts them and how they stand; each row is the
 * child's state, id, what it is doing (or was asked, or why it failed) and
 * its time, and opens it.
 */
function InstancesBlock({ spawns }: { spawns: readonly ToolItem[] }) {
  const { agentInstances, onOpenAgentInstance } = useRunSession()
  const kids = spawns.map((item) => ({ item, facts: spawnFacts(item, agentInstances) }))
  const tally = (['running', 'failed', 'stopped', 'done'] as const)
    .map((state) => ({ state, n: kids.filter((k) => k.facts.state === state).length }))
    .filter((t) => t.n > 0)
    .map((t) => `${t.n} ${STATE_LABEL[t.state].toLowerCase()}`)
  return (
    <div className="overflow-hidden rounded-lg border border-border" data-record-instances={kids.length}>
      <div className={cn('flex h-8 items-center gap-2 border-b bg-bg px-3 text-xs', BORDER_DIVIDER)}>
        <Icon name="crew" size={14} className="shrink-0 text-tertiary" />
        <span className="shrink-0 font-medium text-fg">{counted(kids.length, 'instance')}</span>
        {tally.length > 0 ? <span className="min-w-0 truncate text-tertiary">· {tally.join(' · ')}</span> : null}
      </div>
      <ul className="m-0 list-none p-0">
        {kids.map(({ item, facts }) => {
          const running = facts.state === 'running'
          const detail = facts.reason || facts.doing || facts.goal
          const body = (
            <>
              <StatusGlyph state={facts.state} size={14} />
              <span className="shrink-0 font-mono text-caption text-fg">
                {facts.shortId ? (
                  <>
                    {/* The row is the way in; its name says so. */}
                    {onOpenAgentInstance && facts.runId ? <span className="sr-only">Open instance</span> : null}{' '}
                    {facts.shortId}
                  </>
                ) : (
                  facts.verb
                )}
              </span>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  facts.reason ? 'text-danger' : running && facts.doing ? 'vy-text-live' : 'text-tertiary'
                )}
                title={detail || undefined}
              >
                {/* Failed or stopped says so in words, not only by the glyph. */}
                {facts.state === 'failed' || facts.state === 'stopped' ? (
                  <span className="sr-only">{STATE_LABEL[facts.state]}:</span>
                ) : null}{' '}
                {detail}
              </span>
              {running ? (
                facts.phase === 'started' ? (
                  <ElapsedSince since={facts.startedAt} className="w-12 text-right" />
                ) : null
              ) : (
                <Duration ms={facts.ranMs ?? toolDurationMs(item)} className="w-12 text-right" />
              )}
            </>
          )
          return (
            <li
              key={rowKeyOf(item)}
              className={cn('border-b last:border-b-0', BORDER_DIVIDER)}
              data-record-instance={facts.shortId || undefined}
              data-instance-phase={facts.phase ?? undefined}
            >
              {onOpenAgentInstance && facts.runId ? (
                <button
                  type="button"
                  onClick={() => onOpenAgentInstance(facts.runId!)}
                  // Inset: the block's overflow-hidden would clip an outside outline.
                  className={cn(
                    'group flex h-9 w-full min-w-0 items-center gap-2.5 px-3 text-left text-xs outline-none vy-transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus',
                    ROW_HOVER
                  )}
                >
                  {body}
                  <Icon name="chevronRight" size={11} className="shrink-0 text-tertiary" />
                </button>
              ) : (
                <div className="flex h-9 min-w-0 items-center gap-2.5 px-3 text-xs">
                  {body}
                  <span aria-hidden className="w-[11px] shrink-0" />
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * Await, pull, merge, cancel: the parent's dealings with a child. A settled
 * await carries the child's report — its title on the line, the whole of it
 * on opening.
 */
function InstanceCallRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false)
  const { agentInstances } = useRunSession()
  const tool = item.tool
  const runId = parseAgentInstanceRunId(tool.content) ?? parseAgentInstanceRunIdFromArgs(tool.argsPreview)
  const instance = runId ? agentInstances?.[runId] : undefined
  const shortId = runId ? formatAgentInstanceShortId(runId) : ''
  const running = tool.status === 'running'
  const failed = tool.status === 'fail'
  // A settled await is only the waiter's verdict: it can time out or fail
  // while the child carries on to a terminal phase of its own. The child's
  // status decides the row; the call only explains the wait.
  const phase = instance?.phase
  const finished = failed && phase === 'done'
  const stopped = phase === 'error' || phase === 'cancelled'
  const content = displayInstanceContent(tool.content)
  const report = tool.name === 'await_agent_instance' || tool.name === 'pull_agent_instance' ? instanceReport(tool.content) : ''
  // The spawn row above already says the child finished; a returned await is
  // where its report is.
  const verb = finished
    ? 'Instance finished'
    : stopped && tool.name === 'await_agent_instance'
      ? `Instance ${phase === 'cancelled' ? 'cancelled' : 'failed'}`
      : tool.name === 'await_agent_instance' && tool.status === 'done' && report
        ? 'Report from'
        : toolLabel(tool.name, tool.status, tool.content)
  // Why the call failed, said under the row so it needs no opening: the child's
  // own words once it has settled one way or the other, else the call's output.
  const reason = failed && !finished ? firstLine(stopped ? instance?.summary || content : content) : ''
  const canOpen = !running && !reason && report.length > 0
  // The live preview of a long report is cut: opened, it loads the whole.
  const { onLoadToolContent } = useContext(RecordActionsContext)
  const full = useFullToolContent(tool, open, onLoadToolContent)
  return (
    <div data-record-tool={tool.name}>
      <WorkLine
        verb={runId ? `${verb} ${shortId}` : verb}
        tone={failed && !finished ? 'danger' : undefined}
        detail={canOpen ? reportTitle(report) : undefined}
        open={open}
        onToggle={canOpen ? () => setOpen((v) => !v) : undefined}
        trailing={
          running ? (
            <>
              <AgentVSpinner size={11} />
              <ElapsedSince since={item.at} />
            </>
          ) : (
            <Duration ms={toolDurationMs(item)} />
          )
        }
      />
      {finished ? (
        <p className="m-0 mt-0.5 line-clamp-2 text-caption text-muted">Finished, but the await did not return.</p>
      ) : null}
      {reason ? <p className="m-0 mt-0.5 line-clamp-2 text-caption text-danger">{reason}</p> : null}
      {open ? (
        <div className="mt-1 border-l border-border pl-3" data-instance-report>
          <MarkdownContent content={reportBody(report)} tone="secondary" />
          {full.loading ? <p className="m-0 mt-1 text-caption text-tertiary">Loading the full report…</p> : null}
        </div>
      ) : null}
    </div>
  )
}

function PlanItem({ title, running }: { title: string | null; running: boolean }) {
  const { onOpenPanel } = useRunSession()
  return (
    <WorkLine
      verb={running ? 'Writing the plan' : 'Wrote the plan'}
      detail={title ? <span className="text-fg">{title}</span> : undefined}
      trailing={
        onOpenPanel && !running ? (
          <button
            type="button"
            onClick={() => onOpenPanel('plan')}
            className="shrink-0 text-xs font-medium text-accent hover:underline focus-visible:vy-focus-ring"
          >
            Open plan
          </button>
        ) : null
      }
    />
  )
}

/** Past this many characters a thought's line is cut, at a word, by us. */
const THOUGHT_LINE_MAX = 160

/**
 * The one line a settled thought shows: where it ended up — its last
 * paragraph, or that paragraph's last sentence when it runs long. That is the
 * line the Now line showed while it streamed, and it says more than the first
 * sentence, which mostly restates the request ("The user sent…"). The cut is
 * made here, at a word, with any trailing stop dropped, so a cut never reads
 * "ask.…".
 */
export function thoughtLine(text: string, max = THOUGHT_LINE_MAX): string {
  const paragraphs = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  let line = paragraphs[paragraphs.length - 1] ?? ''
  if (line.length > max) {
    const sentences = line.split(/(?<=[.!?])\s+/).filter(Boolean)
    line = sentences[sentences.length - 1] ?? line
  }
  if (line.length <= max) return line
  const cut = line.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?…—–-]+$/, '')}…`
}

/** Reasoning, settled: one line of where it ended up, the rest on request. */
function Thought({ id, text }: { id: string; text: string }) {
  const [userOpen, setOpen] = useState(false)
  // Find in record opens a thought that holds a match.
  const forced = useContext(RecordOpenContext).has(thoughtOpenKey(id))
  const open = userOpen || forced
  const line = thoughtLine(text)
  return (
    <div data-record-thought>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group flex min-h-6 w-full items-center gap-2 rounded-sm text-left text-xs focus-visible:vy-focus-ring"
      >
        <span className="sr-only">Reasoning: </span>
        <span className="min-w-0 flex-1 truncate italic text-muted">{line}</span>
        <Chevron open={open} />
      </button>
      {open ? <p className="m-0 mt-1 whitespace-pre-wrap border-l border-border pl-3 text-xs italic text-muted">{text}</p> : null}
    </div>
  )
}

/**
 * True while an item is still in flight — its own row already says so (a
 * spinner, streaming words), so no activity line is added beside it.
 */
export function workIsLive(w: WorkItem): boolean {
  switch (w.kind) {
    case 'thought':
      return w.streaming
    case 'note':
      return Boolean(w.item.streaming)
    case 'card':
    case 'instance':
    case 'plan':
    case 'tool':
      return w.tool.tool.status === 'running'
    case 'explore':
      return w.tools.some((t) => t.tool.status === 'running')
    case 'error':
    case 'compaction':
      return false
    default: {
      const _exhaustive: never = w
      return _exhaustive
    }
  }
}

/** What is happening now: the latest reasoning while it streams, or the run's activity. */
export function NowLine({ text, since }: { text: string; since?: string }) {
  const line = text.trim().split('\n').filter(Boolean).pop() ?? ''
  return (
    // The fill bleeds into the gutter so the spinner sits on the edge every
    // other work row (and the settled thought it becomes) starts on.
    <div className="-mx-2 flex h-7 items-center gap-2 rounded-md bg-surface px-2 text-xs" aria-live="polite">
      <AgentVSpinner size={14} className="shrink-0 text-fg" />
      <span className="font-semibold text-fg-strong">Now</span>
      <span className="min-w-0 flex-1 truncate vy-text-live" title={since}>
        {line}
      </span>
      <ElapsedSince since={since} />
    </div>
  )
}

/** How long it has been at it, counting up each second while it shows. */
function ElapsedSince({ since, className }: { since?: string; className?: string }) {
  const [elapsed, setElapsed] = useState<number | null>(null)
  useEffect(() => {
    const start = since ? Date.parse(since) : NaN
    if (!Number.isFinite(start)) {
      setElapsed(null)
      return undefined
    }
    const tick = (): void => setElapsed(Math.max(0, Date.now() - start))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [since])
  return <Duration ms={elapsed} className={className} />
}
