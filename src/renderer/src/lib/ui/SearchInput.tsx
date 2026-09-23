import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { Icon } from '../icons'
import { cn } from './cn'
import { Keys } from './Kbd'
import { Tooltip } from './Tooltip'

export const SearchInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
    onClear?: () => void
    clearLabel?: string
    inputClassName?: string
    trailing?: ReactNode
    /** Quieter frameless field for dense chrome (sidebar). */
    tone?: 'default' | 'quiet'
    /** Its shortcut, shown at rest so the key is learnt by looking. */
    keys?: readonly string[]
    /** Omit for the pre-redesign geometry. */
    size?: 'sm' | 'md'
  }
>(function SearchInput(
  {
    className = '',
    inputClassName = '',
    value,
    onClear,
    clearLabel = 'Clear search',
    trailing,
    tone = 'default',
    keys,
    size,
    ...props
  },
  ref
) {
  const showClear = Boolean(onClear && value)

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md focus-within:vy-focus-ring vy-transition',
        size === 'md' ? 'h-8 px-2.5' : size === 'sm' ? 'h-7 px-2' : 'px-2.5',
        tone === 'quiet'
          ? cn(!size && 'min-h-[calc(var(--vy-control-min-h)+0.25rem)]', 'bg-surface')
          : cn(
              !size && 'min-h-[var(--vy-control-min-h)]',
              'border border-border bg-bg hover:border-border-strong focus-within:border-border-strong'
            ),
        className
      )}
    >
      <Icon name="search" size={14} className="shrink-0 text-tertiary" />
      <input
        ref={ref}
        data-vy-text-entry
        className={cn(
          'w-full min-w-0 border-none bg-transparent text-fg outline-none placeholder:text-tertiary',
          size === 'sm' ? 'text-xs' : 'text-sm',
          size
            ? ''
            : tone === 'quiet'
              ? 'min-h-[calc(var(--vy-control-min-h)+0.25rem)] py-2'
              : 'min-h-[var(--vy-control-min-h)]',
          inputClassName
        )}
        value={value}
        {...props}
      />
      {showClear ? (
        <Tooltip content={clearLabel}>
          <button
            type="button"
            className={cn(
              'inline-grid size-6 shrink-0 place-items-center rounded-md text-muted vy-transition',
              tone === 'quiet'
                ? 'hover:text-fg active:opacity-80'
                : 'hover:bg-surface-2 hover:text-fg active:bg-surface'
            )}
            aria-label={clearLabel}
            onClick={onClear}
          >
            <Icon name="close" size={14} />
          </button>
        </Tooltip>
      ) : null}
      {keys && !showClear ? <Keys keys={keys} /> : null}
      {trailing}
    </div>
  )
})
