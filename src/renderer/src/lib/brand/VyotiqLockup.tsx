import { cn } from '@renderer/lib/ui/cn'
import { VyotiqMark } from './VyotiqMark'
import { VyotiqWordmark } from './VyotiqWordmark'

/** Horizontal mark + VYOTIQ. Mark size is the hexagon; type tracks identity ratios. */
export function VyotiqLockup({
  markSize = 36,
  className
}: {
  markSize?: number
  className?: string
}) {
  const typeH = markSize * 0.46
  const gap = markSize * (56 / 164)
  return (
    <div
      className={cn('inline-flex items-center text-fg', className)}
      style={{ gap }}
      data-brand-lockup=""
      role="img"
      aria-label="Vyotiq"
    >
      <VyotiqMark size={markSize} decorative />
      <VyotiqWordmark height={typeH} />
    </div>
  )
}
