import { useEffect, useRef, useState } from 'react'

/*
  Streaming, shared by the store (when to settle a turn) and the reply (how
  much of it to show). Both read the same clock — the moment the answer began
  — so a remount, a thread switch or a second pane never restarts the text.
*/

const CHARS_PER_SECOND = 140

/** How long an answer of this length takes to stream in. */
export function streamDuration(text: string): number {
  return Math.min(7000, Math.max(900, (text.length / CHARS_PER_SECOND) * 1000))
}

/*
  Arrival and reveal are two different things. A model's text lands in
  bursts — nothing for 200ms, then forty characters at once — and showing
  it as it lands reads as a stutter. So the mockup's arrival is bursty on
  purpose (`arrivedLength`), and the reply drains whatever has arrived over
  a quarter second (`useReveal`): a big burst speeds the reveal up, a lull
  lets it catch up and wait. Every cut lands on a word boundary.
*/

const DRAIN_MS = 250
const COMMIT_MS = 33

/** Burst boundaries for a text: irregular gaps of 40–260ms, the same every time for the same text. */
const bursts = new Map<number, number[]>()
function burstTimes(length: number): number[] {
  const hit = bursts.get(length)
  if (hit) return hit
  const total = streamDuration('x'.repeat(length))
  const out: number[] = []
  let seed = length * 9301 + 49297
  for (let t = 0; t < total; ) {
    seed = (seed * 9301 + 49297) % 233280
    t += 40 + (seed / 233280) * 220
    out.push(Math.min(t, total))
  }
  bursts.set(length, out)
  return out
}

/** The end of the word `at` falls in. */
function wordEnd(text: string, at: number): number {
  if (at >= text.length) return text.length
  const space = text.indexOf(' ', at)
  const line = text.indexOf('\n', at)
  const next = [space, line].filter((n) => n >= 0)
  return next.length ? Math.min(...next) : text.length
}

/** How much of `text` had arrived `elapsed` ms in — in bursts, cut at a word boundary. */
export function arrivedLength(text: string, elapsed: number): number {
  const total = streamDuration(text)
  if (elapsed >= total) return text.length
  const times = burstTimes(text.length)
  let landed = 0
  for (const t of times) if (t <= elapsed) landed = t
  return wordEnd(text, Math.floor(text.length * (landed / total)))
}

/** Everything, once the stream has closed; otherwise what has arrived so far. */
const goalOf = (text: string, start: number | undefined): number => (start == null ? text.length : arrivedLength(text, Date.now() - start))

const reducedMotion = (): boolean => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * The visible part of a streaming answer. Drains what has arrived over
 * DRAIN_MS on animation frames, committing at most ~30 times a second (the
 * markdown parse, not the reveal, is the cost), and stops once whole — a
 * settled answer costs nothing. With reduced motion, text shows as it lands.
 */
export function useReveal(text: string, start: number | undefined): { shown: string; streaming: boolean } {
  const [n, setN] = useState(() => goalOf(text, start))
  const shown = useRef(n)

  useEffect(() => {
    shown.current = Math.min(shown.current, text.length)
    if (shown.current >= text.length && start == null) return
    let raf = 0
    let last = performance.now()
    let committed = last
    const tick = (now: number): void => {
      const goal = goalOf(text, start)
      const backlog = goal - shown.current
      if (backlog > 0) {
        const step = reducedMotion() ? backlog : Math.max(1, Math.ceil((backlog * (now - last)) / DRAIN_MS))
        shown.current = Math.min(goal, wordEnd(text, shown.current + step))
      }
      last = now
      const whole = shown.current >= text.length
      if (whole || now - committed >= COMMIT_MS) {
        committed = now
        setN(shown.current)
      }
      if (!whole) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [text, start])

  const at = Math.min(n, text.length)
  return { shown: text.slice(0, at), streaming: at < text.length }
}

/** A clock that ticks once a second while `on`, for live elapsed times. */
export function useSeconds(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [on])
  return now
}

/** "2:07" — a live run's clock; the settled form is fmtSecs's "2m 7s". */
export function fmtClock(secs: number): string {
  const s = Math.max(0, Math.floor(secs))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}
