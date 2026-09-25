import { createContext, memo, useContext, useEffect, useState, type ReactNode } from 'react'
import type { UiItem } from '@shared/transcript'
import { isRetryableTurnFailure } from '@shared/errors'
import { inferFileWriteAction, parseArgsRecord } from '@shared/toolSummary'
import { parseTerminalOutput } from '@shared/utils/terminalFormat'
import { formatElapsed } from '@shared/utils/timeFormat'
import { formatAgentInstanceShortId, parseAgentInstanceRunId, parseAgentInstanceRunIdFromArgs } from '@shared/utils/agentInstance'
import { Icon, type IconName } from '@renderer/lib/icons'
import { AgentVSpinner } from '@renderer/lib/brand/AgentVSpinner'
import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { Button, DiffStat, IconButton, MarkdownContent, cn } from '@renderer/lib/ui'
import { useRunSession } from '@renderer/features/chat/RunSessionContext'
import { ToolRowOutput } from '@renderer/features/chat/components/ToolRow'
import { CompactSummaryBlock } from '@renderer/features/chat/components/CompactSummaryBlock'
import { mapToolGroupProps } from '@renderer/features/chat/utils/toolGroupAdapter'
import { toolIconName, toolLabel } from '@renderer/features/chat/toolUi'
import { ToolFileBadge } from '@renderer/features/chat/toolUi/chrome'
import { parseEditCardData } from '@renderer/features/chat/toolUi/parsers/edit'
import { parseStatusMessageData } from '@renderer/features/chat/toolUi/parsers/status'
import { editStatOf } from '../editStat'
import type { WorkItem } from '../recordModel'

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

/** One line of work: icon, verb, detail, trailing facts. */
function WorkLine({
  icon,
  lead,
  verb,
  detail,
  trailing,
  tone,
  onToggle,
  open
}: {
  icon?: IconName
  lead?: ReactNode
  verb: ReactNode
  detail?: ReactNode
  trailing?: ReactNode
  tone?: 'danger' | 'accent'
  onToggle?: () => void
  open?: boolean
}) {
  const body = (
    <>
      {lead ?? (icon ? <Icon name={icon} size={14} className={cn('shrink-0', tone === 'danger' ? 'text-danger' : 'text-muted')} /> : null)}
      <span className={cn('shrink-0 font-medium', tone === 'danger' ? 'text-danger' : tone === 'accent' ? 'text-accent' : 'text-fg')}>
        {verb}
      </span>
      {detail ? <span className="min-w-0 truncate text-muted">{detail}</span> : null}
      <span className="flex-1" />
      {trailing}
      {onToggle ? <Chevron open={Boolean(open)} /> : null}
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

export function WorkList({ items }: { items: readonly WorkItem[] }) {
  return (
    <div className="space-y-2">
      {items.map((w) => (
        <WorkItemView key={w.id} item={w} />
      ))}
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

/** A turn's failure, with Retry on the latest one and a way to put it away. */
function ErrorItem({ id, message, code }: { id: string; message: string; code?: string | undefined }) {
  const { retryableErrorId, onRetry, onDismissRunError } = useContext(RecordActionsContext)
  const canRetry = Boolean(onRetry) && id === retryableErrorId && isRetryableTurnFailure({ errorCode: code })
  return (
    <div role="alert" className="flex items-start gap-2 text-xs text-danger">
      <Icon name="xCircle" size={14} className="mt-px shrink-0" />
      <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{message}</p>
      {code ? <code className="shrink-0 font-mono text-caption text-tertiary">{code}</code> : null}
      {canRetry || onDismissRunError ? (
        <div className="-my-1 flex shrink-0 items-center gap-1">
          {canRetry ? (
            <Button size="xs" onClick={onRetry}>
              Retry
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
      return item.tool.tool.name === 'terminal' ? <TerminalCard item={item.tool} /> : <EditCard item={item.tool} />
    case 'instance':
      return <InstanceItem item={item.tool} />
    case 'tool':
      return <ToolLine item={item.tool} />
    case 'plan':
      return <PlanItem title={item.title} running={item.tool.tool.status === 'running'} />
    case 'note':
      return (
        <div className="text-sm leading-[21px] text-secondary">
          <MarkdownContent content={item.text} streaming={Boolean(item.item.streaming)} />
        </div>
      )
    case 'thought':
      return item.streaming ? <NowLine text={item.text} since={item.item.at} /> : <Thought text={item.text} />
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

function ExploreItem({ tools }: { tools: ToolItem[] }) {
  const [open, setOpen] = useState(false)
  const { onOpenWorkspaceFile } = useRunSession()
  const { onLoadToolContent, mcpServerNames } = useContext(RecordActionsContext)
  const group = mapToolGroupProps(
    tools.map((t) => t.tool),
    {}
  )
  const running = group.state === 'pending'
  const failed = tools.filter((t) => t.tool.status === 'fail').length
  return (
    <div>
      <WorkLine
        icon={group.nestedTools[0]?.category === 'search' ? 'search' : 'file'}
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
      {open ? (
        <ul className="mt-1 space-y-px border-l border-border pl-3">
          {group.nestedTools.map((nested, i) => {
            const t = tools[i]!
            const fail = t.tool.status === 'fail'
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
                    <Icon name={nested.category === 'browse' ? 'folder' : nested.category === 'browser' ? 'globe' : 'search'} size={13} className="text-tertiary" />
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
                  <ToolRowOutput
                    tool={t.tool}
                    toolProgress={t.toolProgress}
                    onLoadFullContent={onLoadToolContent}
                    mcpServerNames={mcpServerNames}
                    inGroup
                    indent={false}
                  />
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

function TerminalCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(item.tool.status === 'running')
  const { onLoadToolContent, mcpServerNames } = useContext(RecordActionsContext)
  const args = parseArgsRecord(item.tool.argsPreview)
  const command =
    (typeof args?.command === 'string' && args.command) || (typeof args?.cmd === 'string' && args.cmd) || item.tool.summary
  const parsed = item.tool.content ? parseTerminalOutput(item.tool.content) : null
  const running = item.tool.status === 'running' || parsed?.sessionStatus === 'running'
  const exit = parsed?.exitCode ?? null
  const failed = item.tool.status === 'fail' || (exit != null && exit !== 0 && exit !== -1)
  return (
    <div className="overflow-hidden rounded-lg border border-border" data-record-command>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="group flex h-8 w-full items-center gap-2 bg-bg px-3 text-left text-xs focus-visible:vy-focus-ring"
      >
        <Icon name="terminal" size={14} className="shrink-0 text-muted" />
        <code className="min-w-0 flex-1 truncate font-mono text-caption text-fg">
          <span className="text-tertiary">$ </span>
          {command}
        </code>
        {running ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-caption text-muted">
            <AgentVSpinner size={10} />
            running
          </span>
        ) : failed ? (
          <span className="shrink-0 font-mono text-caption text-danger">✕ exit {exit ?? '?'}</span>
        ) : exit != null ? (
          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-caption text-tertiary">
            <Icon name="check" size={11} className="text-success" />
            exit {exit}
          </span>
        ) : null}
        <Duration ms={toolDurationMs(item)} className="w-12 text-right" />
        <Chevron open={open} />
      </button>
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
  const failed = item.tool.status === 'fail'
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
          <span className="flex-1" />
          {running ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 text-caption text-tertiary">
              <AgentVSpinner size={10} />
              Editing
            </span>
          ) : stat?.exact ? (
            <DiffStat add={stat.add} del={stat.del} />
          ) : null}
          <Chevron open={open} />
        </button>
        {onOpenChanges && !failed ? (
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
  const failed = tool.status === 'fail'
  const running = tool.status === 'running'
  const verb = toolLabel(tool.name, tool.status, tool.content)
  const target = tool.summary?.trim() && tool.summary.trim() !== tool.name ? tool.summary.trim() : ''
  // Questions and mode switches settle with a word of their own.
  const chip =
    tool.name === 'ask_question' || tool.name === 'switch_mode' ? parseStatusMessageData(tool).chip : null
  const reason = failed ? (tool.content ?? '').trim().split('\n').find((l) => l.trim()) ?? '' : ''
  return (
    <div data-record-tool={tool.name}>
      <WorkLine
        icon={toolIconName(tool.name)}
        verb={verb}
        detail={target || undefined}
        tone={failed ? 'danger' : undefined}
        open={open}
        onToggle={tool.content ? () => setOpen((v) => !v) : undefined}
        trailing={
          <>
            {chip && chip !== verb ? (
              <span className={cn('shrink-0 text-caption', failed ? 'text-danger' : 'text-tertiary')}>{chip}</span>
            ) : null}
            {running ? <AgentVSpinner size={11} /> : <Duration ms={toolDurationMs(item)} />}
          </>
        }
      />
      {reason && !open ? <p className="m-0 mt-0.5 line-clamp-2 pl-[22px] text-caption text-danger">{reason}</p> : null}
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

function InstanceItem({ item }: { item: ToolItem }) {
  const { onOpenAgentInstance } = useRunSession()
  const runId = parseAgentInstanceRunId(item.tool.content) ?? parseAgentInstanceRunIdFromArgs(item.tool.argsPreview)
  const args = parseArgsRecord(item.tool.argsPreview)
  const goal = typeof args?.goal === 'string' ? args.goal : ''
  const verb = toolLabel(item.tool.name, item.tool.status, item.tool.content)
  return (
    <WorkLine
      icon="crew"
      verb={runId ? `${verb} ${formatAgentInstanceShortId(runId)}` : verb}
      detail={goal || undefined}
      trailing={
        runId && onOpenAgentInstance ? (
          <button
            type="button"
            onClick={() => onOpenAgentInstance(runId)}
            className="shrink-0 text-xs font-medium text-accent hover:underline focus-visible:vy-focus-ring"
          >
            Open
          </button>
        ) : item.tool.status === 'running' ? (
          <AgentVSpinner size={11} />
        ) : null
      }
    />
  )
}

function PlanItem({ title, running }: { title: string | null; running: boolean }) {
  const { onOpenPanel } = useRunSession()
  return (
    <WorkLine
      icon="plan"
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

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 280 || text.includes('\n')
  return (
    <div className="flex gap-2 text-xs">
      <Icon name="memory" size={14} className="mt-px shrink-0 text-tertiary" />
      <div className="min-w-0 flex-1">
        <p className={cn('whitespace-pre-wrap text-muted italic', !open && 'line-clamp-2')}>{text}</p>
        {long ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-0.5 text-caption text-tertiary hover:text-fg focus-visible:vy-focus-ring"
          >
            {open ? 'Show less' : 'Show all'}
          </button>
        ) : null}
      </div>
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
    <div className="flex h-7 items-center gap-2 rounded-md bg-surface px-2 text-xs" aria-live="polite">
      <AgentVSpinner size={13} className="text-fg" />
      <span className="font-semibold text-fg-strong">Now</span>
      <span className="min-w-0 flex-1 truncate vy-text-live" title={since}>
        {line}
      </span>
      <ElapsedSince since={since} />
    </div>
  )
}

/** How long it has been at it, counting up each second while it shows. */
function ElapsedSince({ since }: { since?: string }) {
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
  return <Duration ms={elapsed} />
}
