import { useEffect, useRef } from 'react'
import type { VoiceSessionState } from '@shared/voiceSession'
import { cn } from '@renderer/lib/ui'

/*
  The orb, drawn at the size it is shown (the shipped one is a 28px icon
  scaled to 96px, so its strokes scale with it and its dashed ring reads as a
  stock spinner). Every state differs in shape or motion, not only colour
  (WCAG 1.4.1), and colours are text tokens through `currentColor`.

    listening   solid disc, slow breath
    hearing     disc and halo follow your voice
    thinking    rings ripple out of the disc
    working     small disc, a dot travels a faint track — away doing the work
    speaking    disc follows its voice, faster ripples
    needs you   accent disc held in a ring that pulses
    muted       hollow ring, slashed
    error       hollow ring, a bar in it
    connecting  hollow ring, breathing
    reconnecting hollow ring, the dot travels its track
*/

const TONE: Record<VoiceSessionState, string> = {
  off: 'text-tertiary',
  connecting: 'text-muted',
  listening: 'text-fg-strong',
  hearing: 'text-accent',
  thinking: 'text-accent',
  working: 'text-fg',
  speaking: 'text-fg-strong',
  waiting_on_you: 'text-accent',
  paused: 'text-tertiary',
  reconnecting: 'text-warning',
  error: 'text-danger'
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

export function Orb({ state, size, level }: { state: VoiceSessionState; size: number; level?: () => number }) {
  const c = size / 2
  const core = useRef<SVGCircleElement>(null)
  const halo = useRef<SVGCircleElement>(null)
  const live = state === 'hearing' || state === 'speaking'

  // The level drives the size in an animation frame, never through React state.
  useEffect(() => {
    const el = core.current
    const ring = halo.current
    if (!el || !live || !level || reducedMotion()) return
    let raf = 0
    let smooth = 0
    const tick = (): void => {
      smooth += (Math.min(1, Math.max(0, level())) - smooth) * 0.22
      el.style.transform = `scale(${(0.86 + smooth * 0.3).toFixed(3)})`
      if (ring) {
        ring.style.transform = `scale(${(0.9 + smooth * 0.22).toFixed(3)})`
        ring.style.opacity = (0.15 + smooth * 0.35).toFixed(3)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      el.style.transform = ''
      if (ring) ring.style.transform = ''
    }
  }, [live, level])

  const hollow = state === 'paused' || state === 'error' || state === 'connecting' || state === 'reconnecting'
  const track = state === 'working' || state === 'reconnecting'
  const ripples = state === 'thinking' || state === 'speaking'
  const stroke = Math.max(1.5, size / 48)
  const coreR = hollow ? size * 0.3 : state === 'working' ? size * 0.2 : size * 0.28
  const trackR = size * 0.42
  const dotR = Math.max(2.5, size * 0.045)

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className={cn('shrink-0 overflow-visible', TONE[state])}
      data-orb={state}
    >
      {ripples
        ? [0, 1, 2].map((i) => (
            <circle
              key={i}
              cx={c}
              cy={c}
              r={size * 0.28}
              fill="none"
              stroke="currentColor"
              strokeWidth={stroke}
              className={state === 'speaking' ? 'vv-ripple-fast' : 'vv-ripple'}
              style={{ animationDelay: `${i * (state === 'speaking' ? 0.47 : 0.8)}s`, transformBox: 'fill-box', transformOrigin: 'center' }}
            />
          ))
        : null}
      {state === 'hearing' ? (
        <circle
          ref={halo}
          cx={c}
          cy={c}
          r={size * 0.4}
          fill="currentColor"
          opacity={0.18}
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        />
      ) : null}
      {track ? (
        <>
          <circle cx={c} cy={c} r={trackR} fill="none" stroke="currentColor" strokeWidth={stroke} opacity={0.22} />
          <g className="vv-orbit" style={{ transformOrigin: `${c}px ${c}px` }}>
            <circle cx={c} cy={c - trackR} r={dotR} fill="currentColor" />
          </g>
        </>
      ) : null}
      {state === 'waiting_on_you' ? (
        <circle
          cx={c}
          cy={c}
          r={size * 0.43}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke * 1.4}
          className="vv-hold"
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        />
      ) : null}
      <circle
        ref={core}
        cx={c}
        cy={c}
        r={coreR}
        fill={hollow ? 'none' : 'currentColor'}
        stroke="currentColor"
        strokeWidth={hollow ? stroke * 1.2 : 0}
        className={cn(state === 'listening' || state === 'connecting' ? 'vv-breathe' : null, live ? 'transition-transform duration-75' : null)}
        style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
      />
      {state === 'paused' ? (
        <line
          x1={c - coreR * 0.75}
          y1={c + coreR * 0.75}
          x2={c + coreR * 0.75}
          y2={c - coreR * 0.75}
          stroke="currentColor"
          strokeWidth={stroke * 1.2}
          strokeLinecap="round"
        />
      ) : null}
      {state === 'error' ? (
        <line x1={c} y1={c - coreR * 0.45} x2={c} y2={c + coreR * 0.25} stroke="currentColor" strokeWidth={stroke * 1.4} strokeLinecap="round" />
      ) : null}
    </svg>
  )
}

/** A stand-in for the mic and speaker levels: speech-like bursts, not a sine. */
export function fakeLevel(): () => number {
  const start = performance.now()
  return () => {
    const t = (performance.now() - start) / 1000
    const syllable = Math.max(0, Math.sin(t * 9.1)) * Math.max(0, Math.sin(t * 2.3 + 0.6))
    const breath = Math.max(0, Math.sin(t * 0.7)) > 0.12 ? 1 : 0.15
    return Math.min(1, syllable * breath * 1.15)
  }
}
