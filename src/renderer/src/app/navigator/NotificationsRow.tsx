import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { NotificationItem, NotificationMutateRequest, ToolApprovalDecision } from '@shared/ipc'
import { relativeTime } from '@shared/utils/timeFormat'
import { Icon } from '@renderer/lib/icons'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { Badge, Button, IconButton, MENU_SURFACE, StatusGlyph, cn } from '@renderer/lib/ui'
import { ROW_HOVER, SECTION_LABEL } from '@renderer/lib/utils/layout'
import type { PendingAsk } from '@renderer/features/home/usePendingAsks'
import { questionAsk } from '@shared/needsYouText'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { RowDecision, commandOf } from './NavigatorTaskRow'

const OPEN_INBOX_EVENT = 'vyotiq:open-inbox'

/**
 * Opens the Inbox that is on screen (the list's, or the rail's), from outside
 * it — the palette. False when none is showing, so the caller can show the
 * list first.
 */
export function requestOpenInbox(): boolean {
  const event = new CustomEvent(OPEN_INBOX_EVENT, { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

function unreadLabel(count: number): string {
  if (count <= 0) return 'Inbox'
  return count === 1 ? 'Inbox, 1 unread' : `Inbox, ${count} unread`
}

/**
 * The item's state as the navigator draws it: a run that wants you, one whose
 * edits wait on review, one that finished or failed. An app alert gets a
 * quiet mark — it asks nothing of you.
 */
export function NotificationGlyph({ item }: { item: Pick<NotificationItem, 'kind' | 'reviewFiles'> }): ReactNode {
  switch (item.kind) {
    case 'needs_you':
      return <StatusGlyph state="needs" size={14} />
    case 'run_done':
      return <StatusGlyph state={item.reviewFiles ? 'review' : 'done'} size={14} />
    case 'run_error':
      return <StatusGlyph state="failed" size={14} />
    case 'crash':
      return <Icon name="warning" size={14} className="shrink-0 text-muted" />
    case 'update_ready':
      return <Icon name="download" size={14} className="shrink-0 text-muted" />
    default: {
      const exhaustive: never = item.kind
      return exhaustive
    }
  }
}

type InboxGroup = { key: 'asks' | 'review' | 'earlier'; label: string; items: NotificationItem[] }

/** A task waiting on you right now, as the list has it: what the Inbox's Needs you is made of. */
export type WaitingTask = { workspacePath: string; runId: string; title: string; since: string | null }

function sameTask(item: NotificationItem, task: Pick<WaitingTask, 'workspacePath' | 'runId'>): boolean {
  return (
    item.action?.type === 'open_run' &&
    item.action.runId === task.runId &&
    workspacePathsEqual(item.action.workspacePath, task.workspacePath)
  )
}

/** The notices a waiting task's row stands for, so answering or opening it reads them. */
function noticesFor(items: readonly NotificationItem[], task: Pick<WaitingTask, 'workspacePath' | 'runId'>): NotificationItem[] {
  return items.filter((item) => item.kind === 'needs_you' && sameTask(item, task))
}

/**
 * A waiting task drawn as an Inbox row. It is read once its notice is (you
 * opened it), and stays until it is answered — Clear never takes it.
 */
function liveItem(task: WaitingTask, items: readonly NotificationItem[]): NotificationItem {
  const notice = noticesFor(items, task)[0]
  return {
    id: `waiting:${task.workspacePath}:${task.runId}`,
    createdAt: task.since ?? notice?.createdAt ?? new Date().toISOString(),
    read: notice?.read ?? false,
    source: 'agent',
    kind: 'needs_you',
    title: task.title,
    body: notice?.body ?? 'Waiting on you',
    dedupeKey: `waiting:${task.runId}`,
    action: { type: 'open_run', workspacePath: task.workspacePath, runId: task.runId }
  }
}

/**
 * The state a group says once, on its heading (the heading's words name it, so the
 * glyph stays silent); Earlier mixes kinds, so its rows say their own.
 */
const GROUP_GLYPH: Record<InboxGroup['key'], ReactNode> = {
  asks: <StatusGlyph state="needs" size={14} />,
  review: <StatusGlyph state="review" size={14} />,
  earlier: null
}

/** The approval a needs-you item's task still waits on, or null once it has been answered. */
function openAsk(item: NotificationItem, asks: Readonly<Record<string, PendingAsk | null>> | undefined): PendingAsk | null {
  if (item.kind !== 'needs_you' || item.action?.type !== 'open_run') return null
  return asks?.[item.action.runId] ?? null
}

/**
 * Asks still open first, then finished work waiting on review, then the rest.
 * An ask already answered is history, so it goes to Earlier.
 */
function inboxGroups(
  items: NotificationItem[],
  asks: Readonly<Record<string, PendingAsk | null>> | undefined,
  waiting: readonly WaitingTask[] | undefined
): InboxGroup[] {
  const groups: InboxGroup[] = [
    { key: 'asks', label: 'Needs you', items: [] },
    { key: 'review', label: 'Ready for review', items: [] },
    { key: 'earlier', label: 'Earlier', items: [] }
  ]
  if (waiting) {
    // Needs you is the tasks that wait on you now, whatever was notified; the
    // notice for one is its row, not a second one.
    groups[0]!.items.push(...waiting.map((task) => liveItem(task, items)))
    for (const item of items) {
      if (item.kind === 'needs_you' && waiting.some((task) => sameTask(item, task))) continue
      groups[item.kind === 'run_done' && item.reviewFiles ? 1 : 2]!.items.push(item)
    }
    return groups.filter((group) => group.items.length > 0)
  }
  for (const item of items) {
    const at = openAsk(item, asks) ? 0 : item.kind === 'run_done' && item.reviewFiles ? 1 : 2
    groups[at]!.items.push(item)
  }
  return groups.filter((group) => group.items.length > 0)
}

/**
 * The navigator's Inbox and the panel it opens: tasks that want you, wait on
 * your review, finished or failed, and app alerts. An icon in the foot's row;
 * a dot on it says something is unread, and the count is in its name and in
 * the panel. A waiting command is allowed or denied in place, with the same
 * decision the task's row and record offer; a failed task is retried in place,
 * with the Retry its row menu offers.
 */
export function NotificationsRow({
  items,
  unreadCount,
  onMarkRead,
  onDismiss,
  onOpenItem,
  onOpenSettings,
  asks,
  onRespondApproval,
  onRetry,
  canRetry,
  waiting,
  onOpenTask
}: {
  items: NotificationItem[]
  unreadCount: number
  onMarkRead: (req: NotificationMutateRequest) => void
  onDismiss: (req: NotificationMutateRequest) => void
  onOpenItem: (item: NotificationItem) => void
  onOpenSettings: () => void
  /** What each waiting task asks, by run id (the navigator reads them). */
  asks?: Readonly<Record<string, PendingAsk | null>>
  onRespondApproval?: (workspacePath: string, runId: string, requestId: string, decision: ToolApprovalDecision) => Promise<void>
  /** A failed task's Retry, the one its row menu and record offer. */
  onRetry?: (workspacePath: string, runId: string) => void
  /** The task still stands failed: not going again, not gone. */
  canRetry?: (workspacePath: string, runId: string) => boolean
  /**
   * The tasks waiting on you now. Given, Needs you is made of them rather than
   * of notices — Clear, Mark all read or a notification setting can't hide one —
   * and the unread count keeps them in until they are answered.
   */
  waiting?: readonly WaitingTask[]
  /** Open a waiting task (its row, or Answer). */
  onOpenTask?: (workspacePath: string, runId: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const { position, close } = useDropdownMenu({
    open,
    onOpenChange: setOpen,
    triggerRef,
    panelRef,
    placement: 'up',
    align: 'start',
    trapFocus: true,
    autoFocusFirst: true
  })
  // A waiting task counts until it is answered; its own unread notice is not counted twice.
  const doubled = waiting
    ? items.filter((item) => !item.read && item.kind === 'needs_you' && waiting.some((task) => sameTask(item, task))).length
    : 0
  const shownUnread = Math.max(0, unreadCount - doubled) + (waiting?.length ?? 0)
  const label = unreadLabel(shownUnread)
  const groups = open ? inboxGroups(items, asks, waiting) : []
  const empty = items.length === 0 && (waiting?.length ?? 0) === 0

  // A request from outside: one Inbox answers it. The list and the rail mount
  // only while they show; with the drawer open over the rail, the drawer's does.
  useEffect(() => {
    const onRequest = (event: Event): void => {
      const trigger = triggerRef.current
      if (event.defaultPrevented || !trigger?.isConnected || trigger.closest('[inert]')) return
      const modal = document.querySelector('[aria-modal="true"]')
      if (modal && !modal.contains(trigger)) return
      event.preventDefault()
      setOpen(true)
    }
    window.addEventListener(OPEN_INBOX_EVENT, onRequest)
    return () => window.removeEventListener(OPEN_INBOX_EVENT, onRequest)
  }, [])

  const panel =
    open && position ? (
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-label="Inbox"
        tabIndex={-1}
        data-notifications-panel
        className={cn(
          'app-region-no-drag fixed flex max-h-[min(30rem,72vh)] w-[min(22.5rem,calc(100vw-1.5rem))] flex-col overflow-hidden origin-bottom',
          MENU_SURFACE
        )}
        style={{
          top: position.placement === 'up' ? undefined : position.top,
          bottom: position.placement === 'up' ? window.innerHeight - position.top : undefined,
          left: position.left
        }}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2">
          <h2 className="text-sm font-semibold text-fg-strong">Inbox</h2>
          {shownUnread > 0 ? <Badge tone="accent">{shownUnread} new</Badge> : null}
          <span className="flex-1" />
          <Button size="xs" variant="ghost" disabled={unreadCount === 0} onClick={() => onMarkRead({ all: true })}>
            Mark all read
          </Button>
          <Button size="xs" variant="ghost" disabled={items.length === 0} onClick={() => onDismiss({ all: true })}>
            Clear
          </Button>
        </div>
        {empty ? (
          <p className="px-3 py-6 text-center text-xs text-tertiary">Nothing new.</p>
        ) : (
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            {groups.map((group) => (
              <section key={group.key} aria-labelledby={`${panelId}-${group.key}`} data-inbox-group={group.key}>
                <h3
                  id={`${panelId}-${group.key}`}
                  className={cn('m-0 flex h-7 items-end justify-between gap-2 px-3 pb-1', SECTION_LABEL)}
                >
                  {group.label}
                  {GROUP_GLYPH[group.key] ? <span className="flex shrink-0 normal-case">{GROUP_GLYPH[group.key]}</span> : null}
                </h3>
                <ul className="m-0 list-none divide-y divide-border/60 p-0">
                  {group.items.map((item) => {
                    // A waiting task's row: its notices are read with it, and it is never dismissed.
                    const target = item.action?.type === 'open_run' ? item.action : null
                    const live = waiting != null && group.key === 'asks' && target != null
                    const markRead = (): void => {
                      if (!live) onMarkRead({ id: item.id })
                      else for (const notice of noticesFor(items, target)) if (!notice.read) onMarkRead({ id: notice.id })
                    }
                    return (
                    <InboxItem
                      key={item.id}
                      item={item}
                      ask={live ? (asks?.[target.runId] ?? null) : openAsk(item, asks)}
                      showGlyph={group.key === 'earlier'}
                      onOpen={() => {
                        markRead()
                        if (live && onOpenTask) onOpenTask(target.workspacePath, target.runId)
                        else onOpenItem(item)
                        close(true)
                      }}
                      onDismiss={live ? undefined : () => onDismiss({ id: item.id })}
                      onDecide={
                        onRespondApproval && target
                          ? async (requestId: string, decision: ToolApprovalDecision) => {
                              await onRespondApproval(target.workspacePath, target.runId, requestId, decision)
                              markRead()
                            }
                          : undefined
                      }
                      onRetry={
                        onRetry &&
                        item.kind === 'run_error' &&
                        item.action?.type === 'open_run' &&
                        (canRetry?.(item.action.workspacePath, item.action.runId) ?? true)
                          ? () => {
                              const { workspacePath, runId } = item.action as { workspacePath: string; runId: string }
                              onMarkRead({ id: item.id })
                              onRetry(workspacePath, runId)
                              close(true)
                            }
                          : undefined
                      }
                    />
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
        <div className="flex h-10 shrink-0 items-center border-t border-border pl-3 pr-2">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-sm text-xs text-muted vy-transition hover:text-fg focus-visible:vy-focus-ring"
            onClick={() => {
              onOpenSettings()
              close(true)
            }}
          >
            <Icon name="gear" size={13} />
            Notification settings
          </button>
        </div>
      </div>
    ) : null

  return (
    <>
      <span className="relative inline-flex">
        <IconButton
          ref={triggerRef}
          icon="inbox"
          label={label}
          size="md"
          active={open}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          data-place="inbox"
          onClick={() => setOpen((prev) => !prev)}
        />
        {shownUnread > 0 ? (
          <span
            aria-hidden="true"
            data-unread-dot
            className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-accent"
          />
        ) : null}
      </span>
      {panel ? createPortal(panel, document.body) : null}
    </>
  )
}

/**
 * One Inbox row; an approval its task still waits on is answered under it, a
 * question is a way to its task, and a task that failed is retried there. The
 * title holds the one left edge; a row in Earlier, where kinds mix, says its
 * state on the right, before its age.
 */
function InboxItem({
  item,
  ask,
  showGlyph,
  onOpen,
  onDismiss,
  onDecide,
  onRetry
}: {
  item: NotificationItem
  ask: PendingAsk | null
  showGlyph: boolean
  onOpen: () => void
  /** Absent for a task still waiting on you: it leaves once answered. */
  onDismiss?: () => void
  onDecide?: (requestId: string, decision: ToolApprovalDecision) => Promise<void>
  onRetry?: () => void
}): ReactNode {
  const command = commandOf(ask)
  return (
    <li className="group relative">
      <button
        type="button"
        data-notification-kind={item.kind}
        className={cn('flex w-full min-w-0 items-start gap-2 px-3 py-2.5 text-left vy-transition focus-visible:vy-focus-ring', ROW_HOVER)}
        onClick={onOpen}
      >
        <span className="min-w-0 flex-1">
          {/* Unread is ink, never weight: the read rows around it are quieter. */}
          <span className={cn('block truncate text-sm', item.read ? 'text-fg' : 'text-fg-strong')}>{item.title}</span>
          {command ? (
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-caption text-fg" data-inbox-command>
              <span className="text-tertiary" aria-hidden>
                $
              </span>
              <span className="min-w-0 truncate">{command}</span>
            </span>
          ) : ask?.kind === 'question' ? (
            <span className="block truncate text-xs text-accent" data-inbox-question>
              {questionAsk(ask.request)}
            </span>
          ) : item.body ? (
            <span className="block truncate text-xs text-muted">{item.body}</span>
          ) : null}
        </span>
        {item.read ? null : (
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent group-focus-within:invisible group-hover:invisible">
            <span className="sr-only">Unread</span>
          </span>
        )}
        {showGlyph ? (
          <span className="mt-0.5 flex shrink-0">
            <NotificationGlyph item={item} />
          </span>
        ) : null}
        <span className="shrink-0 font-mono text-caption text-tertiary tnum group-focus-within:invisible group-hover:invisible">
          {relativeTime(item.createdAt)}
        </span>
      </button>
      {onDismiss ? (
        <span className="absolute right-2 top-2 hidden group-focus-within:block group-hover:block">
          <IconButton icon="close" label={`Dismiss ${item.title}`} size="xs" tone="muted" onClick={onDismiss} />
        </span>
      ) : null}
      {ask?.kind === 'approval' && onDecide ? (
        <RowDecision
          // One per request: the next ask gets its buttons back.
          key={ask.request.requestId}
          title={item.title}
          // On the title's edge.
          className="pb-2.5 pl-3 pr-3"
          onDecide={(decision) => onDecide(ask.request.requestId, decision)}
        />
      ) : null}
      {ask?.kind === 'question' ? (
        // A question is answered in its task, where the choices are: this is the way there.
        <div className="pb-2.5 pl-3 pr-3" data-inbox-answer>
          <Button size="xs" variant="primary" aria-label={`Answer ${item.title}`} onClick={onOpen}>
            Answer
          </Button>
        </div>
      ) : null}
      {onRetry ? (
        // On the title's edge, as Allow once and Deny are.
        <div className="pb-2.5 pl-3 pr-3" data-inbox-retry>
          <Button size="xs" variant="secondary" icon="retry" aria-label={`Retry ${item.title}`} onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
    </li>
  )
}
