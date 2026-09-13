import { useEffect, useState } from 'react'

/**
 * One shared 1 Hz clock for N live "elapsed" displays (message footers, turn
 * summaries). Previously each mounted row ran its own setInterval, so long
 * transcripts with many live rows kept N timers firing and N re-renders/sec.
 */
type Listener = (nowMs: number) => void

const listeners = new Set<Listener>()
let timer: number | null = null

function ensureTimer(): void {
  if (timer !== null || listeners.size === 0) return
  timer = window.setInterval(() => {
    const now = Date.now()
    for (const listener of listeners) listener(now)
  }, TICK_MS)
}

function releaseTimer(): void {
  if (timer === null) return
  if (listeners.size > 0) return
  window.clearInterval(timer)
  timer = null
}

const TICK_MS = 1_000

export function useSharedNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return undefined
    const listener: Listener = (value) => setNow(value)
    listeners.add(listener)
    ensureTimer()
    setNow(Date.now())
    return () => {
      listeners.delete(listener)
      releaseTimer()
    }
  }, [active])

  return now
}
