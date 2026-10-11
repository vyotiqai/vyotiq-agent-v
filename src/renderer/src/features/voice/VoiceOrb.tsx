import { useEffect, useRef } from 'react'
import type { VoiceSessionState } from '@shared/voiceSession'
import { cn } from '@renderer/lib/ui'

/*
  The orb (docs/voice-mode.md §13.3): the one living thing in the voice bar.
  Every state differs in shape or motion, not only colour (WCAG 1.4.1), and
  colours are text tokens drawn through `currentColor`, so all five skins ×
  light/dark work without a literal. The level-driven scale is written to the
  DOM in an animation frame, not through React state, so it costs no renders.
*/

const TONE: Record<VoiceSessionState, string> = {
  off: 'text-tertiary',
  connecting: 'text-muted',
  listening: 'text-muted',
  hearing: 'text-accent',
  thinking: 'text-accent',
  working: 'text-muted',
  speaking: 'text-fg-strong',
  waiting_on_you: 'text-accent',
  paused: 'text-tertiary',
  reconnecting: 'text-warning',
  error: 'text-danger'
}

/** Which level drives the size: yours while you talk, the agent's while it does. */
type LevelSource = () => number

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

export function VoiceOrb({
  state,
  level,
  size = 28
}: {
  state: VoiceSessionState
  /** 0..1, read every frame while hearing or speaking. */
  level?: LevelSource
  size?: number
}) {
  const coreRef = useRef<SVGCircleElement>(null)
  const live = state === 'hearing' || state === 'speaking'

  useEffect(() => {
    const el = coreRef.current
    if (!el || !live || !level || prefersReducedMotion()) {
      if (el) el.style.transform = ''
      return
    }
    let raf = 0
    let smooth = 0
    const tick = (): void => {
      // Ease towards the target so the orb breathes rather than jitters.
      smooth += (Math.min(1, Math.max(0, level())) - smooth) * 0.25
      el.style.transform = `scale(${(0.78 + smooth * 0.42).toFixed(3)})`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      el.style.transform = ''
    }
  }, [live, level])

  const ring = state === 'thinking' || state === 'working' || state === 'reconnecting' || state === 'connecting'
  const hollow = state === 'paused' || state === 'error' || state === 'reconnecting' || state === 'connecting'

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      aria-hidden="true"
      className={cn('shrink-0 overflow-visible', TONE[state])}
      data-voice-orb={state}
    >
      {/* Waiting on you: a second ring, steady. */}
      {state === 'waiting_on_you' ? <circle cx="14" cy="14" r="13" fill="none" stroke="currentColor" strokeWidth="1.5" /> : null}
      {/* Thinking and working: a dashed ring that turns (still under reduced motion). */}
      {ring ? (
        <circle
          cx="14"
          cy="14"
          r="12.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray={state === 'working' ? '3 4' : '8 5'}
          className="origin-center motion-safe:animate-spin [animation-duration:2.4s]"
        />
      ) : null}
      <circle
        ref={coreRef}
        cx="14"
        cy="14"
        r={ring ? 6 : 9}
        fill={hollow ? 'none' : 'currentColor'}
        stroke="currentColor"
        strokeWidth={hollow ? 1.75 : 0}
        className={cn(
          'origin-center',
          // Listening breathes slowly; nothing moves under reduced motion.
          state === 'listening' ? 'motion-safe:animate-live' : null,
          state === 'hearing' || state === 'speaking' ? 'transition-transform duration-75' : null
        )}
        style={{ transformBox: 'fill-box' }}
      />
      {/* Muted: a slash through it. Error: a bar in it. */}
      {state === 'paused' ? <line x1="7" y1="21" x2="21" y2="7" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" /> : null}
      {state === 'error' ? <line x1="14" y1="10" x2="14" y2="16" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" /> : null}
    </svg>
  )
}
