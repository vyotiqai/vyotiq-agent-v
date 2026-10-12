import { useEffect, useRef, useState } from 'react'
import { Button, IconButton, MarkdownContent, Segmented, Textarea } from '@renderer/lib/ui'
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

type Draft = { editing: { draft: string; from: string } | null; comment: string }

/**
 * What is half-written, per pull request. Kept outside the component: a
 * Refresh, or coming back from another panel, shows "Loading…" in its place
 * and unmounts it — and "Refresh to see it, then edit again" must not cost
 * the person their text.
 */
const drafts = new Map<string, Draft>()

/** @internal */
export function clearPrDraftsForTests(): void {
  drafts.clear()
}

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
  const key = `${workspacePath ?? ''}|${pr.number}`
  /** The description being edited, and the one editing began from. */
  const [editing, setEditingState] = useState<Draft['editing']>(() => drafts.get(key)?.editing ?? null)
  const [saving, setSaving] = useState(false)
  const [comment, setCommentState] = useState(() => drafts.get(key)?.comment ?? '')
  const [posting, setPosting] = useState(false)
  /** The description as saved, shown until the reload brings GitHub's copy. */
  const [saved, setSaved] = useState<string | null>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const isEditing = editing !== null
  /** Write or Preview, while editing the description. */
  const [editView, setEditView] = useState<'write' | 'preview'>('write')
  /** Every comment, once Show all read them; the latest few until then. */
  const [allComments, setAllComments] = useState<PrComment[] | null>(null)
  const [loadingAll, setLoadingAll] = useState(false)

  const remember = (next: Partial<Draft>): void => {
    const merged = { editing: drafts.get(key)?.editing ?? null, comment: drafts.get(key)?.comment ?? '', ...next }
    if (!merged.editing && !merged.comment) drafts.delete(key)
    else drafts.set(key, merged)
  }
  const setEditing = (next: Draft['editing']): void => {
    setEditingState(next)
    remember({ editing: next })
  }
  const setComment = (next: string): void => {
    setCommentState(next)
    remember({ comment: next })
  }

  // Edit opens the field with the cursor in it.
  useEffect(() => {
    if (isEditing && editView === 'write') editRef.current?.focus()
  }, [isEditing, editView])

  // Another pull request (or workspace): its own drafts, not this one's.
  const [shownKey, setShownKey] = useState(key)
  if (shownKey !== key) {
    setShownKey(key)
    setEditingState(drafts.get(key)?.editing ?? null)
    setCommentState(drafts.get(key)?.comment ?? '')
    setSaved(null)
    setAllComments(null)
    setEditView('write')
  }
  // A reload brought the latest comments: the full list is stale now.
  useEffect(() => {
    setAllComments(null)
  }, [pr.comments])
  // GitHub's copy arrived: it is what shows.
  useEffect(() => {
    setSaved(null)
  }, [pr.body])

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
      setSaved(res.data.body)
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

  const showAll = async (): Promise<void> => {
    if (!workspacePath) return
    setLoadingAll(true)
    try {
      const res = await window.vyotiq.prCommentsAll({ workspacePath, number: pr.number })
      if (!res.ok) {
        onNotice(res.error, true)
        return
      }
      setAllComments(res.data)
    } finally {
      setLoadingAll(false)
    }
  }

  const comments = allComments ?? pr.comments ?? []
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
              onClick={() => setEditing({ draft: saved ?? pr.body, from: saved ?? pr.body })}
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
            {editView === 'write' ? (
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
            ) : (
              <div className="min-h-[12rem] rounded-md border border-border px-3 py-2" data-pr-body-preview>
                {editing.draft.trim() ? (
                  <MarkdownContent content={editing.draft} tone="secondary" />
                ) : (
                  <p className="m-0 text-xs text-muted">Nothing to preview.</p>
                )}
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <Segmented
                size="xs"
                label="Description view"
                items={[
                  { id: 'write', label: 'Write' },
                  { id: 'preview', label: 'Preview' }
                ]}
                value={editView}
                onChange={setEditView}
              />
              <span className="flex-1" />
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" type="submit" pending={saving} disabled={saving || editing.draft === editing.from}>
                Save
              </Button>
            </div>
          </form>
        ) : (saved ?? pr.body).trim() ? (
          <MarkdownContent content={saved ?? pr.body} tone="secondary" />
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
              <li className="flex items-center gap-2 py-2 text-xs text-muted">
                <span>
                  The latest {comments.length} of {total}
                </span>
                <span className="flex-1" />
                {workspacePath ? (
                  <Button size="xs" variant="ghost" pending={loadingAll} disabled={loadingAll} onClick={() => void showAll()}>
                    Show all {total}
                  </Button>
                ) : null}
                <IconButton icon="external" label="Open the conversation on GitHub" size="xs" tone="muted" onClick={() => onOpenExternal(pr.url)} />
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
