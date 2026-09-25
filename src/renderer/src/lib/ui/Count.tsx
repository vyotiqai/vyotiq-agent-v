import { cn } from './cn'

/** A number that sits after a label: "Changes 4". Quiet unless it asks for you. */
export function Count({ n, tone = 'quiet' }: { n: number | string; tone?: 'quiet' | 'accent' }) {
  return (
    <span
      className={cn(
        'font-mono tnum',
        tone === 'accent'
          ? 'inline-grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-2xs font-semibold text-accent-fg'
          : 'text-caption text-tertiary'
      )}
    >
      {n}
    </span>
  )
}

/** "+108 −15" — the sign carries the meaning, the hue only reinforces it. */
export function DiffStat({ add, del, className }: { add: number; del: number; className?: string }) {
  return (
    <span className={cn('inline-flex gap-1.5 font-mono text-caption tnum', className)}>
      {add > 0 ? <span className="text-success">+{add}</span> : null}
      {del > 0 ? <span className="text-danger">−{del}</span> : null}
      {add === 0 && del === 0 ? <span className="text-tertiary">±0</span> : null}
    </span>
  )
}
