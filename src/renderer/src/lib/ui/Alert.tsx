import { type ReactNode } from 'react'
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
        className="underline underline-offset-2 vy-transition hover:text-fg"
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

export function Alert({
  children,
  variant = 'danger',
  onDismiss,
  dismissLabel = 'Dismiss',
  className = ''
}: {
  children: ReactNode
  variant?: 'danger' | 'info'
  onDismiss?: () => void
  dismissLabel?: string
  className?: string
}) {
  const body =
    typeof children === 'string'
      ? linkifyAlertText(children, (url) => {
          void window.vyotiq?.shellOpenExternal?.(url)
        })
      : children

  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-sm [overflow-wrap:anywhere]',
        variant === 'danger' && 'border-danger/25 bg-surface text-danger',
        variant === 'info' && 'border-border bg-surface text-secondary',
        className
      )}
      role={variant === 'info' ? 'status' : 'alert'}
    >
      <div className="m-0 min-w-0 flex-1">{body}</div>
      {onDismiss ? (
        <IconButton
          icon="close"
          label={dismissLabel}
          size="sm"
          className={cn(
            'shrink-0 hover:bg-surface-2',
            variant === 'danger' ? 'text-danger' : 'text-muted'
          )}
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
