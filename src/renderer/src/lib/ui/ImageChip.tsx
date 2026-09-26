import { IconButton } from './IconButton'
import { cn } from './cn'

/**
 * An image attachment: a 40px thumbnail that opens it, and a remove button.
 *
 * The frame does not clip. The thumbnail rounds itself instead, so the open
 * button's focus ring can draw outside it rather than being cut off.
 */
export function ImageChip({
  url,
  label,
  onRemove,
  onClick,
  disabled
}: {
  url: string
  label: string
  onRemove?: () => void
  onClick?: () => void
  disabled?: boolean
}) {
  const thumb = (
    <img
      src={url}
      alt={label}
      className="size-10 rounded-[calc(var(--vy-radius-md)-1px)] object-cover"
      loading="lazy"
      decoding="async"
    />
  )
  return (
    <span
      className={cn('inline-flex items-center rounded-md border border-border bg-surface', onRemove && 'pr-0.5')}
      title={label}
    >
      {onClick ? (
        <button
          type="button"
          className="inline-grid shrink-0 rounded-[calc(var(--vy-radius-md)-1px)] focus-visible:vy-focus-ring"
          aria-label={label}
          onClick={onClick}
        >
          {thumb}
        </button>
      ) : (
        thumb
      )}
      {onRemove ? (
        <IconButton
          icon="close"
          label={`Remove ${label}`}
          size="xs"
          tone="muted"
          className="ml-0.5"
          disabled={disabled}
          onClick={onRemove}
        />
      ) : null}
    </span>
  )
}
