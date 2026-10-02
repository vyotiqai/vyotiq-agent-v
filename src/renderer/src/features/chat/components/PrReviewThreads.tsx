import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconButton, MarkdownContent, Textarea, cn } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import { prReviewInstruction } from '@renderer/features/task/followUps'
import type { PrReviewThread, PrReviewThreadsResult } from '@shared/ipc'
import { groupReviewThreads, reviewThreadLine } from './reviewThreadGroups'

function fileName(path: string): string {
  return path.split('/').pop() || path
}

/** "L42", "L40–42" for a range, "file" for a comment on the whole file. */
function lineLabel(thread: PrReviewThread): string {
  const line = reviewThreadLine(thread)
  if (line == null) return 'file'
  const start = thread.startLine
  return start != null && start < line ? `L${start}–${line}` : `L${line}`
}

function ThreadRow({
  thread,
  prNumber,
  workspacePath,
  onOpenLocation,
  onHandToAgent,
  onOpenExternal,
  onThreadChange,
  onNotice
}: {
  thread: PrReviewThread
  prNumber: number
  workspacePath: string | null
  onOpenLocation?: (path: string, line: number | null) => void
  onHandToAgent?: (instruction: string) => void
  onOpenExternal: (url: string) => void
  onThreadChange: (next: PrReviewThread) => void
  onNotice: (message: string, failed: boolean) => void
}) {
  const [replyOpen, setReplyOpen] = useState(false)
  const [replyBody, setReplyBody] = useState('')
  const [busy, setBusy] = useState<'resolve' | 'reply' | null>(null)
  const replyRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (replyOpen) replyRef.current?.focus()
  }, [replyOpen])
  const first = thread.comments[0]
  const replies = Math.max(0, thread.commentCount - 1)
  const line = reviewThreadLine(thread)
  const label = lineLabel(thread)
  const state = thread.isResolved ? 'resolved' : thread.isOutdated ? 'outdated' : 'open'
  const canToggle = thread.isResolved ? thread.viewerCanUnresolve : thread.viewerCanResolve

  const toggleResolved = async (): Promise<void> => {
    if (!workspacePath || !window.vyotiq?.prReviewThreadResolve || busy) return
    setBusy('resolve')
    try {
      const res = await window.vyotiq.prReviewThreadResolve({
        workspacePath,
        threadId: thread.id,
        resolved: !thread.isResolved
      })
      if (!res.ok) {
        onNotice(res.error, true)
        return
      }
      onThreadChange({
        ...thread,
        isResolved: res.data.isResolved,
        // Whoever could do one can do the other.
        viewerCanResolve: !res.data.isResolved,
        viewerCanUnresolve: res.data.isResolved
      })
    } finally {
      setBusy(null)
    }
  }

  const postReply = async (): Promise<void> => {
    const body = replyBody.trim()
    if (!workspacePath || !window.vyotiq?.prReviewThreadReply || !body || busy) return
    setBusy('reply')
    try {
      const res = await window.vyotiq.prReviewThreadReply({ workspacePath, threadId: thread.id, body })
      if (!res.ok) {
        onNotice(res.error, true)
        return
      }
      onThreadChange({
        ...thread,
        comments: [...thread.comments, res.data.comment],
        commentCount: thread.commentCount + 1
      })
      setReplyBody('')
      setReplyOpen(false)
      onNotice('Reply posted', false)
    } finally {
      setBusy(null)
    }
  }

  return (
    <li className="py-2" data-review-thread={thread.id} data-thread-state={state}>
      <div className="flex min-w-0 items-center gap-2 text-xs">
        {onOpenLocation ? (
          <button
            type="button"
            className="shrink-0 rounded-sm font-mono text-caption text-muted hover:text-fg hover:underline focus-visible:vy-focus-ring"
            aria-label={`Open ${fileName(thread.path)}${line != null ? ` at line ${line}` : ''}`}
            onClick={() => onOpenLocation(thread.path, line)}
          >
            {label}
          </button>
        ) : (
          <span className="shrink-0 font-mono text-caption text-muted">{label}</span>
        )}
        <span className="min-w-0 truncate font-medium text-fg">{first?.author ?? 'unknown'}</span>
        {thread.isOutdated ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-caption text-tertiary" data-thread-outdated>
            <Icon name="clock" size={11} />
            Outdated
          </span>
        ) : null}
        {thread.isResolved ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-caption text-tertiary" data-thread-resolved>
            <Icon name="checkCircle" size={11} />
            Resolved
          </span>
        ) : null}
        <span className="flex-1" />
        {replies > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-caption text-tertiary tnum">
            <Icon name="chat" size={11} />
            {replies} {replies === 1 ? 'reply' : 'replies'}
          </span>
        ) : null}
        {first?.url ? (
          <IconButton
            icon="external"
            label="Open the conversation on GitHub"
            size="xs"
            tone="muted"
            onClick={() => onOpenExternal(first.url!)}
          />
        ) : null}
      </div>
      {first?.body.trim() ? (
        <div className="mt-1">
          <MarkdownContent content={first.body} tone="secondary" />
        </div>
      ) : null}
      {(onHandToAgent && !thread.isResolved) || thread.viewerCanReply || canToggle ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {onHandToAgent && !thread.isResolved ? (
            <Button size="xs" icon="robot" onClick={() => onHandToAgent(prReviewInstruction([thread], prNumber))}>
              Hand to the agent
            </Button>
          ) : null}
          {thread.viewerCanReply && workspacePath && !replyOpen ? (
            <Button size="xs" variant="ghost" onClick={() => setReplyOpen(true)}>
              Reply
            </Button>
          ) : null}
          {canToggle && workspacePath ? (
            <Button size="xs" variant="ghost" pending={busy === 'resolve'} disabled={busy != null} onClick={() => void toggleResolved()}>
              {thread.isResolved ? 'Unresolve' : 'Resolve'}
            </Button>
          ) : null}
        </div>
      ) : null}
      {replyOpen ? (
        <form
          className="mt-2 space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            void postReply()
          }}
        >
          <Textarea
            ref={replyRef}
            size="sm"
            placeholder="Reply"
            aria-label={`Reply to ${first?.author ?? 'the thread'}`}
            value={replyBody}
            maxLength={8_000}
            onChange={(e) => setReplyBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setReplyOpen(false)
              }
            }}
          />
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="primary"
              type="submit"
              icon="send"
              pending={busy === 'reply'}
              disabled={busy != null || !replyBody.trim()}
            >
              Post reply on GitHub
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setReplyOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  )
}

/**
 * The pull request's inline review threads, by file. Resolved ones wait behind
 * a count; open ones can go to the task one at a time or all together.
 */
export function PrReviewThreads({
  result,
  loading,
  error,
  prNumber,
  workspacePath,
  onOpenLocation,
  onHandToAgent,
  onOpenExternal,
  onResultChange,
  onNotice
}: {
  result: PrReviewThreadsResult | null
  loading: boolean
  error: string | null
  prNumber: number
  workspacePath: string | null
  onOpenLocation?: (path: string, line: number | null) => void
  onHandToAgent?: (instruction: string) => void
  onOpenExternal: (url: string) => void
  onResultChange: (next: PrReviewThreadsResult) => void
  onNotice: (message: string, failed: boolean) => void
}) {
  const [showResolved, setShowResolved] = useState(false)
  const threads = useMemo(() => result?.threads ?? [], [result])
  const { groups, unresolved, resolvedCount } = useMemo(
    () => groupReviewThreads(threads, { showResolved }),
    [threads, showResolved]
  )

  const replaceThread = (next: PrReviewThread): void => {
    if (!result) return
    onResultChange({ ...result, threads: result.threads.map((t) => (t.id === next.id ? next : t)) })
  }

  return (
    <section className="mt-5" aria-label="Review comments" data-review-threads>
      <div className="mb-1 flex min-h-6 items-center gap-2">
        <h4 className={cn('m-0', SECTION_LABEL)}>Review comments</h4>
        {threads.length > 0 ? (
          <span className="text-caption text-tertiary tnum">{unresolved.length} unresolved</span>
        ) : null}
        <span className="flex-1" />
        {onHandToAgent && unresolved.length > 1 ? (
          <Button size="xs" icon="robot" onClick={() => onHandToAgent(prReviewInstruction(unresolved, prNumber))}>
            Address all unresolved
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="m-0 text-xs text-danger [overflow-wrap:anywhere]" role="alert">
          {error}
        </p>
      ) : loading && !result ? (
        <p className="m-0 text-xs text-muted">Loading review comments…</p>
      ) : threads.length === 0 ? (
        <p className="m-0 text-xs text-muted">No review comments on the code.</p>
      ) : (
        <>
          {groups.map((group) => (
            <div key={group.path} className="mt-2" data-review-thread-file={group.path}>
              <p className="m-0 flex h-6 min-w-0 items-center gap-1.5 text-xs" title={group.path}>
                <Icon name="file" size={12} className="shrink-0 text-tertiary" />
                <span className="min-w-0 truncate font-mono text-fg">{group.path}</span>
              </p>
              {/* BORDER_DIVIDER's weight, as a divide: rows inside one list. */}
              <ul className="m-0 list-none divide-y divide-border/60 p-0 pl-[18px]">
                {group.threads.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    prNumber={prNumber}
                    workspacePath={workspacePath}
                    onOpenLocation={onOpenLocation}
                    onHandToAgent={onHandToAgent}
                    onOpenExternal={onOpenExternal}
                    onThreadChange={replaceThread}
                    onNotice={onNotice}
                  />
                ))}
              </ul>
            </div>
          ))}
          {unresolved.length === 0 && !showResolved ? (
            <p className="m-0 mt-1 text-xs text-muted">Every review comment is resolved.</p>
          ) : null}
          {resolvedCount > 0 ? (
            <button
              type="button"
              className="mt-2 inline-flex items-center gap-1 rounded-sm text-xs text-muted hover:text-fg focus-visible:vy-focus-ring"
              aria-expanded={showResolved}
              onClick={() => setShowResolved((v) => !v)}
              data-show-resolved
            >
              <Icon name={showResolved ? 'chevron' : 'chevronRight'} size={12} />
              {showResolved ? 'Hide resolved' : `${resolvedCount} resolved`}
            </button>
          ) : null}
          {result?.truncated ? (
            <p className="m-0 mt-1 text-caption text-tertiary">
              Showing {threads.length} of {result.totalCount} — the rest are on GitHub.
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}
