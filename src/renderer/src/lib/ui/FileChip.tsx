import { Icon } from '@renderer/lib/icons'
import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { cn } from './cn'
import { Tooltip } from './Tooltip'

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
      className="inline-flex max-w-56 items-center gap-1 rounded-xl border border-border bg-surface px-1.5 py-0.5 text-xs text-muted"
      title={title}
    >
      {onOpen ? (
        <button
          type="button"
          className={cn(
            'inline-flex min-w-0 items-center gap-1 text-left text-muted',
            'underline-offset-2 hover:text-fg hover:underline',
            'disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]'
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
        <Tooltip content={`Remove ${name}`}>
          <button
            type="button"
            className="shrink-0 text-muted vy-transition hover:text-fg disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]"
            aria-label={`Remove ${name}`}
            disabled={disabled}
            onClick={onRemove}
          >
            <Icon name="close" size={12} />
          </button>
        </Tooltip>
      ) : null}
    </span>
  )
}
