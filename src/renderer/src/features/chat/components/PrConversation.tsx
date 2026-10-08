import { useEffect, useRef, useState } from 'react'
import { Button, IconButton, MarkdownContent, Textarea } from '@renderer/lib/ui'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import type { PrComment, PrView } from '@shared/ipc'

/**
 * A pull request's About tab: its description, which can be edited, and the
 * main conversation, which can be answered. Both change the PR on GitHub
 * under the signed-in account, so each goes out from one explicit button.
 *
 * A description edit is refused by main when GitHub's copy changed since the
 * edit began (GitHub has no compare-and-swap); the draft stays in the field.
 */
export function PrConversation({
  pr,
  workspacePath,
  onReload,
  onNotice,
  onOpenExternal
}: {
  pr: Pick<PrView, 'number' | 'body' | 'url' | 'comments' | 'commentCount'>
  workspacePath: string | null
  /** Read the PR again after a change went through. */
  onReload: () => void
  onNotice: (message: string, failed: boolean) => void
  onOpenExternal: (url: string) => void
}) {
  /** The description being edited, and the one editing began from. */
  const [editing, setEditing] = useState<{ draft: string; from: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [comment, setComment] = useState('')
  const [posting, setPosting] = useState(false)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const isEditing = editing !== null

  // Edit opens the field with the cursor in it.
  useEffect(() => {
    if (isEditing) editRef.current?.focus()
  }, [isEditing])

  // Another pull request: nothing half-written carries over to it.
  useEffect(() => {
    setEditing(null)
    setComment('')
  }, [pr.number])

  const save = async (): Promise<void> => {
    if (!workspacePath || !editing) return
    setSaving(true)
    try {
      const res = await window.vyotiq.prEditBody({ workspacePath, number: pr.number, body: editing.draft, expected: editing.from })
      if (!res.ok) {
        onNotice(res.error, true)
        return
      }
      setEditing(null)
      onNotice('Description saved', false)
      onReload()
    } finally {
      setSaving(false)
    }
  }

  const post = async (): Promise<void> => {
    const body = comment.trim()
    if (!workspacePath || !body) return
    setPosting(true)
    try {
      const res = await window.vyotiq.prComment({ workspacePath, number: pr.number, body })
      if (!res.ok) {
        onNotice(res.error, true)
        return
      }
      setComment('')
      onNotice(res.data.detail, false)
      onReload()
    } finally {
      setPosting(false)
    }
  }

  const comments = pr.comments ?? []
  const total = Math.max(pr.commentCount ?? 0, comments.length)

  return (
    <div className="space-y-5" data-pr-conversation>
      <section>
        <div className="mb-1.5 flex h-6 items-center gap-2">
          <h4 className={SECTION_LABEL}>Description</h4>
          <span className="flex-1" />
          {workspacePath && !editing ? (
            <IconButton
              icon="edit"
              label="Edit the description"
              size="xs"
              tone="muted"
              onClick={() => setEditing({ draft: pr.body, from: pr.body })}
            />
          ) : null}
        </div>
        {editing ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <Textarea
              size="sm"
              mono
              rows={12}
              value={editing.draft}
              maxLength={65_536}
              aria-label="Pull request description"
              ref={editRef}
              onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !saving) {
                  e.preventDefault()
                  e.stopPropagation()
                  setEditing(null)
                }
              }}
            />
            <div className="flex items-center gap-1.5">
              <span className="flex-1" />
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" type="submit" pending={saving} disabled={saving || editing.draft === editing.from}>
                Save
              </Button>
            </div>
          </form>
        ) : pr.body.trim() ? (
          <MarkdownContent content={pr.body} tone="secondary" />
        ) : (
          <p className="m-0 text-xs text-muted">No description.</p>
        )}
      </section>

      <section aria-label="Conversation">
        <h4 className={SECTION_LABEL}>
          Conversation{total > 0 ? <span className="font-normal text-tertiary"> · {total}</span> : null}
        </h4>
        {comments.length === 0 ? (
          <p className="m-0 mt-1.5 text-xs text-muted">No comments yet.</p>
        ) : (
          // BORDER_DIVIDER's weight, as a divide: rows inside one list.
          <ul className="m-0 mt-1 list-none divide-y divide-border/60 p-0" data-pr-comments>
            {total > comments.length ? (
              <li className="py-2 text-xs text-muted">
                The latest {comments.length} of {total};{' '}
                <button
                  type="button"
                  className="rounded-sm text-accent hover:underline focus-visible:vy-focus-ring"
                  onClick={() => onOpenExternal(pr.url)}
                >
                  the rest are on GitHub
                </button>
              </li>
            ) : null}
            {comments.map((c, i) => (
              <CommentRow key={c.url ?? `${c.author}-${c.createdAt ?? i}`} comment={c} onOpenExternal={onOpenExternal} />
            ))}
          </ul>
        )}
        {workspacePath ? (
          <form
            className="mt-3 space-y-2"
            onSubmit={(e) => {
              e.preventDefault()
              void post()
            }}
          >
            <Textarea
              size="sm"
              placeholder="Comment on this pull request"
              aria-label="Comment on this pull request"
              maxLength={65_536}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && comment.trim() && !posting) {
                  e.preventDefault()
                  void post()
                }
              }}
            />
            <div className="flex items-center">
              <span className="flex-1" />
              <Button size="sm" type="submit" icon="chat" pending={posting} disabled={posting || !comment.trim()}>
                Comment
              </Button>
            </div>
          </form>
        ) : null}
      </section>
    </div>
  )
}

function CommentRow({ comment, onOpenExternal }: { comment: PrComment; onOpenExternal: (url: string) => void }) {
  // GitHub folds a hidden comment; so does this, with the text a click away.
  const [shown, setShown] = useState(!comment.minimized)
  return (
    <li className="py-2 text-xs" data-pr-comment>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-fg">{comment.author}</span>
        {comment.createdAt ? (
          <span className="truncate text-caption text-tertiary">{new Date(comment.createdAt).toLocaleString()}</span>
        ) : null}
        <span className="flex-1" />
        {comment.url ? (
          <IconButton
            icon="external"
            label={`Open ${comment.author}'s comment on GitHub`}
            size="xs"
            tone="muted"
            onClick={() => onOpenExternal(comment.url!)}
          />
        ) : null}
      </div>
      {shown ? (
        comment.body.trim() ? (
          <div className="mt-1">
            <MarkdownContent content={comment.body} tone="secondary" className="text-xs" />
          </div>
        ) : (
          <p className="m-0 mt-1 text-tertiary">No text.</p>
        )
      ) : (
        <p className="m-0 mt-1 text-tertiary">
          Hidden on GitHub.{' '}
          <button type="button" className="rounded-sm text-accent hover:underline focus-visible:vy-focus-ring" onClick={() => setShown(true)}>
            Show it
          </button>
        </p>
      )}
    </li>
  )
}
