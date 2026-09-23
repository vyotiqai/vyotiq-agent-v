import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@renderer/lib/ui'

export type ChoiceCardOption = {
  value: string
  label: string
  /** One short line under the label. */
  description?: string
  /** Colour chip shown left of the label (skin previews). */
  swatchStyle?: CSSProperties
}

/**
 * A radio group drawn as cards, for the two choices worth seeing all of at
 * once: the skin picker (each option carries a swatch) and navigation mode
 * (each carries a sentence). Both were hand-rolled with the same six
 * selected/unselected classes, which is how they ended up one token apart.
 *
 * Anything without a preview to show belongs in a `Menu` instead — a card grid
 * of plain words is just a taller dropdown.
 */
export function ChoiceCards({
  label,
  value,
  options,
  disabled,
  columns = 'auto',
  onChange
}: {
  label: string
  value: string
  options: readonly ChoiceCardOption[]
  disabled?: boolean
  /** `auto` wraps to content; `grid` lays out 2 columns, 3 from `sm`. */
  columns?: 'auto' | 'grid'
  onChange: (value: string) => void
}): ReactNode {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        columns === 'grid' ? 'grid grid-cols-2 gap-2 sm:grid-cols-3' : 'flex flex-wrap gap-2'
      )}
    >
      {options.map((option) => {
        const selected = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            aria-label={option.label}
            onClick={() => {
              if (!selected) onChange(option.value)
            }}
            className={cn(
              'flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-2 text-left text-sm vy-transition',
              'focus-visible:vy-focus-ring',
              'disabled:vy-disabled-state',
              // The cards sit on a settings card that is already bg-surface,
              // so a surface fill would be invisible — step to surface-2.
              selected
                ? 'border-fg bg-surface-2 text-fg-strong'
                : 'border-border text-secondary hover:bg-surface-2 hover:text-fg'
            )}
          >
            {option.swatchStyle ? (
              <span
                className="size-6 shrink-0 rounded-md border border-border"
                style={option.swatchStyle}
                aria-hidden
              />
            ) : null}
            <span className="min-w-0">
              <span className="block font-medium leading-tight">{option.label}</span>
              {option.description ? (
                <span className="block text-caption text-muted">{option.description}</span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}
