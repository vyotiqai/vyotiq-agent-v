import { useState } from 'react'
import type { ActiveRun, ToolApprovalDecision } from '@shared/ipc'
import { relativeTime } from '@shared/utils/timeFormat'
import { Icon } from '@renderer/lib/icons'
import { Button, IconButton, StatusGlyph } from '@renderer/lib/ui'
import { useSharedNow } from '@renderer/lib/hooks/useSharedNow'
import type { McpHealthIssue } from '../useMcpHealth'
import type { PendingAsk } from '../usePendingAsks'
import { approvalAsk, questionAsk } from '@shared/needsYouText'
import { HomeRow, HomeSection } from './HomeBlocks'

export type ProviderIssue = {
  /** Display label of the provider the next task would use. */
  label: string
}

/** A task whose run is parked on you: an approval or a question. */
export type WaitingTask = { run: ActiveRun; title: string }

type Issue = { id: string; title: string; detail: string; action?: { label: string; onClick: () => void } }

/**
 * Everything that cannot move without you, answered in place where it can be:
 * an approval takes Deny or Allow once right here; a question opens its task,
 * where the form is. Below them, what stops any task from running at all — a
 * provider with no key, an MCP server that wants a sign-in or can't connect.
 */
export function NeedsYouSection({
  tasks,
  asks,
  providerIssue,
  mcpIssues,
  serverNames,
  onDecide,
  onOpenTask,
  onOpenProviderSettings,
  onOpenMcpServer,
  onRetryMcp
}: {
  tasks: readonly WaitingTask[]
  asks: Readonly<Record<string, PendingAsk | null>>
  providerIssue: ProviderIssue | null
  mcpIssues: readonly McpHealthIssue[]
  serverNames?: ReadonlyMap<string, string>
  onDecide: (run: ActiveRun, requestId: string, decision: ToolApprovalDecision) => Promise<void>
  onOpenTask: (run: ActiveRun) => void
  onOpenProviderSettings?: () => void
  onOpenMcpServer?: (serverId: string) => void
  onRetryMcp?: () => void
}) {
  const now = useSharedNow(tasks.length > 0)
  const issues: Issue[] = []
  if (providerIssue) {
    issues.push({
      id: 'provider',
      title: `${providerIssue.label} has no API key`,
      detail: 'Tasks can’t start until a key is saved for it',
      ...(onOpenProviderSettings ? { action: { label: 'Add key', onClick: onOpenProviderSettings } } : {})
    })
  }
  for (const server of mcpIssues) issues.push(mcpIssue(server, onOpenMcpServer, onRetryMcp))

  return (
    <HomeSection id="home-needs-you" label="Needs you" className="mt-12">
      {tasks.map((task) => (
        <WaitingRow
          key={task.run.runId}
          task={task}
          ask={asks[task.run.runId] ?? null}
          now={now}
          serverNames={serverNames}
          onDecide={onDecide}
          onOpen={() => onOpenTask(task.run)}
        />
      ))}
      {issues.map((issue) => (
        <HomeRow key={issue.id}>
          <Icon name="warningCircle" size={15} className="shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-fg">{issue.title}</p>
            <p className="truncate text-xs text-muted" title={issue.detail}>
              {issue.detail}
            </p>
          </div>
          {issue.action ? (
            <Button size="xs" onClick={issue.action.onClick}>
              {issue.action.label}
            </Button>
          ) : null}
        </HomeRow>
      ))}
      {tasks.length === 0 && issues.length === 0 ? (
        <HomeRow>
          <p className="text-sm text-tertiary">Nothing is waiting on you. Approvals and questions from running tasks land here.</p>
        </HomeRow>
      ) : null}
    </HomeSection>
  )
}

/** Each kind of MCP failure names itself and offers the one control that fixes it. */
function mcpIssue(server: McpHealthIssue, onOpen?: (serverId: string) => void, onRetry?: () => void): Issue {
  const open = onOpen ? () => onOpen(server.id) : undefined
  if (server.errorKind === 'sign-in') {
    return {
      id: `mcp:${server.id}`,
      title: `Sign in to ${server.name}`,
      detail: `The ${server.name} MCP is installed but not connected`,
      ...(open ? { action: { label: 'Sign in', onClick: open } } : {})
    }
  }
  if (server.errorKind === 'network') {
    return {
      id: `mcp:${server.id}`,
      title: `${server.name} can’t be reached`,
      detail: server.error ?? 'The connection failed',
      ...(onRetry ? { action: { label: 'Retry', onClick: onRetry } } : open ? { action: { label: 'Open', onClick: open } } : {})
    }
  }
  return {
    id: `mcp:${server.id}`,
    title: `${server.name} isn’t connected`,
    detail: server.error ?? 'It is enabled but reported no connection',
    ...(open ? { action: { label: 'Open', onClick: open } } : {})
  }
}

function WaitingRow({
  task,
  ask,
  now,
  serverNames,
  onDecide,
  onOpen
}: {
  task: WaitingTask
  ask: PendingAsk | null
  now: number
  serverNames?: ReadonlyMap<string, string>
  onDecide: (run: ActiveRun, requestId: string, decision: ToolApprovalDecision) => Promise<void>
  onOpen: () => void
}) {
  const [pending, setPending] = useState<ToolApprovalDecision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const since = task.run.waiting?.since
  const age = since ? relativeTime(since, now) || 'now' : null
  const note =
    ask?.kind === 'approval'
      ? approvalAsk(ask.request, serverNames)
      : ask?.kind === 'question'
        ? questionAsk(ask.request)
        : task.run.waiting?.kind === 'approval'
          ? 'Needs your approval'
          : 'Has a question for you'

  const decide = (decision: ToolApprovalDecision): void => {
    if (ask?.kind !== 'approval' || pending) return
    setPending(decision)
    setError(null)
    onDecide(task.run, ask.request.requestId, decision).catch((err: unknown) => {
      setPending(null)
      setError(err instanceof Error ? err.message : 'Could not send your decision.')
    })
  }

  return (
    <HomeRow>
      <StatusGlyph state="needs" size={14} label />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-fg" title={task.title}>
          {task.title}
        </p>
        {error ? (
          <p role="alert" className="truncate text-xs text-danger" title={error}>
            {error}
          </p>
        ) : (
          <p className="truncate text-xs text-muted" title={note}>
            {note}
            {age ? <span className="font-mono text-tertiary tnum"> · {age}</span> : null}
          </p>
        )}
      </div>
      {ask?.kind === 'approval' ? (
        <>
          <Button size="xs" variant="ghost" disabled={pending != null} onClick={() => decide('deny')}>
            {pending === 'deny' ? 'Sending…' : 'Deny'}
          </Button>
          <Button size="xs" variant="primary" disabled={pending != null} onClick={() => decide('once')}>
            {pending === 'once' ? 'Sending…' : 'Allow once'}
          </Button>
          <IconButton icon="arrowRight" label={`Open ${task.title}`} size="sm" tone="muted" onClick={onOpen} />
        </>
      ) : ask?.kind === 'question' ? (
        <Button size="xs" variant="primary" onClick={onOpen}>
          Answer
        </Button>
      ) : (
        <IconButton icon="arrowRight" label={`Open ${task.title}`} size="sm" tone="muted" onClick={onOpen} />
      )}
    </HomeRow>
  )
}
