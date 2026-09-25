import type { ReactNode } from 'react'
import { Icon, type IconName } from '../icons'
import { Keys } from './Kbd'

/**
 * What sits inside one menu row: a mark, the label with its muted detail on the
 * same line, then quiet trailing text, keycaps or a chevron. The row element
 * itself (option, button, menuitem) and its fill belong to the caller —
 * `MENU_ROW` plus one of the active/idle and text classes.
 */
export function MenuItemBody({
  icon,
  lead,
  label,
  detail,
  hint,
  keys,
  trailing
}: {
  icon?: IconName
  /** Anything in the icon slot: a status glyph, a file icon, a brand mark. */
  lead?: ReactNode
  label: ReactNode
  /** Muted text after the label, on the same line. */
  detail?: ReactNode
  /** Right-aligned quiet text. */
  hint?: ReactNode
  keys?: readonly string[]
  trailing?: ReactNode
}) {
  return (
    <>
      {lead ?? (icon ? <Icon name={icon} size={15} className="shrink-0 text-muted" /> : null)}
      {/* The label keeps its width; the detail gives way first. */}
      <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
        <span className="max-w-full shrink-0 truncate text-sm">{label}</span>
        {detail ? <span className="min-w-0 truncate text-xs text-muted">{detail}</span> : null}
      </span>
      {hint ? <span className="shrink-0 text-xs text-tertiary">{hint}</span> : null}
      {keys?.length ? <Keys keys={keys} /> : null}
      {trailing}
    </>
  )
}
