import type { ReactNode } from 'react'
import { useExpandMotion } from './useExpandMotion'

/** Height-animated disclosure shell for tool group lists and tool bodies. */
export function ExpandPanel({
  open,
  children
}: {
  open: boolean
  children: ReactNode
}) {
  const { mounted, dataOpen, onTransitionEnd } = useExpandMotion(open)
  if (!mounted) return null
  return (
    <div
      className="tool-expand"
      data-open={dataOpen ? 'true' : 'false'}
      // Keep clipped content out of tab order / a11y tree while closing or closed.
      // Use intended `open` (not animated dataOpen) so expand is not briefly aria-hidden.
      inert={!open ? true : undefined}
      aria-hidden={!open ? true : undefined}
      onTransitionEnd={onTransitionEnd}
    >
      <div className="tool-expand-inner">{children}</div>
    </div>
  )
}
