import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react'
import { cn } from '@renderer/lib/ui'

/** Chromium 123+ resolves `field-sizing: content` (Electron 43 ships it). */
const FIELD_SIZING_SUPPORTED =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('field-sizing', 'content')

/**
 * Settings textarea that starts at one line and grows with its content up to
 * `maxRows` via `field-sizing: content`; beyond the cap it scrolls. Engines
 * without support (tests, older Chromium) degrade to a fixed-rows box.
 */
export function AutoTextarea({
  maxRows = 6,
  rows,
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { maxRows?: number }) {
  const ref = useRef<HTMLTextAreaElement | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !FIELD_SIZING_SUPPORTED) return
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight)
    const lh = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 20
    el.style.maxHeight = `${Math.round(lh * maxRows + lh / 3)}px`
  }, [maxRows])

  return (
    <textarea
      ref={ref}
      rows={FIELD_SIZING_SUPPORTED ? 1 : (rows ?? 3)}
      className={cn(
        'w-full rounded-md border border-border bg-surface px-[var(--vy-control-px)] py-1.5',
        'text-sm leading-[1.45] text-fg placeholder:text-muted',
        'hover:border-border-strong',
        'focus-visible:border-border-strong focus-visible:vy-focus-ring',
        'disabled:vy-disabled-state disabled:hover:border-border',
        'vy-transition',
        FIELD_SIZING_SUPPORTED ? 'field-sizing-content min-h-[2.25rem] resize-none overflow-y-auto' : '',
        className
      )}
      {...props}
    />
  )
}
