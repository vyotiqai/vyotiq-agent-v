import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { cn } from '@renderer/lib/ui'

/*
  How a view moves. Two rules keep it honest:
    - Only a view that was written while you watched animates. One read from
      history, or remounted by scrolling, is drawn still.
    - A reply that reshapes an earlier view starts from that view: what it
      kept stays still, what is new rises in, what it dropped folds away, and
      a value it changed washes once — after the reply has finished, never
      while a number is still being written.
*/

export type ViewMotion = {
  /** Written while you watched (it was streaming when it mounted). */
  live: boolean
  /** The stream has closed; changed values may wash now. */
  settled: boolean
}

const MotionContext = createContext<ViewMotion>({ live: false, settled: true })
export const MotionProvider = MotionContext.Provider
export const useViewMotion = (): ViewMotion => useContext(MotionContext)

/** Stable keys from optional ids: a model may leave them out or repeat them. */
export function keyed<T>(items: readonly T[], keyOf: (item: T, index: number) => string | undefined, prefix: string): Array<{ item: T; key: string }> {
  const seen = new Map<string, number>()
  return items.map((item, i) => {
    const base = keyOf(item, i) || `${prefix}${i}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return { item, key: n === 0 ? base : `${base}#${n}` }
  })
}

export type Present<T> = { item: T; key: string; leaving: boolean; enters: boolean; order: number }

/**
 * Keyed list presence. `baseline` is what an earlier copy of this view held:
 * keys found there do not rise. Keys it held that this copy has not written
 * stay where they were while it streams — they may simply not be written
 * yet — and fold away once, after the stream closes, if it never did.
 */
export function usePresence<T>(list: Array<{ item: T; key: string }>, baseline: Array<{ item: T; key: string }> | null, ms = 240): Present<T>[] {
  const { live, settled } = useViewMotion()
  const [kept] = useState<ReadonlySet<string>>(() => new Set((baseline ?? []).map((b) => b.key)))
  const [swept, setSwept] = useState(false)
  const [gone, setGone] = useState<Array<{ item: T; key: string; index: number }>>([])
  if (live && settled && !swept) {
    setSwept(true)
    const now = new Set(list.map((l) => l.key))
    const removed = (baseline ?? []).flatMap((b, index) => (now.has(b.key) ? [] : [{ ...b, index }]))
    if (removed.length > 0) setGone(removed)
  }
  useEffect(() => {
    if (gone.length === 0) return
    const t = window.setTimeout(() => setGone([]), ms)
    return () => window.clearTimeout(t)
  }, [gone, ms])
  const out: Present<T>[] = list.map((l, i) => ({ ...l, leaving: false, enters: live && !kept.has(l.key), order: i }))
  // Still being written: what the earlier copy held and this one has not
  // reached yet keeps its place, so an update never empties the view first.
  if (live && !settled && baseline) {
    const now = new Set(list.map((l) => l.key))
    baseline.forEach((b, index) => {
      if (!now.has(b.key)) out.splice(Math.min(index, out.length), 0, { item: b.item, key: b.key, leaving: false, enters: false, order: index })
    })
  }
  for (const g of gone) {
    if (out.some((o) => o.key === g.key)) continue
    out.splice(Math.min(g.index, out.length), 0, { item: g.item, key: g.key, leaving: true, enters: false, order: g.index })
  }
  return out
}

/** One arriving or leaving thing. Something that stays never replays its rise. */
export function Presence({ p, children, className }: { p: Present<unknown>; children: ReactNode; className?: string }) {
  if (p.leaving)
    return (
      // Inert as well as hidden: a button folding away must not take a click or focus.
      <div className={cn('vy-view-leave', className)} aria-hidden inert>
        <div>{children}</div>
      </div>
    )
  const style: CSSProperties | undefined = p.enters ? { animationDelay: `${Math.min(p.order, 6) * 40}ms` } : undefined
  return (
    <div className={cn(p.enters && 'vy-view-rise', className)} style={style}>
      {children}
    </div>
  )
}

/** A value an earlier copy of this view showed differently washes once, when the reply settles. */
export function Changed({ value, from, className }: { value: string; from?: string; className?: string }) {
  const { live, settled } = useViewMotion()
  const wash = live && settled && from !== undefined && from !== value
  return (
    <span key={wash ? 'changed' : 'same'} className={cn(className, wash && 'vy-view-changed')}>
      {value}
    </span>
  )
}
