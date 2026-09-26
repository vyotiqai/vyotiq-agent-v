import { type ReactNode } from 'react'
import { Icon } from '../icons'
import { IconButton } from './IconButton'
import { cn } from './cn'

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g

/** Split plain text so http(s) URLs become clickable external links. */
export function linkifyAlertText(text: string, onOpenUrl: (url: string) => void): ReactNode {
  const nodes: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  const re = new RegExp(URL_RE.source, 'g')
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const url = match[0]
    nodes.push(
      <button
        key={`${match.index}:${url}`}
        type="button"
        className="rounded-sm underline underline-offset-2 vy-transition hover:text-fg focus-visible:vy-focus-ring"
        onClick={() => onOpenUrl(url)}
      >
        {url}
      </button>
    )
    last = match.index + url.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes.length === 1 ? nodes[0]! : nodes
}

/**
 * An error or a notice, inline with the surface it belongs to. Danger sits on
 * the danger tint; info is outlined, so its buttons and dismiss keep their own
 * hover fill. Each leads with an icon, so the tone never rests on hue alone.
 *
 * The body is a block: pass buttons that act on the alert as `actions` rather
 * than laying them out inside `children` — `className` cannot re-align this
 * row, because cn() has no merge and `items-start` is already on it.
 */
export function Alert({
  children,
  variant = 'danger',
  onDismiss,
  dismissLabel = 'Dismiss',
  actions,
  className = ''
}: {
  children: ReactNode
  variant?: 'danger' | 'info'
  onDismiss?: () => void
  dismissLabel?: string
  /** Buttons after the text; they wrap under it when the row is narrow. */
  actions?: ReactNode
  className?: string
}) {
  const danger = variant === 'danger'
  const body =
    typeof children === 'string'
      ? linkifyAlertText(children, (url) => {
          void window.vyotiq?.shellOpenExternal?.(url)
        })
      : children

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md px-2.5 py-1.5 text-sm [overflow-wrap:anywhere]',
        danger ? 'bg-danger-soft text-danger' : 'border border-border text-secondary',
        className
      )}
      role={danger ? 'alert' : 'status'}
    >
      {/* 14px on the 20px body line: 3px above centres it on the first line. */}
      <Icon name={danger ? 'warning' : 'info'} size={14} className="mt-[3px] shrink-0" />
      {actions ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-1.5">
          <div className="min-w-0 flex-[1_1_12rem]">{body}</div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>
        </div>
      ) : (
        <div className="m-0 min-w-0 flex-1">{body}</div>
      )}
      {onDismiss ? (
        // `inherit`: the icon takes the alert's own colour, and the tone's one
        // hover fill is the only one on the button.
        <IconButton
          icon="close"
          label={dismissLabel}
          size="sm"
          tone="inherit"
          className="-my-0.5"
          onClick={onDismiss}
        />
      ) : null}
    </div>
  )
}

/** Persistent inline alert without dismiss — e.g. settings errors. */
export function AlertBlock({
  children,
  className = ''
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <p
      className={cn(
        'm-0 rounded-md border border-danger/25 bg-surface px-2.5 py-2 text-xs text-danger [overflow-wrap:anywhere]',
        className
      )}
      role="alert"
    >
      {children}
    </p>
  )
}
