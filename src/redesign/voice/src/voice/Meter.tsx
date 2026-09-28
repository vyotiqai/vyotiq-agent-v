import { useEffect, useState } from 'react'
import { cn } from '@renderer/lib/ui'

/*
  The level meter: the last few seconds of loudness, newest on the right.

  It replaces the old waveform — a 96-sample time-domain frame redrawn every
  50 ms, auto-gained, in four selectable styles. That frame answers "is the
  mic alive right now"; a rolling envelope answers that *and* shows your pauses,
  which is what you look at when deciding whether a take is finished. One
  style, so the Waveform setting goes.
*/

export const METER_BARS = 28

/** A speech-shaped envelope: phrases of syllables with short gaps between. */
export function speechEnvelope(seed: number, n = METER_BARS): number[] {
  let s = seed * 9301 + 49297
  const rnd = (): number => {
    s = (s * 9301 + 49297) % 233280
    return s / 233280
  }
  const out: number[] = []
  let phrase = 0
  for (let i = 0; i < n; i++) {
    if (phrase === 0) phrase = rnd() < 0.2 ? -Math.ceil(rnd() * 3) : Math.ceil(3 + rnd() * 7)
    if (phrase < 0) {
      out.push(0.04 + rnd() * 0.04)
      phrase += 1
    } else {
      out.push(0.25 + rnd() * 0.75)
      phrase -= 1
    }
  }
  return out
}

export function flatEnvelope(n = METER_BARS): number[] {
  return Array.from({ length: n }, (_, i) => 0.05 + ((i * 7) % 3) * 0.01)
}

/**
 * Static bars. `tone` follows what the take is doing: accent while it hears
 * you, tertiary when it hears nothing or has stopped listening.
 */
export function Meter({
  samples,
  tone = 'live',
  className
}: {
  samples: readonly number[]
  tone?: 'live' | 'quiet'
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn('flex h-4 w-[110px] shrink-0 items-center gap-[2px]', tone === 'live' ? 'text-accent' : 'text-tertiary', className)}
    >
      {samples.map((v, i) => (
        <span
          key={i}
          className="w-[2px] shrink-0 rounded-full bg-current"
          style={{ height: `${Math.max(2, Math.round(Math.min(1, v) * 16))}px` }}
        />
      ))}
    </span>
  )
}

/** The meter, scrolling — in the viewer only; a bare (screenshot) frame holds still. */
export function LiveMeter({ seed = 1, className }: { seed?: number; className?: string }) {
  const still = new URLSearchParams(window.location.search).get('bare') === '1'
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (still || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const id = window.setInterval(() => setTick((t) => t + 1), 110)
    return () => window.clearInterval(id)
  }, [still])
  const tape = speechEnvelope(seed, METER_BARS + 400)
  const at = tick % 400
  return <Meter samples={tape.slice(at, at + METER_BARS)} className={className} />
}
