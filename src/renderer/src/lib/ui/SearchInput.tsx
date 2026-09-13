import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { Icon } from '../icons'
import { cn } from './cn'
import { Tooltip } from './Tooltip'

export const SearchInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & {
    onClear?: () => void
    clearLabel?: string
    inputClassName?: string
    trailing?: ReactNode
    /** Quieter frameless field for dense chrome (sidebar). */
    tone?: 'default' | 'quiet'
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
    ...props
  },
  ref
) {
  const showClear = Boolean(onClear && value)

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-2.5 focus-within:vy-focus-ring',
        tone === 'quiet'
          ? 'min-h-[calc(var(--vy-control-min-h)+0.25rem)] rounded-md bg-surface/80 focus-within:bg-surface'
          : 'min-h-[var(--vy-control-min-h)] rounded-md border border-border bg-surface focus-within:border-border-strong',
        className
      )}
    >
      <Icon name="search" size={16} className="shrink-0 text-secondary" />
      <input
        ref={ref}
        data-vy-text-entry
        className={cn(
          'w-full border-none bg-transparent text-sm text-fg outline-none placeholder:text-muted',
          tone === 'quiet' ? 'min-h-[calc(var(--vy-control-min-h)+0.25rem)] py-2' : 'min-h-[var(--vy-control-min-h)]',
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
      {trailing}
    </div>
  )
})
