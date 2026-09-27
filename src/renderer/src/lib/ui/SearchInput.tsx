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
    /** Its shortcut, shown at rest so the key is learnt by looking. */
    keys?: readonly string[]
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
    keys,
    size = 'md',
    ...props
  },
  ref
) {
  const showClear = Boolean(onClear && value)

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border border-border bg-bg focus-within:vy-focus-ring vy-transition',
        'hover:border-border-strong focus-within:border-border-strong',
        size === 'md' ? 'h-8 px-2.5' : 'h-7 px-2',
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
          inputClassName
        )}
        value={value}
        {...props}
      />
      {showClear ? (
        <Tooltip content={clearLabel}>
          <button
            type="button"
            className="inline-grid size-5 shrink-0 place-items-center rounded-sm text-tertiary vy-transition hover:bg-surface-2 hover:text-fg focus-visible:vy-focus-ring"
            aria-label={clearLabel}
            onClick={onClear}
          >
            <Icon name="close" size={13} />
          </button>
        </Tooltip>
      ) : null}
      {keys && !showClear ? <Keys keys={keys} /> : null}
      {trailing}
    </div>
  )
})
