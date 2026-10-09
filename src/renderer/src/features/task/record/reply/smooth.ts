import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '@renderer/lib/utils/motion'

/*
  A model's text lands in bursts — nothing for 200ms, then forty characters
  at once — and showing it as it lands reads as a stutter. The reply drains
  whatever has arrived over a quarter second instead: a big burst speeds the
  reveal up, a lull lets it catch up and wait. Every cut lands on a word
  boundary. Text already there when the reply mounts (a settled run, a
  remount mid-stream) shows at once — nothing is replayed.
*/

const DRAIN_MS = 250
/** The markdown parse, not the reveal, is the cost: commit at most ~30 times a second. */
const COMMIT_MS = 33

/** The end of the word `at` falls in. */
function wordEnd(text: string, at: number): number {
  if (at >= text.length) return text.length
  const space = text.indexOf(' ', at)
  const line = text.indexOf('\n', at)
  const next = [space, line].filter((n) => n >= 0)
  return next.length ? Math.min(...next) : text.length
}

/**
 * The visible part of `text`. `live` stays true until the reveal has caught
 * up with a stream that has ended, so the reply finishes its last words
 * before it renders as settled.
 */
export function useSmoothText(text: string, streaming: boolean): { shown: string; live: boolean } {
  const [n, setN] = useState(text.length)
  const [prev, setPrev] = useState({ text, streaming })
  if (text !== prev.text || streaming !== prev.streaming) {
    setPrev({ text, streaming })
    // Decided here, before the paint, not in an effect after it: a replaced
    // text (a retry, an edit) shows as it is, and so does growth with no
    // stream behind it. A stream's growth — its last burst too — is revealed.
    const grew = text.startsWith(prev.text.slice(0, n))
    const unstreamed = !streaming && !prev.streaming && n >= prev.text.length
    if (text !== prev.text && (!grew || unstreamed || n > text.length)) setN(text.length)
  }
  const at = Math.min(n, text.length)
  const whole = at >= text.length
  // Where the reveal is — ahead of `n` between commits.
  const shown = useRef(text.length)

  useEffect(() => {
    if (whole) {
      shown.current = text.length
      return
    }
    let raf = 0
    let last = performance.now()
    let committed = last
    const tick = (now: number): void => {
      const backlog = text.length - shown.current
      const step = prefersReducedMotion() ? backlog : Math.max(1, Math.ceil((backlog * (now - last)) / DRAIN_MS))
      shown.current = Math.min(text.length, wordEnd(text, shown.current + step))
      last = now
      const done = shown.current >= text.length
      if (done || now - committed >= COMMIT_MS) {
        committed = now
        setN(shown.current)
      }
      if (!done) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [text, whole])

  return { shown: text.slice(0, at), live: streaming || !whole }
}
