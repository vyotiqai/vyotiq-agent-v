import { Fragment, createContext, useContext, useEffect, useId, useMemo, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import {
  VOICE_PLACEMENTS,
  type VoiceOptionInfo,
  type VoicePlacement,
  type VoiceSettings,
  type VoiceStyle,
  type VoiceViewLayout,
  type VoiceWork,
  type VoiceWorkStep
} from '@shared/ipc/schemas/voice'
import { clampSpeed, pickVoice, chooseModel, resolveTtsProvider, ttsEntry, type TtsProviderId } from '@shared/voice'
import { Icon, type IconName } from '@renderer/lib/icons'
import { Button, IconButton, Kbd, RadioMark, Segmented, StatusGlyph, Tabs, cn, type TaskState } from '@renderer/lib/ui'
import { BORDER_DIVIDER, CONTROL_HOVER } from '@renderer/lib/utils/layout'
import { prefersReducedMotion } from '@renderer/lib/utils/motion'
import { listMicDevices, listSpeakerDevices } from '@renderer/lib/audio/micCapture'
import { AnimatedOrb } from '../orb/AnimatedOrb'
import { ProblemText, formatTime, sessionNotes, type ShownProblem } from '../VoiceBar'
import { EngineToken as EngineTokenBase, HAND_OFF_FAILED, Result, Steps, WHO, buildEntries, elapsed, stepVerb, workGlyph } from '../view/parts'
import type { VoiceSnapshot } from '../voiceSessionController'
import { exchange, headline, hint, latestWork, type WorkEntry } from './model'

/*
  The redesigned voice view's shared pieces (docs/voice-mode.md §26). Every
  placement is built from these, in the main window and in the mini window,
  so they read the session through `StageContext` rather than the store: the
  main window passes the live controller, the mini window a mirror of it
  whose actions travel back over IPC.

  Two styles over one structure:
  - Quiet: the app's own planes and hairlines; the orb is the one living thing.
  - Ambient: light gathered around the orb on a darkened field, the controls
    on glass (vy-voice-ambient, vy-voice-glass in styles.css).
*/

// ── The session, as every placement reads it ───────────────────────────────

export type ApprovalDecision = 'once' | 'always' | 'deny'

export type StageApi = {
  v: VoiceSnapshot
  settings: VoiceSettings
  startedAt: number | null
  escArmed: boolean
  /** The orb's level 0..1 (its voice while it speaks, yours otherwise); read per frame. */
  level: () => number
  /** Your mic level 0..1; read per frame. */
  micLevel: () => number
  mute: (muted: boolean) => void
  /** Hold to talk (push-to-talk): down while held. */
  hold: (down: boolean) => void
  stopSpeaking: () => void
  stopTask: () => void
  end: () => void
  /** Open the session again after it stopped (Try again). */
  retry?: () => void
  /** Close the placement and show the task ("Show the task", shrink to the pill). */
  showTask?: () => void
  /** Show the placement again (from the pill that stands in while it's put away). */
  openView?: () => void
  openVoiceSettings?: () => void
  openMicSettings?: () => void
  patchSettings: (patch: Partial<VoiceSettings>) => void
  respondApproval: (requestId: string, decision: ApprovalDecision, runId: string) => Promise<{ ok: boolean } | undefined>
  respondQuestion: (requestId: string, questionId: string, value: string, runId: string) => Promise<{ ok: boolean } | undefined>
  /** The voice and device pickers need the main window (voices over IPC, the mic in this renderer); the mini window has none. */
  pickers: boolean
}

export const StageContext = createContext<StageApi | null>(null)

export function useStage(): StageApi {
  const api = useContext(StageContext)
  if (!api) throw new Error('useStage outside a StageContext')
  return api
}

/** What's open over a placement: one of the settings tabs, the history drawer, or nothing. */
export type Pop = 'none' | 'voice' | 'devices' | 'layout' | 'history'
const SETTINGS_TABS: readonly Pop[] = ['voice', 'devices', 'layout']

export const PopContext = createContext<{ pop: Pop; setPop: (p: Pop) => void }>({ pop: 'none', setPop: () => {} })

/** A placement's own popover state; Esc closes it first (the session's Esc handler checks `data-voice-pop`). */
export function usePop(): { pop: Pop; setPop: (p: Pop) => void } {
  const [pop, setPop] = useState<Pop>('none')
  useEffect(() => {
    if (pop === 'none') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setPop('none')
    }
    // Capture, before the session's own Esc (stop speaking, end).
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pop])
  return useMemo(() => ({ pop, setPop }), [pop])
}

/** A second's clock, for the session's time and each run's elapsed. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

/**
 * True after `ms` without the pointer moving or a key going down (focus
 * moving counts as a key).
 */
export function useIdle(ms: number): boolean {
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    let id = window.setTimeout(() => setIdle(true), ms)
    const wake = (): void => {
      setIdle(false)
      window.clearTimeout(id)
      id = window.setTimeout(() => setIdle(true), ms)
    }
    const events = ['pointermove', 'pointerdown', 'keydown', 'focusin'] as const
    for (const e of events) window.addEventListener(e, wake, { passive: true })
    return () => {
      window.clearTimeout(id)
      for (const e of events) window.removeEventListener(e, wake)
    }
  }, [ms])
  return idle
}

/**
 * Move focus into a popover or drawer when it opens (to `selector` inside
 * it), and back to whatever had it when it closes.
 */
function useFocusIn<T extends HTMLElement>(selector: string) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>(selector)?.focus()
    return () => {
      if (before?.isConnected) before.focus()
    }
  }, [selector])
  return ref
}

/**
 * A surface that covers part of the app (Takeover, Inline, the summary):
 * what it covers is made inert while it shows, so Tab and screen readers
 * never walk into controls you can't see, and focus moves onto it if it was
 * under it. Its siblings get their own inert state back when it goes.
 */
export function useCover<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    const parent = el?.parentElement
    if (!el || !parent) return
    const covered = Array.from(parent.children).filter((c): c is HTMLElement => c !== el && c instanceof HTMLElement && !c.hasAttribute('inert'))
    for (const c of covered) c.setAttribute('inert', '')
    const active = document.activeElement
    if (!active || active === document.body || covered.some((c) => c.contains(active))) el.focus({ preventScroll: true })
    return () => {
      for (const c of covered) c.removeAttribute('inert')
    }
  }, [])
  return ref
}

// ── Surfaces ───────────────────────────────────────────────────────────────

/**
 * The ground a placement sits on: the app's page, or Ambient's lit field
 * with its grain. Covering is a prop, not an appended class: cn() has no
 * merge, so an `absolute` beside the base `relative` would lose to emission
 * order and the surface would sit in the flow beside the app.
 */
export function Field({
  children,
  className,
  as = 'div',
  label,
  cover = false
}: {
  children: ReactNode
  className?: string
  as?: 'div' | 'section' | 'aside'
  label?: string
  /** Over its positioned parent, edge to edge, above the content, which it makes inert (Takeover, the summary). */
  cover?: boolean
}) {
  const { settings } = useStage()
  const className_ = cn(cover ? 'absolute inset-0 z-sticky' : 'relative', 'flex min-h-0 min-w-0 flex-col', settings.style === 'ambient' ? 'vy-voice-ambient vy-voice-grain' : 'bg-bg', className)
  if (cover) {
    return (
      <Cover as={as} className={className_} label={label} style={settings.style}>
        {children}
      </Cover>
    )
  }
  const As = as
  return (
    <As className={className_} aria-label={label} data-voice-style={settings.style}>
      {children}
    </As>
  )
}

function Cover({ as: As, className, label, style, children }: { as: 'div' | 'section' | 'aside'; className: string; label?: string; style: VoiceStyle; children: ReactNode }) {
  const ref = useCover<HTMLElement>()
  return (
    <As ref={ref as never} tabIndex={-1} className={cn(className, 'outline-none')} aria-label={label} data-voice-style={style}>
      {children}
    </As>
  )
}

const FLOAT: Record<VoiceStyle, Record<'card' | 'pill', string>> = {
  quiet: { card: 'vy-menu', pill: 'rounded-full bg-bg shadow-menu' },
  ambient: { card: 'vy-voice-glass rounded-xl', pill: 'vy-voice-glass rounded-full' }
}

/**
 * A floating surface: glass in Ambient, a menu plane in Quiet. The shape is
 * a prop, not an appended class: vy-menu sets its own radius, and cn() has
 * no merge, so a rounded-full beside it would lose to emission order.
 */
export function Float({ children, className, shape = 'card' }: { children: ReactNode; className?: string; shape?: 'card' | 'pill' }) {
  const { settings } = useStage()
  return <div className={cn(FLOAT[settings.style][shape], className)}>{children}</div>
}

// ── The orb ────────────────────────────────────────────────────────────────

const HOLD_MS = 250

/**
 * The orb, and a way to talk to it: click it to mute or unmute, press and
 * hold it to talk (push-to-talk; letting go ends the turn). Under 40px, or
 * when there is nothing to mute (stopped, opening), it is only a picture.
 */
export function StageOrb({ size, interactive = true }: { size: number; interactive?: boolean }) {
  const api = useStage()
  const { v, settings } = api
  const timer = useRef(0)
  const held = useRef(false)
  // Set when a hold ends, cleared on the next tick: the click after the pointer-up is the hold's, not a tap.
  const swallow = useRef(false)
  const [holding, setHolding] = useState(false)
  const hintId = useId()
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const orb = <AnimatedOrb look={settings.orbLook} state={v.state} size={size} level={api.level} />
  const dead = v.state === 'error' || v.state === 'connecting' || v.state === 'off'
  if (!interactive || size < 40 || dead) return orb
  const release = (): void => {
    window.clearTimeout(timer.current)
    if (!held.current) return
    held.current = false
    setHolding(false)
    api.hold(false)
    swallow.current = true
    window.setTimeout(() => (swallow.current = false), 0)
  }
  return (
    <button
      type="button"
      // Its own name (Mute is the dock's), pressed while muted; the name never flips (that would say it twice).
      aria-pressed={v.muted}
      aria-label="Orb"
      aria-describedby={hintId}
      title="Click to mute or unmute · press and hold to talk"
      data-voice-orb-button={holding ? 'holding' : v.muted ? 'muted' : 'live'}
      className="shrink-0 cursor-pointer touch-none select-none rounded-full transition-transform duration-200 focus-visible:vy-focus-ring active:scale-[0.97]"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        held.current = false
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => {
          held.current = true
          setHolding(true)
          api.hold(true)
        }, HOLD_MS)
      }}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onClick={() => {
        if (swallow.current) return
        api.mute(!v.muted)
      }}
    >
      {orb}
      <span id={hintId} hidden>
        Click to mute or unmute; press and hold to talk.
      </span>
    </button>
  )
}

/** A mic with a ring opening out from it: you can talk over it now. */
export function InterruptCue() {
  return (
    <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center text-accent" aria-hidden data-voice-interrupt-cue>
      <span className="vy-voice-ping absolute inset-0 rounded-full border border-accent" />
      <Icon name="mic" size={12} />
    </span>
  )
}

/**
 * The voice as a ribbon: three soft waves whose height follows your level
 * while it hears you and its level while it speaks, flat while muted. Drawn
 * on a canvas in an animation frame; its colour is the text colour, so the
 * tone token decides it. One still line under reduced motion.
 */
export function LiveWave({ width, height = 28, className }: { width: number; height?: number; className?: string }) {
  const { v, level } = useStage()
  const state = v.state
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.scale(dpr, dpr)
    const loud = state === 'hearing' || state === 'speaking'
    const resting = state === 'listening' || state === 'thinking' || state === 'working' || state === 'waiting_on_you'
    // Read once, not every frame (a forced style read per frame); again when the skin or theme changes.
    let color = getComputedStyle(canvas).color
    const mo = new MutationObserver(() => (color = getComputedStyle(canvas).color))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin', 'data-theme', 'class'] })
    let raf = 0
    let s = 0
    let t = 0
    let last = performance.now()
    const draw = (): void => {
      ctx.clearRect(0, 0, width, height)
      const mid = height / 2
      // A voice is never a flat line: a floor while someone talks, the level on top.
      const amp = loud ? 0.35 + s * 0.65 : resting ? 0.08 : 0.02
      const waves = [
        { k: 0.045, w: 2.2, a: 1, alpha: 0.95, lw: 1.6 },
        { k: 0.07, w: -3.1, a: 0.65, alpha: 0.5, lw: 1.2 },
        { k: 0.028, w: 1.4, a: 0.45, alpha: 0.3, lw: 1 }
      ]
      for (const wv of waves) {
        ctx.beginPath()
        for (let x = 0; x <= width; x += 2) {
          const env = Math.pow(Math.sin((Math.PI * x) / width), 2)
          const y = mid + Math.sin(x * wv.k + t * wv.w) * amp * wv.a * env * (height / 2 - 1)
          if (x === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.strokeStyle = color
        ctx.globalAlpha = wv.alpha
        ctx.lineWidth = wv.lw
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
    if (prefersReducedMotion()) {
      draw()
      return () => mo.disconnect()
    }
    const tick = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      t += dt * (1 + s * 2)
      s += ((loud ? Math.min(1, Math.max(0, level())) : 0) - s) * Math.min(1, dt * 12)
      draw()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      mo.disconnect()
    }
  }, [state, width, height, level])
  const tone = state === 'error' ? 'text-danger' : state === 'reconnecting' ? 'text-warning' : state === 'paused' || state === 'connecting' ? 'text-tertiary' : 'text-accent'
  return <canvas ref={ref} aria-hidden className={cn('shrink-0', tone, className)} style={{ width, height }} data-voice-wave={state} />
}

/** Your level as four bars inside Mute: proof you're heard before a word comes back. Flat while muted. */
export function MicMeter({ live }: { live: boolean }) {
  const { micLevel } = useStage()
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const bars = [...el.children] as HTMLElement[]
    const weights = [0.55, 1, 0.8, 0.45]
    const set = (l: number): void => bars.forEach((b, i) => (b.style.transform = `scaleY(${(0.3 + weights[i]! * (0.3 + 0.4 * l)).toFixed(3)})`))
    set(0)
    if (!live || prefersReducedMotion()) return
    let raf = 0
    let s = 0
    const tick = (): void => {
      s += (Math.min(1, Math.max(0, micLevel())) - s) * 0.3
      set(s)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [live, micLevel])
  return (
    <span ref={ref} className="flex h-3 items-center gap-px" aria-hidden data-voice-meter={live ? 'live' : 'still'}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="h-3 w-0.5 origin-center rounded-full bg-current" />
      ))}
    </span>
  )
}

// ── Words ──────────────────────────────────────────────────────────────────

/** Who hears and who speaks, as one token that opens Voice settings. */
export function EngineToken() {
  const { v, openVoiceSettings } = useStage()
  return <EngineTokenBase v={v} onOpenVoiceSettings={openVoiceSettings} />
}

/** What's happening in a word, then one line that never repeats the strip. */
export function StateLine({
  size = 'title',
  align = 'center',
  sub,
  escNote = false
}: {
  size?: 'display' | 'title' | 'heading' | 'sm'
  align?: 'center' | 'start'
  sub?: string
  /** This placement shows no keys (Companion, the cards): Esc pressed once is said here instead. */
  escNote?: boolean
}) {
  const { v, settings } = useStage()
  const now = useNow()
  const entry = useMemo(() => latestWork(v), [v])
  const live = v.state === 'thinking' || v.state === 'working' || v.state === 'connecting' || v.state === 'reconnecting'
  const notes = sessionNotes(v)
  const big = size === 'display' ? 'text-display' : size === 'title' ? 'text-title' : size === 'heading' ? 'text-heading' : 'text-sm font-medium'
  const { escArmed } = useStage()
  // Esc pressed once says what the next press does: here where no keys are shown, else in the keys' line (once, never twice).
  const line = escNote && escArmed ? 'Press Esc again to end voice mode' : sub ?? (v.state === 'error' ? (notes.problem?.message ?? 'Voice mode stopped') : hint(v, settings, entry, now))
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', align === 'center' ? 'items-center text-center' : 'items-start')}>
      {/* Announced once, by the layer's own status; this is the picture of it. */}
      <p key={v.state} className={cn('m-0 text-fg-strong motion-safe:animate-fade-in', big)} data-voice-headline>
        {headline(v)}
      </p>
      <p
        className={cn('m-0 flex max-w-full items-center gap-1.5', size === 'sm' ? 'text-xs' : 'text-sm', live ? 'vy-text-live' : v.state === 'error' ? 'text-danger' : 'text-muted')}
        data-voice-subline
      >
        {/* While it speaks, the hint is the way in: talk over it. */}
        {v.state === 'speaking' && !sub ? <InterruptCue /> : null}
        {/* Its own block: an ellipsis needs one, a flex row never shows it. */}
        <span className="min-w-0 truncate">{line}</span>
      </p>
    </div>
  )
}

function FixButtons({ problem, primary }: { problem: ShownProblem; primary: boolean }) {
  const api = useStage()
  const variant = primary ? 'secondary' : 'ghost'
  return (
    <>
      {problem.fix === 'settings' && api.openVoiceSettings ? (
        <Button size="xs" variant={variant} onClick={api.openVoiceSettings}>
          Voice settings
        </Button>
      ) : null}
      {problem.fix === 'mic' && api.openMicSettings ? (
        <Button size="xs" variant={variant} onClick={api.openMicSettings}>
          Open mic settings
        </Button>
      ) : null}
      {problem.fix === 'retry' && api.retry ? (
        <Button size="xs" variant={variant} icon="retry" onClick={api.retry}>
          Try again
        </Button>
      ) : null}
    </>
  )
}

/**
 * What went wrong, with the provider's own reason and the one fix: a problem
 * that ended the session (danger), or trouble it survived (warning).
 */
export function Notice({ align = 'center' }: { align?: 'center' | 'start' }) {
  const { v } = useStage()
  const { problem, trouble } = sessionNotes(v)
  const p = problem ?? trouble
  if (!p) return null
  const ended = Boolean(problem)
  return (
    <div
      className={cn('flex max-w-full flex-wrap items-center gap-x-2 gap-y-1.5 text-xs', align === 'center' ? 'justify-center text-center' : null, ended ? 'text-danger' : 'text-warning')}
      role={ended ? 'alert' : 'status'}
      data-voice-notice={ended ? 'problem' : 'trouble'}
    >
      <Icon name="warningCircle" size={13} className="shrink-0" />
      {/* An ended session's sentence is already the line under the headline: on screen only its reason here, but the alert reads both. */}
      {ended ? (
        <span className="min-w-0">
          <span className="sr-only">{`${p.message} `}</span>
          {p.detail ? <span className="text-muted">{p.detail}</span> : null}
        </span>
      ) : (
        <ProblemText problem={p} />
      )}
      <FixButtons problem={p} primary={ended} />
    </div>
  )
}

/** Characters a second at speed 1, for pacing the word-by-word highlight (the player gives no word times). */
const CHARS_PER_SECOND = 14.5

/**
 * How many words of the piece being spoken have been said: paced from when
 * the piece started to play, at the voice's speed. Reduced motion: all of it.
 */
function useSpokenWords(piece: string, live: boolean, speed: number): number {
  const words = useMemo(() => piece.split(/\s+/).filter(Boolean), [piece])
  const [n, setN] = useState(live && !prefersReducedMotion() ? 0 : words.length)
  useEffect(() => {
    if (!live || prefersReducedMotion()) {
      setN(words.length)
      return
    }
    const start = performance.now()
    // Where each word ends, in characters from the piece's start.
    const ends: number[] = []
    let at = 0
    for (const w of words) {
      at += w.length + 1
      ends.push(at)
    }
    const rate = CHARS_PER_SECOND * Math.max(0.25, speed)
    setN(1)
    const id = window.setInterval(() => {
      const chars = ((performance.now() - start) / 1000) * rate
      const next = ends.findIndex((e) => e > chars) + 1 || words.length
      setN(next)
      if (next >= words.length) window.clearInterval(id)
    }, 80)
    return () => window.clearInterval(id)
  }, [words, live, speed])
  return n
}

/**
 * A reply as it's spoken. The pieces already played are strong; the piece
 * playing now lights word by word, the word being said underlined in the
 * accent, the rest of it waiting. The whole reply is in a screen-reader-only
 * span; the paint is visual.
 */
export function Spoken({ text, piece, live }: { text: string; piece: string; live: boolean }) {
  const { settings } = useStage()
  // The line's words are trimmed and joined with single spaces; the caption may carry edge spaces.
  const p = piece.trim()
  const at = live && p && text.endsWith(p) ? text.length - p.length : text.length
  const said = text.slice(0, at)
  const now = live ? text.slice(at) : ''
  const n = useSpokenWords(now, live && Boolean(now), settings.speed)
  if (!live || !now) return <>{text}</>
  const words = now.split(/\s+/).filter(Boolean)
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden data-voice-spoken={`${n}/${words.length}`}>
        {said}
        {words.map((w, i) => (
          // The space sits outside the word, so the underline is the word's width only.
          <Fragment key={i}>
            {i || said ? ' ' : null}
            <span
              className={cn(
                'transition-colors duration-150',
                i < n - 1 ? 'text-fg-strong' : i === n - 1 ? 'text-fg-strong underline decoration-accent decoration-2 underline-offset-[0.22em]' : 'text-tertiary'
              )}
            >
              {w}
            </span>
          </Fragment>
        ))}
      </span>
    </>
  )
}

/** A reply you talked over, as far as it got: its words, then a dash, dimmed back. */
export function CutReply({ text, className }: { text: string; className?: string }) {
  return (
    <p className={cn('vy-voice-cut m-0 leading-snug text-muted', className)} data-voice-cut>
      {`${text} —`}
      <span className="sr-only"> (cut off: you started talking)</span>
    </p>
  )
}

export type CaptionSize = 'display' | 'title' | 'heading' | 'md'

const VOICE_SIZE: Record<CaptionSize, string> = { display: 'text-display', title: 'text-title', heading: 'text-heading', md: 'text-md' }
/** Your words sit one step down unless you're saying them now. */
const YOU_SIZE: Record<CaptionSize, string> = { display: 'text-heading', title: 'text-md', heading: 'text-md', md: 'text-sm' }

/**
 * The current exchange, as captions: your words, then its answer, spoken
 * word by word. Captions off, a quiet line says it still speaks.
 */
export function Captions({ size = 'heading', align = 'center', lines = 3 }: { size?: CaptionSize; align?: 'center' | 'start'; lines?: 2 | 3 | 4 }) {
  const { v, settings } = useStage()
  if (!settings.captions) {
    return (
      <p className={cn('m-0 text-caption text-tertiary', align === 'center' ? 'text-center' : null)} data-voice-captions="off">
        Captions are off. It still speaks.
      </p>
    )
  }
  const x = exchange(v)
  const cut = v.cutLineId ? v.transcript.find((l) => l.id === v.cutLineId) : undefined
  // The cut reply shows dimmed where it was: in place of the reply, or above the words you're saying over it.
  const cutAbove = cut && x.voiceLineId !== cut.id ? cut : undefined
  if (!x.you && !x.voice && !cutAbove) return null
  const clamp = lines === 2 ? 'line-clamp-2' : lines === 3 ? 'line-clamp-3' : 'line-clamp-4'
  return (
    <div className={cn('flex w-full min-w-0 flex-col gap-3', align === 'center' ? 'items-center text-center' : 'items-start')} aria-live="off" data-voice-captions="on">
      {cutAbove ? <CutReply text={cutAbove.text} className={YOU_SIZE[size]} /> : null}
      {x.you ? (
        <p
          key={`you-${x.live === 'you' ? 'live' : x.you}`}
          className={cn('vy-voice-rise m-0 leading-snug', clamp, x.live === 'you' ? cn(VOICE_SIZE[size], 'text-fg-strong') : cn(YOU_SIZE[size], 'text-muted'))}
          data-voice-caption="you"
        >
          {x.live === 'you' ? null : <span className="mr-1.5 text-caption text-tertiary">{WHO.you}</span>}
          {x.you}
          {x.live === 'you' ? <span className="vy-caret ml-0.5 inline-block h-[1em] w-0.5 translate-y-[0.15em] bg-accent" aria-hidden /> : null}
          {x.unanswered ? <span className="ml-2 text-caption text-tertiary">Not answered</span> : null}
        </p>
      ) : null}
      {x.voice && cut && x.voiceLineId === cut.id ? (
        <CutReply text={x.voice} className={VOICE_SIZE[size]} />
      ) : x.voice ? (
        <p key={`voice-${x.voiceLineId}`} className={cn('vy-voice-rise m-0 leading-snug text-fg-strong', VOICE_SIZE[size], clamp)} data-voice-caption="voice">
          <Spoken text={x.voice} piece={v.saying} live={x.live === 'voice'} />
        </p>
      ) : null}
    </div>
  )
}

// ── The task's work ────────────────────────────────────────────────────────

/**
 * What the run is stopped on, answerable here: an ordinary approval (Allow
 * once, Always allow where the card offers it, Deny), a question with picks.
 * A risky approval is never a button here; neither is a free-text question.
 */
export function AskRow({ work }: { work: VoiceWork }) {
  // One set of buttons per request: a second approval in the same run starts with them live.
  return <AskFor key={work.ask?.requestId ?? 'none'} work={work} />
}

function AskFor({ work }: { work: VoiceWork }) {
  const api = useStage()
  const [sent, setSent] = useState<string | null>(null)
  const ask = work.ask
  if (!ask || work.state !== 'needs') return null
  // The buttons stay off once an answer is on its way; one refused (or that failed) can be given again.
  const answer = (key: string, fn: () => Promise<{ ok: boolean } | undefined>): void => {
    setSent(key)
    void fn().then(
      (res) => {
        if (res && !res.ok) setSent(null)
      },
      () => setSent(null)
    )
  }
  const onTask = api.showTask ? (
    <Button size="xs" variant="secondary" icon="minimize" onClick={api.showTask}>
      Answer on the task
    </Button>
  ) : null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-l-2 border-accent pl-3 vy-rise" data-voice-ask={ask.kind}>
      {ask.kind === 'approval' ? (
        <>
          <span className="min-w-0 flex-1 text-sm text-fg-strong">{`Allow it to ${ask.what}?`}</span>
          {ask.risky ? (
            onTask
          ) : (
            <span className="flex shrink-0 items-center gap-1.5">
              <Button size="xs" variant="primary" disabled={sent !== null} onClick={() => answer('once', () => api.respondApproval(ask.requestId, 'once', work.runId))}>
                Allow once
              </Button>
              {ask.always ? (
                <Button size="xs" variant="secondary" disabled={sent !== null} onClick={() => answer('always', () => api.respondApproval(ask.requestId, 'always', work.runId))}>
                  Always allow
                </Button>
              ) : null}
              <Button size="xs" variant="secondary" disabled={sent !== null} onClick={() => answer('deny', () => api.respondApproval(ask.requestId, 'deny', work.runId))}>
                Deny
              </Button>
            </span>
          )}
        </>
      ) : (
        <>
          <span className="w-full text-sm text-fg-strong">{ask.prompt}</span>
          {ask.options.length > 0
            ? ask.options.map((option) => (
                <Button
                  key={option}
                  size="xs"
                  variant="secondary"
                  disabled={sent !== null}
                  aria-pressed={sent === option}
                  onClick={() => answer(option, () => api.respondQuestion(ask.requestId, ask.questionId, option, work.runId))}
                >
                  {option}
                </Button>
              ))
            : onTask}
        </>
      )}
    </div>
  )
}

const STEP_GLYPH: Record<VoiceWorkStep['state'], TaskState> = { running: 'running', done: 'done', failed: 'failed' }

/** The last three steps while the task runs: what it just did, and what it's doing now. */
function RecentSteps({ work }: { work: VoiceWork }) {
  const recent = work.steps.slice(-3)
  const hidden = work.stepCount - recent.length
  return (
    <ol className="m-0 flex list-none flex-col p-0 pl-[21px]" aria-label="Recent steps" data-voice-recent={recent.length}>
      {recent.map((s) => (
        <li key={s.id} className="flex h-6 min-w-0 items-center gap-2 motion-safe:animate-fade-in" data-voice-step={s.state}>
          <StatusGlyph state={STEP_GLYPH[s.state]} size={11} />
          <span className={cn('shrink-0 text-xs', s.state === 'running' ? 'text-secondary vy-text-live' : s.state === 'failed' ? 'text-danger' : 'text-muted')}>{stepVerb(s)}</span>
          <span className={cn('min-w-0 truncate font-mono text-caption', s.state === 'running' ? 'text-secondary' : 'text-tertiary')}>{s.summary}</span>
        </li>
      ))}
      {hidden > 0 ? <li className="pl-[19px] text-caption text-tertiary">{`${hidden} earlier in the task`}</li> : null}
    </ol>
  )
}

/**
 * The task the session handed work to, in one strip: how it stands, the
 * brief, how far (steps · time), and below it what matters now: the last
 * three steps while it runs, the question with its buttons, why it wasn't
 * sent, or the outcome.
 */
export function WorkStrip({ entry, className }: { entry?: WorkEntry; className?: string }) {
  const { v, settings } = useStage()
  const now = useNow()
  const latest = useMemo(() => latestWork(v), [v])
  const e = entry ?? latest
  if (!e) return null
  const w = e.continued ? undefined : e.work
  const ended = w ? w.state !== 'running' && w.state !== 'needs' : false
  const time = e.failed || !w ? null : ended ? `${w.stepCount} step${w.stepCount === 1 ? '' : 's'} · ${elapsed(w, now)}` : elapsed(w, now)
  return (
    <div
      className={cn('w-full min-w-0 px-3 py-2.5', settings.style === 'ambient' ? 'vy-voice-glass rounded-xl' : cn('rounded-lg border', BORDER_DIVIDER), className)}
      data-voice-work={e.failed ? 'not_sent' : (w?.state ?? 'handed')}
    >
      <div className="flex h-6 min-w-0 items-center gap-2">
        <StatusGlyph state={workGlyph(e)} size={13} />
        <span className="min-w-0 flex-1 truncate text-sm text-fg">{e.brief}</span>
        {time ? <span className="shrink-0 font-mono text-caption text-tertiary tnum">{time}</span> : null}
      </div>
      {e.failed ? (
        <p className="m-0 flex items-center gap-1.5 pl-[21px] text-caption text-danger" data-voice-handoff-failed={e.failed}>
          <Icon name="warningCircle" size={12} />
          {HAND_OFF_FAILED[e.failed]}
        </p>
      ) : null}
      {w && w.state === 'running' && w.steps.length > 0 ? <RecentSteps work={w} /> : null}
      {w ? (
        <div className="pl-[21px]">
          <AskRow work={w} />
        </div>
      ) : null}
      {w && ended && w.result ? (
        <p className={cn('m-0 mt-1 line-clamp-2 pl-[21px] text-sm leading-relaxed', w.state === 'failed' ? 'text-danger' : 'text-secondary')} data-voice-result={w.state}>
          {w.result}
        </p>
      ) : null}
    </div>
  )
}

/** The task's full work for Split's pane: every step, the question, the whole answer. */
export function WorkPane({ entry }: { entry: WorkEntry }) {
  const now = useNow()
  const w = entry.continued ? undefined : entry.work
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-7 py-6" data-voice-work={entry.failed ? 'not_sent' : (w?.state ?? 'handed')}>
      <p className="m-0 text-sm leading-relaxed text-secondary">{entry.brief}</p>
      {entry.failed ? (
        <p className="m-0 mt-2 flex items-center gap-1.5 text-caption text-danger" data-voice-handoff-failed={entry.failed}>
          <Icon name="warningCircle" size={12} />
          {HAND_OFF_FAILED[entry.failed]}
        </p>
      ) : null}
      {w ? (
        <>
          <div className="mt-3">
            <Steps work={w} keep={w.state === 'running' || w.state === 'needs' ? 12 : 0} />
          </div>
          <AskRow work={w} />
          {/* The pane's own header already says how it ended. */}
          <Result work={w} now={now} fold={false} head={false} />
        </>
      ) : null}
    </div>
  )
}

// ── Controls ───────────────────────────────────────────────────────────────

/** The keys that apply now, as keycaps; Esc pressed once says what the next press does. */
export function KeyHints() {
  const { v, escArmed } = useStage()
  if (escArmed) return <span aria-live="polite">Press Esc again to end voice mode</span>
  const end = (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="flex gap-0.5">
        <Kbd>Esc</Kbd>
        <Kbd>Esc</Kbd>
      </span>
      End
    </span>
  )
  // Stopped or still opening, only ending applies.
  if (v.state === 'error' || v.state === 'connecting') return end
  return (
    <>
      <span className="flex shrink-0 items-center gap-1.5">
        <Kbd>Space</Kbd>Hold to talk
      </span>
      {v.state === 'speaking' ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <Kbd>Esc</Kbd>Stop speaking
        </span>
      ) : null}
      <span className="flex shrink-0 items-center gap-1.5">
        <Kbd>M</Kbd>Mute
      </span>
      {end}
    </>
  )
}

/** The one stop that applies now: its voice while it speaks, else the task while it works. */
export function StopButton({ compact }: { compact: boolean }) {
  const api = useStage()
  const { v } = api
  const entry = latestWork(v)
  const w = entry && !entry.continued && !entry.failed ? entry.work : undefined
  const taskLive = v.state === 'working' || v.state === 'waiting_on_you' || w?.state === 'running' || w?.state === 'needs'
  if (v.state === 'speaking') {
    return (
      <Button size="sm" variant="ghost" icon="stop" onClick={api.stopSpeaking} data-voice-stop="speaking">
        {compact ? 'Stop' : 'Stop speaking'}
      </Button>
    )
  }
  if (!taskLive) return null
  return (
    <Button size="sm" variant="ghost" icon="stop" onClick={api.stopTask} data-voice-stop="task">
      {compact ? 'Stop task' : 'Stop the task'}
    </Button>
  )
}

export function MuteButton({ compact, size = 'sm' }: { compact: boolean; size?: 'sm' | 'xs' }) {
  const api = useStage()
  const { v } = api
  const dead = v.state === 'error' || v.state === 'connecting'
  return (
    <Button
      size={size}
      variant="ghost"
      icon={v.muted ? 'micSlash' : 'mic'}
      aria-pressed={v.muted}
      aria-label={compact ? 'Mute' : undefined}
      disabled={dead}
      onClick={() => api.mute(!v.muted)}
      data-voice-mute={v.muted ? 'on' : 'off'}
    >
      {compact ? null : v.muted ? 'Unmute' : 'Mute'}
      {v.muted || dead ? null : <MicMeter live />}
    </Button>
  )
}

/**
 * The controls. Quiet: a footer row, keys on the left edge, actions on the
 * right. Ambient: one glass capsule centred under the stage, the keys a
 * quiet line beneath it. Compact (Companion, the cards): icon-first, every
 * icon named. They fade while nothing moves, never while something needs a
 * hand or focus is inside.
 */
export function Dock({ compact = false, bare = false, extra }: { compact?: boolean; /** Mute and End live elsewhere (the mini window's row). */ bare?: boolean; extra?: ReactNode }) {
  const api = useStage()
  const { v, settings, escArmed } = api
  const { pop, setPop } = useContext(PopContext)
  const settingsOpen = SETTINGS_TABS.includes(pop)
  const [focused, setFocused] = useState(false)
  const dead = v.state === 'error' || v.state === 'connecting'
  const idle = useIdle(3000) && !focused && pop === 'none' && !dead && !v.muted && v.state !== 'waiting_on_you' && !escArmed
  const fade = cn('vy-voice-idle', idle ? 'opacity-0' : 'opacity-100')
  const focusProps = {
    onFocus: () => setFocused(true),
    onBlur: (e: FocusEvent<HTMLDivElement>) => setFocused(e.currentTarget.contains(e.relatedTarget as Node | null))
  }
  const actions = (
    <>
      {bare ? null : <MuteButton compact={compact} />}
      <StopButton compact={compact} />
      {/* Between Mute and the rest; with Mute in the row above (bare), there's nothing to divide from. */}
      {bare ? null : <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />}
      <IconButton
        icon="sliders"
        label="Voice, devices and layout"
        size="sm"
        active={settingsOpen}
        aria-expanded={settingsOpen}
        onClick={() => setPop(settingsOpen ? 'none' : api.pickers ? 'voice' : 'layout')}
        data-voice-settings-button
      />
      <IconButton
        icon="chat"
        label="Conversation history"
        size="sm"
        active={pop === 'history'}
        aria-expanded={pop === 'history'}
        onClick={() => setPop(pop === 'history' ? 'none' : 'history')}
        data-voice-history-button
      />
      {extra}
      {bare ? null : (
        <Button size="sm" variant="secondary" icon="close" onClick={api.end} data-voice-end>
          End
        </Button>
      )}
    </>
  )
  if (settings.style === 'ambient') {
    return (
      <div className={cn('flex shrink-0 flex-col items-center gap-2 pb-3 pt-2', fade)} data-voice-dock={idle ? 'idle' : 'shown'} data-voice-row="controls" {...focusProps}>
        <Float shape="pill" className="relative flex h-12 items-center gap-1 px-2">
          {actions}
          <Popovers />
        </Float>
        {compact ? null : (
          <span className="flex h-5 items-center gap-4 text-caption text-tertiary" data-voice-keys>
            <KeyHints />
          </span>
        )}
      </div>
    )
  }
  return (
    <div className={cn('relative flex h-12 shrink-0 items-center gap-3 border-t px-4', BORDER_DIVIDER, fade)} data-voice-dock={idle ? 'idle' : 'shown'} data-voice-row="controls" {...focusProps}>
      {compact ? (
        <span className="flex-1" />
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden text-caption text-tertiary" data-voice-keys>
          <KeyHints />
        </span>
      )}
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
      <Popovers />
    </div>
  )
}

// ── Settings popover ───────────────────────────────────────────────────────

/** A row: a radio mark, a name, a quiet note on the right edge; anything after it (a play button) beside. */
function PickRow({ on, label, note, onClick, children }: { on: boolean; label: string; note?: ReactNode; onClick?: () => void; children?: ReactNode }) {
  return (
    <div className={cn('flex h-8 w-full items-center gap-1 rounded-md pr-1', on ? 'bg-surface-2' : CONTROL_HOVER)}>
      <button
        type="button"
        role="radio"
        aria-checked={on}
        onClick={onClick}
        className={cn('flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm focus-visible:vy-focus-ring', on ? 'text-fg-strong' : 'text-fg')}
      >
        <RadioMark on={on} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {note ? <span className="shrink-0 text-caption text-tertiary">{note}</span> : null}
      </button>
      {children}
    </div>
  )
}

function GroupLabel({ children }: { children: string }) {
  return <div className="px-2 pb-1 pt-2 text-caption text-tertiary">{children}</div>
}

/** A fixed shape per voice, so each sample looks like itself. */
function sampleShape(seed: string, n = 22): number[] {
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return Array.from({ length: n }, (_, i) => {
    h = (h * 1103515245 + 12345) >>> 0
    const env = Math.sin((i / (n - 1)) * Math.PI) * 0.6 + 0.4
    return 0.2 + env * ((h % 1000) / 1000) * 0.8
  })
}

/** The sample's shape, filling in the accent as it plays (paced by a typical sample's length). */
function SampleWave({ id }: { id: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const shape = useMemo(() => sampleShape(id), [id])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const kids = [...el.children] as HTMLElement[]
    // An inline colour, not a second bg class: cn() has no merge, so bg-accent beside bg-border would lose to emission order.
    const paint = (p: number): void => kids.forEach((b, i) => (b.style.backgroundColor = i / kids.length < p ? 'var(--vy-accent)' : ''))
    if (prefersReducedMotion()) {
      paint(1)
      return
    }
    const start = performance.now()
    let raf = 0
    const tick = (now: number): void => {
      paint(Math.min(1, (now - start) / 3000))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <span ref={ref} className="flex h-4 items-center gap-px" aria-hidden data-voice-sample-wave>
      {shape.map((v, i) => (
        <span key={i} className="w-[2px] rounded-full bg-border" style={{ height: `${Math.round(v * 16)}px` }} />
      ))}
    </span>
  )
}

/** What a sample says. */
const SAMPLE_LINE = 'Hi, I’m ready when you are. Tell me what you want done.'

/** The speeds offered; those outside the speaking provider's range are off. */
const SPEEDS = [0.85, 1, 1.15, 1.3] as const

export type VoicePickerDeps = {
  /** Who speaks now (the session's speaker, else what settings resolve to). */
  provider: TtsProviderId | null
  listVoices: (provider: TtsProviderId, model: string) => Promise<VoiceOptionInfo[] | null>
  /** Play a sample; resolves when it ends (the mic is held for its length). */
  playSample: (provider: TtsProviderId, voiceId: string, speed: number) => Promise<void>
  stopSample: () => void
}

export const VoicePickerContext = createContext<VoicePickerDeps | null>(null)

/**
 * Voice and speed, without leaving the session. Each voice plays a sample
 * from its row, its shape filling as it plays; listening pauses meanwhile,
 * so the mic doesn't hear it. The next reply uses the pick.
 */
function VoiceTab() {
  const api = useStage()
  const deps = useContext(VoicePickerContext)
  const provider = deps?.provider ?? null
  const entry = provider ? ttsEntry(provider) : null
  const model = entry ? chooseModel(entry, api.settings.tts[entry.id]?.model) : ''
  const [voices, setVoices] = useState<VoiceOptionInfo[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)
  useEffect(() => {
    if (!deps || !provider) return
    let live = true
    setVoices(null)
    setFailed(false)
    void deps.listVoices(provider, model).then((list) => {
      if (!live) return
      if (list) setVoices(list)
      else setFailed(true)
    })
    return () => {
      live = false
    }
  }, [deps, provider, model])
  useEffect(() => () => deps?.stopSample(), [deps])
  if (!deps || !provider || !entry) {
    // Undefined: the session hasn't said who speaks yet. Null: nothing can (no speaking key).
    return (
      <p className="m-0 px-3 py-4 text-sm text-muted" data-voice-voices={api.v.speaker === undefined ? 'loading' : 'none'}>
        {api.v.speaker === undefined ? 'Finding out who speaks…' : 'Nothing can speak: add a speaking key in Voice settings. Replies stay on screen.'}
      </p>
    )
  }
  const saved = api.settings.tts[entry.id]?.voiceId
  const list = voices ?? []
  const current = provider === 'openrouter' && voices ? pickVoice(list.map((x) => x.id), saved, entry.defaultVoice.id) : saved || entry.defaultVoice.id || list[0]?.id || ''
  const rows = list.length > 0 ? list.slice(0, 12) : current ? [{ id: current, label: current === entry.defaultVoice.id ? entry.defaultVoice.label : current }] : []
  if (current && !rows.some((r) => r.id === current)) rows.unshift({ id: current, label: current === entry.defaultVoice.id ? entry.defaultVoice.label : current })
  const speed = clampSpeed(api.settings.speed, entry.caps.speed)
  const play = (id: string): void => {
    if (playing === id) {
      deps.stopSample()
      setPlaying(null)
      return
    }
    setPlaying(id)
    void deps.playSample(provider, id, speed).finally(() => setPlaying((p) => (p === id ? null : p)))
  }
  return (
    <>
      <div className="scroll-thin max-h-72 overflow-y-auto p-1" role="radiogroup" aria-label="Voice">
        <GroupLabel>{`Speaks with ${entry.label}`}</GroupLabel>
        {voices === null && !failed ? <p className="m-0 px-2 py-1.5 text-xs text-tertiary">Loading voices…</p> : null}
        {failed ? <p className="m-0 px-2 py-1.5 text-xs text-warning">{`Couldn’t load ${entry.label} voices.`}</p> : null}
        {rows.map((r) => (
          <PickRow
            key={r.id}
            on={current === r.id}
            label={r.label}
            note={playing === r.id ? <SampleWave id={r.id} /> : 'description' in r ? (r as VoiceOptionInfo).description : undefined}
            onClick={() => api.patchSettings({ tts: { ...api.settings.tts, [entry.id]: { ...api.settings.tts[entry.id], voiceId: r.id } } })}
          >
            <IconButton
              icon={playing === r.id ? 'stop' : 'play'}
              label={playing === r.id ? `Stop the ${r.label} sample` : `Play a ${r.label} sample`}
              size="xs"
              active={playing === r.id}
              onClick={() => play(r.id)}
            />
          </PickRow>
        ))}
      </div>
      <div className={cn('flex h-11 items-center gap-3 border-t px-3', BORDER_DIVIDER)}>
        <span className="flex-1 text-sm text-fg">Speed</span>
        <Segmented
          items={SPEEDS.map((s) => {
            const out = s < entry.caps.speed[0] || s > entry.caps.speed[1]
            return { id: String(s), label: `${s}×`, disabled: out, title: out ? `${entry.label} speaks between ${entry.caps.speed[0]}× and ${entry.caps.speed[1]}×` : undefined }
          })}
          value={String(SPEEDS.find((s) => s === speed) ?? 1)}
          onChange={(s) => api.patchSettings({ speed: Number(s) })}
          label="Speed"
        />
      </div>
      <div className="flex h-9 items-center gap-2 px-3 text-caption text-tertiary">
        {playing ? (
          <>
            <Icon name="micSlash" size={12} />
            Listening pauses while a sample plays.
          </>
        ) : (
          'The next reply uses it.'
        )}
      </div>
    </>
  )
}

export type DevicePickerDeps = {
  micId: string
  switchMic: (deviceId: string) => Promise<boolean>
}

export const DevicePickerContext = createContext<DevicePickerDeps | null>(null)

function useDevices(read: () => Promise<Array<{ deviceId: string; label: string }>>) {
  const [devices, setDevices] = useState<Array<{ deviceId: string; label: string }>>([])
  useEffect(() => {
    let live = true
    const load = (): void => {
      void read().then((d) => {
        if (live) setDevices(d)
      })
    }
    load()
    navigator.mediaDevices?.addEventListener?.('devicechange', load)
    return () => {
      live = false
      navigator.mediaDevices?.removeEventListener?.('devicechange', load)
    }
  }, [read])
  return devices
}

/** Where it listens and where it speaks, switched live. The mic is the one dictation uses too. */
function DevicesTab() {
  const api = useStage()
  const deps = useContext(DevicePickerContext)
  const mics = useDevices(listMicDevices)
  const outs = useDevices(listSpeakerDevices)
  const [micFailed, setMicFailed] = useState(false)
  if (!deps) return null
  const micRows = mics.length ? mics : [{ deviceId: '', label: 'System default' }]
  const outRows = outs.length ? outs : [{ deviceId: '', label: 'System default' }]
  return (
    <>
      <div className="p-1">
        <GroupLabel>Microphone · also for dictation</GroupLabel>
        <div role="radiogroup" aria-label="Microphone">
          {micRows.map((m) => (
            <PickRow
              key={m.deviceId || 'default'}
              on={deps.micId === m.deviceId}
              label={m.label}
              note={deps.micId === m.deviceId ? <MicMeter live={!api.v.muted} /> : undefined}
              onClick={() => {
                setMicFailed(false)
                void deps.switchMic(m.deviceId).then((ok) => setMicFailed(!ok))
              }}
            />
          ))}
        </div>
        {micFailed ? <p className="m-0 px-2 py-1 text-xs text-warning">That microphone couldn’t be opened; it’s still listening on the last one.</p> : null}
        <GroupLabel>Output</GroupLabel>
        <div role="radiogroup" aria-label="Output">
          {outRows.map((o) => (
            <PickRow key={o.deviceId || 'default'} on={api.settings.outputDeviceId === o.deviceId} label={o.label} onClick={() => api.patchSettings({ outputDeviceId: o.deviceId })} />
          ))}
        </div>
      </div>
      <div className={cn('flex h-10 items-center gap-2 border-t px-3 text-caption text-tertiary', BORDER_DIVIDER)}>
        <Icon name="info" size={12} />
        Headphones stop it hearing itself.
      </div>
    </>
  )
}

const PLACEMENT_LABEL: Record<VoicePlacement, { label: string; note: string }> = {
  inline: { label: 'Inline', note: 'In the task thread' },
  companion: { label: 'Companion', note: 'Beside the task' },
  takeover: { label: 'Takeover', note: 'The whole window' },
  capsule: { label: 'Capsule', note: 'Floats over any view' },
  mini: { label: 'Mini window', note: 'Over other apps' }
}

/** Placement, the Takeover layout and the style, switched live; settings keep the pick. */
function LayoutTab() {
  const { settings, patchSettings } = useStage()
  return (
    <>
      <div className="p-1" role="radiogroup" aria-label="Placement">
        {VOICE_PLACEMENTS.map((p) => (
          <PickRow key={p} on={settings.placement === p} label={PLACEMENT_LABEL[p].label} note={PLACEMENT_LABEL[p].note} onClick={() => patchSettings({ placement: p })} />
        ))}
      </div>
      {settings.placement === 'takeover' ? (
        <div className={cn('flex h-11 items-center gap-3 border-t px-3', BORDER_DIVIDER)}>
          <span className="flex-1 text-sm text-fg">Shows</span>
          <Segmented<VoiceViewLayout>
            items={[
              { id: 'conversation', label: 'Words' },
              { id: 'orb', label: 'Orb' },
              { id: 'split', label: 'Split' }
            ]}
            value={settings.viewLayout}
            onChange={(viewLayout) => patchSettings({ viewLayout })}
            label="Takeover layout"
          />
        </div>
      ) : null}
      <div className={cn('flex h-11 items-center gap-3 border-t px-3', BORDER_DIVIDER)}>
        <span className="flex-1 text-sm text-fg">Style</span>
        <Segmented<VoiceStyle>
          items={[
            { id: 'quiet', label: 'Quiet' },
            { id: 'ambient', label: 'Ambient' }
          ]}
          value={settings.style}
          onChange={(style) => patchSettings({ style })}
          label="Style"
        />
      </div>
    </>
  )
}

/** One popover for everything about how it sounds, hears and sits: Voice · Devices · Layout. */
export function SettingsPopover() {
  const api = useStage()
  const { pop, setPop } = useContext(PopContext)
  const tabs = api.pickers ? (['voice', 'devices', 'layout'] as const) : (['layout'] as const)
  const tab = (tabs as readonly Pop[]).includes(pop) ? (pop as (typeof tabs)[number]) : tabs[0]
  const box = useFocusIn<HTMLDivElement>('[role="tab"][aria-selected="true"]')
  const label: Record<'voice' | 'devices' | 'layout', string> = { voice: 'Voice', devices: 'Devices', layout: 'Layout' }
  return (
    <Float className="w-80 overflow-hidden">
      <div ref={box} role="dialog" aria-label="Voice settings" data-voice-pop={tab}>
        <div className="flex h-10 items-center gap-2 border-b border-border pl-3 pr-2">
          <Tabs size="row" label="Voice settings" panelIdPrefix="voice-settings-" items={tabs.map((id) => ({ id, label: label[id] }))} value={tab} onChange={setPop} />
          <span className="flex-1" />
          <IconButton icon="close" label="Close" size="xs" onClick={() => setPop('none')} />
        </div>
        <div id={`voice-settings-${tab}`} role="tabpanel">
          {tab === 'voice' ? <VoiceTab /> : tab === 'devices' ? <DevicesTab /> : <LayoutTab />}
        </div>
      </div>
    </Float>
  )
}

/** The settings popover opens upwards from the control that opened it. */
export function Popovers() {
  const { pop } = useContext(PopContext)
  if (!SETTINGS_TABS.includes(pop)) return null
  return (
    <div className="absolute bottom-full right-2 z-20 mb-2 motion-safe:animate-menu-in">
      <SettingsPopover />
    </div>
  )
}

// ── History ────────────────────────────────────────────────────────────────

/** Everything said so far, newest last; each hand-off as one row. Captions off, only the work is listed. */
export function HistoryList() {
  const { v, settings } = useStage()
  const now = useNow()
  const words = settings.captions
  const rows = useMemo(() => buildEntries(v.transcript, v.works).filter((e) => words || e.who === 'work'), [v.transcript, v.works, words])
  if (rows.length === 0) {
    return <p className="m-0 px-4 py-6 text-center text-sm text-tertiary">{words ? 'Nothing said yet.' : 'Captions are off: only the work is listed.'}</p>
  }
  return (
    <ol className="m-0 flex list-none flex-col px-4 py-3" aria-label="Conversation" data-voice-transcript>
      {rows.map((e, i) =>
        e.who === 'work' ? (
          <li key={e.id} className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 py-1.5" data-voice-line="agent">
            <span className="flex items-center gap-1 text-caption text-tertiary">
              <StatusGlyph state={workGlyph(e)} size={12} />
              {WHO.work}
            </span>
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted">
                <span className="truncate">{e.brief}</span>
                {e.work && !e.failed ? <span className="shrink-0 font-mono text-caption text-tertiary tnum">{elapsed(e.work, now)}</span> : null}
              </span>
              {e.failed ? <span className="block text-caption text-danger">{HAND_OFF_FAILED[e.failed]}</span> : null}
            </span>
          </li>
        ) : (
          <li key={e.id} className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 py-1.5" data-voice-line={e.who} data-voice-unanswered={(e.who === 'you' && e.unanswered) || undefined}>
            <span className="pt-px text-caption text-tertiary">{i === 0 || rows[i - 1]!.who !== e.who ? WHO[e.who] : ''}</span>
            <span className={cn('text-sm leading-relaxed', e.who === 'you' && e.unanswered ? 'text-muted' : e.who === 'you' ? 'text-fg-strong' : 'text-fg')}>
              {e.text}
              {e.who === 'you' && e.unanswered ? <span className="ml-2 text-caption text-tertiary">Not answered</span> : null}
            </span>
          </li>
        )
      )}
    </ol>
  )
}

/** The history drawer: slides over the stage from the right edge; the stage stays where it is beneath. */
export function HistoryDrawer({ width = 380 }: { width?: number | string }) {
  const { pop } = useContext(PopContext)
  // Its own component, so focus moves in when it opens and back when it closes.
  return pop === 'history' ? <Drawer width={width} /> : null
}

function Drawer({ width }: { width: number | string }) {
  const { settings } = useStage()
  const { setPop } = useContext(PopContext)
  const box = useFocusIn<HTMLElement>('button[aria-label="Close"]')
  const list = useRef<HTMLDivElement>(null)
  // Opens on the newest lines, as a conversation does.
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])
  return (
    <aside
      ref={box}
      className={cn('vy-voice-slide-in absolute inset-y-0 right-0 z-10 flex max-w-full flex-col shadow-menu', settings.style === 'ambient' ? 'vy-voice-glass-pane' : 'vy-panel')}
      style={{ width }}
      aria-label="Conversation history"
      data-voice-drawer
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <Icon name="chat" size={14} className="text-muted" />
        <span className="flex-1 text-sm text-fg-strong">Conversation</span>
        <IconButton icon="close" label="Close" size="sm" onClick={() => setPop('none')} />
      </div>
      <div ref={list} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <HistoryList />
      </div>
    </aside>
  )
}

// ── Header ─────────────────────────────────────────────────────────────────

/** The 40px row: Voice and its clock on the left edge; how it hears and the way back to the task on the right. */
export function StageHeader({ children, title = 'Voice', icon = 'waveform' }: { children?: ReactNode; title?: string; icon?: IconName }) {
  const { settings, startedAt } = useStage()
  const now = useNow()
  return (
    <div className={cn('relative flex h-10 shrink-0 items-center gap-2 pl-4 pr-2', settings.style === 'quiet' ? 'border-b border-border' : null)} data-voice-header>
      <Icon name={icon} size={14} className="text-muted" />
      <h2 className="m-0 text-sm text-fg-strong">{title}</h2>
      <span className="font-mono text-caption text-tertiary tnum" aria-label="Voice mode time">
        {formatTime(now - (startedAt ?? now))}
      </span>
      <span className="flex-1" />
      {children}
    </div>
  )
}

/** The settings resolve to who speaks, when the session hasn't said yet. */
export function speakerFor(v: VoiceSnapshot, settings: VoiceSettings, keys: Parameters<typeof resolveTtsProvider>[1] | null): TtsProviderId | null {
  if (v.speaker) return v.speaker
  if (v.speaker === null) return null
  if (settings.ttsProvider !== 'auto') return settings.ttsProvider
  if (!keys) return null
  const r = resolveTtsProvider('auto', keys)
  return r.ok ? r.id : null
}
