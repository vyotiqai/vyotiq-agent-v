import type { ReactNode } from 'react'
import { cn } from './cn'

/** One keycap. Shortcuts render as a row of these: <Kbd>Ctrl</Kbd><Kbd>K</Kbd>. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-grid h-[18px] min-w-[18px] place-items-center rounded-sm border border-border bg-card px-1 font-mono text-2xs leading-none text-muted',
        className
      )}
    >
      {children}
    </kbd>
  )
}

/** A chord as keycaps, so the key is learnt by looking. */
export function Keys({ keys, className }: { keys: readonly string[]; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </span>
  )
}
