import { Icon } from '../icons'
import { cn } from './cn'
import { Tooltip } from './Tooltip'

export function ImageChip({
  url,
  label,
  onRemove,
  onClick,
  disabled,
  variant = 'thumbnail'
}: {
  url: string
  label: string
  onRemove?: () => void
  onClick?: () => void
  disabled?: boolean
  variant?: 'thumbnail' | 'compact'
}) {
  if (variant === 'compact') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-xl border border-border bg-surface px-1.5 py-0.5 text-xs text-muted',
          onClick && 'cursor-pointer'
        )}
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        onClick={onClick}
        onKeyDown={
          onClick
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onClick()
                }
              }
            : undefined
        }
      >
        <Icon name="image" size={14} />
        {label}
        {onRemove ? (
          <Tooltip content={`Remove ${label}`}>
            <button
              type="button"
              className="text-muted vy-transition hover:text-fg disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]"
              aria-label={`Remove ${label}`}
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation()
                onRemove()
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </Tooltip>
        ) : null}
      </span>
    )
  }

  return (
    <span
      className={cn(
        'inline-flex overflow-hidden rounded-xl border border-border bg-surface',
        onRemove && 'pr-0.5',
        onClick && 'cursor-pointer'
      )}
      title={label}
      aria-label={onClick ? label : undefined}
      onClick={onClick}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onClick()
              }
            }
          : undefined
      }
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <img
        src={url}
        alt={label}
        className="size-10 object-cover"
        loading="lazy"
        decoding="async"
      />
      {onRemove ? (
        <Tooltip content={`Remove ${label}`}>
          <button
            type="button"
            className="grid place-items-center px-1 text-muted vy-transition hover:text-fg disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]"
            aria-label={`Remove ${label}`}
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation()
              onRemove()
            }}
          >
            <Icon name="close" size={12} />
          </button>
        </Tooltip>
      ) : null}
    </span>
  )
}
