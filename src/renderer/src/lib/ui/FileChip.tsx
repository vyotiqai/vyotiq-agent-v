import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { IconButton } from './IconButton'
import { cn } from './cn'

function shortSize(chars: number): string {
  if (chars < 1000) return `${chars} chars`
  if (chars < 1_000_000) return `${Math.round(chars / 100) / 10}k chars`
  return `${Math.round(chars / 100_000) / 10}M chars`
}

/** A document attachment: name plus extracted size, never the text itself. */
export function FileChip({
  name,
  chars,
  onOpen,
  onRemove,
  disabled
}: {
  name: string
  chars?: number
  onOpen?: () => void
  onRemove?: () => void
  disabled?: boolean
}) {
  const title = chars === undefined ? name : `${name} · ${shortSize(chars)}`
  const label = (
    <>
      <FileTypeIcon path={name} size={14} />
      <span className="truncate">{name}</span>
      {chars !== undefined ? (
        <span className="shrink-0 text-secondary">{shortSize(chars)}</span>
      ) : null}
    </>
  )
  return (
    <span
      className={cn(
        'inline-flex h-6 max-w-56 items-center gap-1 rounded-md border border-border bg-surface text-xs text-muted',
        // The remove button brings its own 20px target; the text side keeps the inset.
        onRemove ? 'pl-1.5 pr-0.5' : 'px-1.5'
      )}
      title={title}
    >
      {onOpen ? (
        <button
          type="button"
          className={cn(
            'inline-flex min-w-0 items-center gap-1 rounded-sm text-left text-muted',
            'underline-offset-2 vy-transition hover:text-fg hover:underline focus-visible:vy-focus-ring',
            'disabled:vy-disabled-state'
          )}
          disabled={disabled}
          onClick={onOpen}
        >
          {label}
        </button>
      ) : (
        label
      )}
      {onRemove ? (
        <IconButton
          icon="close"
          label={`Remove ${name}`}
          size="xs"
          tone="muted"
          disabled={disabled}
          onClick={onRemove}
        />
      ) : null}
    </span>
  )
}
