import { cn } from './cn'

/**
 * One surface for every menu, popover and picker: Menu (select), ActionMenu,
 * ContextMenu, and the composer's pickers.
 *
 * Deliberately split so `cn()` never has to override anything:
 * - `MENU_SURFACE` carries no padding (a search header sits flush against it),
 *   so callers add `p-1` or not.
 * - `MENU_ROW` carries no text colour; each row sets exactly one of
 *   `MENU_ROW_TEXT` / `MENU_ROW_DANGER` / `MENU_ROW_SELECTED`.
 */
export const MENU_SURFACE = 'vy-menu z-dropdown overflow-hidden animate-menu-in'
/**
 * MENU_SURFACE for a list that scrolls. Not MENU_SURFACE + 'overflow-auto':
 * cn() has no tailwind-merge, and overflow-hidden is emitted later, so it wins.
 */
export const MENU_SURFACE_SCROLL = 'vy-menu z-dropdown overflow-auto animate-menu-in'

export const MENU_ROW = cn(
  'flex h-7 w-full cursor-default items-center gap-2 rounded-md px-2 text-left text-sm vy-transition',
  'focus-visible:outline-none'
)

/** Row fill: pointer or keyboard on it. Only one of these is ever applied. */
export const MENU_ROW_ACTIVE = 'bg-surface-2'
export const MENU_ROW_IDLE = 'hover:bg-surface'

export const MENU_ROW_TEXT = 'text-fg'
export const MENU_ROW_DANGER = 'text-danger'
export const MENU_ROW_SELECTED = 'text-fg-strong'

export const MENU_ROW_DISABLED = 'cursor-not-allowed opacity-[var(--vy-disabled-opacity)]'

/** Group label: caps, tracked, quiet — the same style as a section label. */
export const MENU_LABEL =
  'flex h-7 items-center justify-between px-2 text-caption font-semibold uppercase tracking-[var(--vy-tracking-caps)] text-tertiary'

export const MENU_SEPARATOR = '-mx-1 my-1 h-px bg-border'

/**
 * A select's closed state. `bare` drops the outline until hover (toolbars,
 * inline sentences); `quiet` marks a value left at its default.
 */
export function selectTriggerClass({
  bare = false,
  quiet = false,
  mono = false
}: { bare?: boolean; quiet?: boolean; mono?: boolean } = {}): string {
  return cn(
    'inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 text-xs vy-transition hover:bg-surface focus-visible:vy-focus-ring disabled:vy-disabled-state',
    bare ? '' : 'border border-border bg-bg hover:border-border-strong',
    quiet ? 'text-secondary' : 'text-fg',
    mono && 'font-mono'
  )
}
