import { forwardRef, type TextareaHTMLAttributes } from 'react'
import { cn } from './cn'

/** The same field chrome as {@link Input}, so a textarea under an input reads as one form. */
const fieldChrome = cn(
  'block w-full resize-none rounded-md border border-border bg-bg py-1.5 text-fg placeholder:text-tertiary',
  'hover:border-border-strong',
  'focus-visible:border-border-strong focus-visible:vy-focus-ring',
  'disabled:vy-disabled-state disabled:hover:border-border',
  'vy-transition'
)

/** Input's horizontal padding per size, so stacked fields share one text edge. */
const sizes = {
  sm: 'px-2.5 text-xs',
  md: 'px-3 text-sm'
} as const

/**
 * A multi-line form field. Height comes from `rows` (three by default); the
 * size sets the type and the inset, never a class appended by the caller —
 * `cn()` cannot override a size.
 */
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { size?: keyof typeof sizes; mono?: boolean }
>(function Textarea({ className = '', size = 'md', mono = false, rows = 3, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      data-vy-text-entry
      className={cn(fieldChrome, sizes[size], mono && 'font-mono', className)}
      rows={rows}
      {...props}
    />
  )
})
