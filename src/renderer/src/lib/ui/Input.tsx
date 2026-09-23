import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from './cn'

const fieldChrome = cn(
  'rounded-md border border-border bg-bg text-fg placeholder:text-tertiary',
  'hover:border-border-strong',
  'focus-visible:border-border-strong focus-visible:vy-focus-ring',
  'disabled:vy-disabled-state disabled:hover:border-border',
  'vy-transition'
)

/** The geometry fields had before sizes existed; used when no `size` is given. */
const legacyGeometry = 'min-h-[var(--vy-control-min-h)] px-[var(--vy-control-px)] text-sm'

const sizes = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-8 px-3 text-sm'
} as const

/**
 * Shared native `<select>` chrome — mirrors {@link Input}. Width is left to
 * the caller.
 */
export const selectClass = cn(fieldChrome, legacyGeometry)

export const Input = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & { size?: keyof typeof sizes; mono?: boolean }
>(function Input({ className = '', size, mono = false, ...props }, ref) {
  return (
    <input
      ref={ref}
      data-vy-text-entry
      className={cn('w-full', fieldChrome, size ? sizes[size] : legacyGeometry, mono && 'font-mono', className)}
      {...props}
    />
  )
})
