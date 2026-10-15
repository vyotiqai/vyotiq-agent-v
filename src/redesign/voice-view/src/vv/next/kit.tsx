import { Fragment, createContext, useContext, useEffect, useId, useMemo, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, IconButton, Kbd, RadioMark, Segmented, StatusGlyph, Tabs, Tooltip, cn, type TaskState } from '@renderer/lib/ui'
import { BORDER_DIVIDER, CONTROL_HOVER } from '@renderer/lib/utils/layout'
import type { Scene, Step, Work } from '../data'
import { fakeLevel } from '../Orb'
import { Result, Steps, WHO } from '../parts'
import { HEADLINE, MICS, OUTPUTS, SPEAKS_WITH, SPEED_RANGE, SPEEDS, VOICES, exchange, hint, history, work as workOf, type Placement, type Pop, type VoiceStyle } from './model'
import { SphereOrb } from './SphereOrb'

/*
  The redesign's shared pieces. Two styles over one structure:
  - Quiet: the app's own planes and hairlines; the orb is the one living thing.
  - Ambient: a pool of light around the orb on a darkened field, controls as
    glass over it (vn-ambient / vn-glass in the mockup's styles.css, token
    mixes only, so every skin and theme still holds).

  Round 2 (2026-10-15 picks): the liquid-sphere orb, bigger captions spoken
  word by word, the work strip showing the last three steps, one settings
  popover (Voice · Devices · Layout) with voice samples in place, and the
  history drawer sliding over the stage.

  Every state the real session has is drawn (audit 2026-10-15): connecting,
  reconnecting with a listener fallback, a problem that ended it (with the
  provider's reason and its fix), trouble it survived (a lost turn, the
  speaking voice gone), hand-offs the task never took, words left
  unanswered, risky approvals (never a button here), questions with picks,
  failed runs, Esc pressed once, and captions off.
*/

export const StyleContext = createContext<VoiceStyle>('quiet')
export const useStyle = (): VoiceStyle => useContext(StyleContext)

/** Captions off hides the words, never the work (docs/voice-mode.md §25.3). */
export const CaptionsContext = createContext(true)

/** The viewer's popover pick, and a setter so the frames can open them on click too. */
export const PopContext = createContext<{ pop: Pop; setPop: (p: Pop) => void }>({ pop: 'none', setPop: () => {} })

/** The placement shown, for the in-session layout switcher. */
export const PlacementContext = createContext<{ placement: Placement; setPlacement: (p: Placement) => void; setStyle: (s: VoiceStyle) => void }>({
  placement: 'orb',
  setPlacement: () => {},
  setStyle: () => {}
})

const GLYPH: Record<Work['state'], TaskState> = { running: 'running', needs: 'needs', done: 'done', failed: 'failed' }

export function workGlyph(w: Work): TaskState {
  return w.notSent ? 'failed' : GLYPH[w.state]
}

export function useLevel(): () => number {
  return useMemo(() => fakeLevel(), [])
}

/**
 * True after `ms` without the pointer moving or a key going down (focus
 * moving into the controls counts as a key). The mockup's stand-in for the
 * view's own idle timer.
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
 * it), and back to whatever had it when it closes. Esc is the frame's (it
 * closes the open one first).
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

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/** The ground a placement sits on. */
export function Field({ children, className }: { children: ReactNode; className?: string }) {
  const style = useStyle()
  // Ambient's field carries a fine grain, so its light reads as light, not a flat gradient.
  return <div className={cn('relative flex min-h-0 min-w-0 flex-col', style === 'ambient' ? 'vn-ambient vn-grain' : 'bg-bg', className)}>{children}</div>
}

const FLOAT = {
  quiet: { card: 'vy-menu', pill: 'rounded-full bg-bg shadow-menu' },
  ambient: { card: 'vn-glass vn-depth rounded-xl', pill: 'vn-glass vn-depth rounded-full' }
} as const

/**
 * A floating surface: glass in Ambient, a menu plane in Quiet. The shape is
 * a prop, not an appended class: vy-menu sets its own radius, and cn() has
 * no merge, so a rounded-full beside it would lose to emission order.
 */
export function Float({ children, className, shape = 'card' }: { children: ReactNode; className?: string; shape?: 'card' | 'pill' }) {
  return <div className={cn(FLOAT[useStyle()][shape], className)}>{children}</div>
}

/**
 * Talking to it, shared by the orb, the dock, the pills, the composer and
 * the keys: mute, hold to talk, stop it speaking, end. The mockup keeps the
 * state in the frame (placements' useTalk) and derives the scene from it;
 * in the app these are the controller's setMuted, push-to-talk, stopSpeaking
 * and end.
 */
export type Talk = { muted: boolean; holding: boolean; toggleMute: () => void; hold: (on: boolean) => void; stopSpeaking: () => void; end: () => void }

export const TalkContext = createContext<Talk>({
  muted: false,
  holding: false,
  toggleMute: () => {},
  hold: () => {},
  stopSpeaking: () => {},
  end: () => {}
})

const HOLD_MS = 250

/**
 * The orb, and the way to talk to it: click it to mute or unmute, press and
 * hold it to talk (push-to-talk; letting go sends). Under 40px, or when
 * there's nothing to mute (stopped, opening), it's only a picture.
 */
export function Orb({ scene, size, interactive = true }: { scene: Scene; size: number; interactive?: boolean }) {
  const level = useLevel()
  const talk = useContext(TalkContext)
  const timer = useRef(0)
  const held = useRef(false)
  // Set when a hold ends, cleared on the next tick: the click that follows the pointer-up is the hold's, not a tap.
  const swallow = useRef(false)
  const hintId = useId()
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const sphere = <SphereOrb state={scene.state} size={size} level={level} />
  const dead = scene.state === 'error' || scene.state === 'connecting' || scene.state === 'off'
  if (!interactive || size < 40 || dead) return sphere
  const release = (): void => {
    window.clearTimeout(timer.current)
    if (!held.current) return
    held.current = false
    talk.hold(false)
    swallow.current = true
    window.setTimeout(() => (swallow.current = false), 0)
  }
  return (
    <button
      type="button"
      // One name with a pressed state; the name never flips to "Unmute" (that would say it twice).
      aria-pressed={talk.muted}
      aria-label="Mute"
      aria-describedby={hintId}
      title="Click to mute · press and hold to talk"
      data-vn-orb-button={talk.holding ? 'holding' : talk.muted ? 'muted' : 'live'}
      className="shrink-0 cursor-pointer touch-none select-none rounded-full transition-transform duration-200 focus-visible:vy-focus-ring active:scale-[0.97]"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        held.current = false
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => {
          held.current = true
          talk.hold(true)
        }, HOLD_MS)
      }}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onClick={() => {
        // A hold already did its job; a tap or Enter mutes (Space is hold-to-talk everywhere in voice mode).
        if (swallow.current) return
        talk.toggleMute()
      }}
    >
      {sphere}
      <span id={hintId} hidden>
        Press and hold to talk
      </span>
    </button>
  )
}

/** A mic with a ring opening out from it: you can talk over it now. */
export function InterruptCue() {
  return (
    <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center text-accent" aria-hidden>
      <span className="vn-ping absolute inset-0 rounded-full border border-accent" />
      <Icon name="mic" size={12} />
    </span>
  )
}

/**
 * The voice as a ribbon: three soft waves whose height follows your level
 * while it hears you and its level while it speaks, flat while muted. Drawn
 * on a canvas in an animation frame; the colour is the text colour, so the
 * tone token decides it. One still line under reduced motion.
 */
export function LiveWave({ state, width, height = 28, className }: { state: Scene['state']; width: number; height?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const level = useLevel()
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
    let raf = 0
    let s = 0
    let t = 0
    let last = performance.now()
    // Read once, not every frame (a forced style read per frame); again when the skin or theme changes.
    let color = getComputedStyle(canvas).color
    const mo = new MutationObserver(() => (color = getComputedStyle(canvas).color))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin', 'data-theme'] })
    const skinHost = canvas.closest('[data-skin]')
    if (skinHost) mo.observe(skinHost, { attributes: true, attributeFilter: ['data-skin', 'data-theme'] })
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
    if (reducedMotion()) {
      draw()
      return () => mo.disconnect()
    }
    const tick = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      t += dt * (1 + s * 2)
      s += ((loud ? level() : 0) - s) * Math.min(1, dt * 12)
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
  return <canvas ref={ref} aria-hidden className={cn('shrink-0', tone, className)} style={{ width, height }} data-vn-wave={state} />
}

/**
 * Who hears and speaks, as one token. The whole sentence (and where audio
 * goes, and any fallback) is its tooltip and accessible name; it opens Voice
 * settings, so the tooltip reaches the keyboard on a real control.
 */
export function EngineToken({ scene }: { scene: Scene }) {
  const fell = scene.fellBackFrom
  const tip = `Hears with OpenRouter · speaks with ${SPEAKS_WITH}. Audio goes to both.${fell ? ` No ${fell} key, so it listens with OpenRouter.` : ''}`
  return (
    <Tooltip content={tip} side="bottom" describeChild={false}>
      {/* A real control: it opens Voice settings, where the providers are changed. */}
      <button type="button" aria-label={tip} className={cn('flex h-6 items-center gap-1 rounded-md px-1.5 text-caption text-tertiary hover:text-fg focus-visible:vy-focus-ring', CONTROL_HOVER)}>
        <Icon name={fell ? 'warningCircle' : 'cloud'} size={12} className={fell ? 'text-warning' : undefined} />
        {`OpenRouter · ${SPEAKS_WITH}`}
      </button>
    </Tooltip>
  )
}

/** The pane's 40px row. */
export function Header({ scene, children, title = 'Voice' }: { scene: Scene; children?: ReactNode; title?: string }) {
  const style = useStyle()
  return (
    <div className={cn('relative flex h-10 shrink-0 items-center gap-2 pl-4 pr-2', style === 'quiet' ? 'border-b border-border' : null)}>
      <Icon name="waveform" size={14} className="text-muted" />
      <h2 className="m-0 text-sm text-fg-strong">{title}</h2>
      <span className="font-mono text-caption text-tertiary tnum">{scene.time}</span>
      <span className="flex-1" />
      {children}
    </div>
  )
}

/** What's happening in a word, then one line that never repeats the strip. Announced politely; captions are not. */
export function StateLine({ scene, size = 'title', align = 'center', sub }: { scene: Scene; size?: 'display' | 'title' | 'heading' | 'sm'; align?: 'center' | 'start'; sub?: string }) {
  const live = scene.state === 'thinking' || scene.state === 'working' || scene.state === 'connecting' || scene.state === 'reconnecting'
  const big = size === 'display' ? 'text-display' : size === 'title' ? 'text-title' : size === 'heading' ? 'text-heading' : 'text-sm font-medium'
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5', align === 'center' ? 'items-center text-center' : 'items-start')}>
      <p key={scene.state} role="status" aria-live="polite" className={cn('m-0 text-fg-strong motion-safe:animate-fade-in', big)}>
        {HEADLINE[scene.state]}
      </p>
      <p className={cn('m-0 flex max-w-full items-center gap-1.5', size === 'sm' ? 'text-xs' : 'text-sm', live ? 'vy-text-live' : scene.state === 'error' ? 'text-danger' : 'text-muted')}>
        {/* While it speaks, the hint is the way in: talk over it. */}
        {scene.state === 'speaking' && !sub ? <InterruptCue /> : null}
        {/* Its own block: an ellipsis needs one, a flex row never shows it. */}
        <span className="min-w-0 truncate">{sub ?? hint(scene)}</span>
      </p>
    </div>
  )
}

/**
 * What went wrong, with the provider's own reason and the one fix: a problem
 * that ended the session (danger, Try again), or trouble it survived
 * (warning; the session goes on).
 */
export function Notice({ scene, align = 'center' }: { scene: Scene; align?: 'center' | 'start' }) {
  const p = scene.problem ?? scene.trouble
  if (!p) return null
  const ended = Boolean(scene.problem)
  return (
    <div
      className={cn('flex max-w-full flex-wrap items-center gap-x-2 gap-y-1.5 text-xs', align === 'center' ? 'justify-center text-center' : null, ended ? 'text-danger' : 'text-warning')}
      role={ended ? 'alert' : 'status'}
    >
      <Icon name="warningCircle" size={13} className="shrink-0" />
      {/* An ended session's sentence is already the line under the headline: only its reason here. */}
      <span className="min-w-0">
        {ended ? null : p.message}
        {p.detail ? <span className="text-muted">{ended ? p.detail : ` ${p.detail}`}</span> : null}
      </span>
      {p.fix ? (
        <Button size="xs" variant={ended ? 'secondary' : 'ghost'}>
          {p.fix}
        </Button>
      ) : null}
      {ended ? (
        <Button size="xs" variant="ghost" icon="retry">
          Try again
        </Button>
      ) : null}
    </div>
  )
}

/**
 * How many words of a reply have been spoken. The app takes this from the
 * player's clock (CaptionPacer); the mockup walks at speaking pace and loops.
 * Reduced motion: all of it at once.
 */
function useSpoken(text: string, live: boolean): number {
  const count = text.split(/\s+/).filter(Boolean).length
  const [n, setN] = useState(live && !reducedMotion() ? 1 : count)
  useEffect(() => {
    if (!live || reducedMotion()) {
      setN(count)
      return
    }
    setN(1)
    let i = 1
    // ~3 words a second, a beat at the end, then again.
    const id = window.setInterval(() => {
      i = i >= count + 4 ? 1 : i + 1
      setN(Math.min(i, count))
    }, 300)
    return () => window.clearInterval(id)
  }, [text, live, count])
  return n
}

/** A reply as it's spoken: said words strong, the word being said underlined in the accent, the rest waiting. */
export function Spoken({ text, live }: { text: string; live: boolean }) {
  const n = useSpoken(text, live)
  if (!live) return <>{text}</>
  const words = text.split(/\s+/).filter(Boolean)
  return (
    <>
      {/* The whole reply for assistive tech; the word-by-word paint is visual only. */}
      <span className="sr-only">{text}</span>
      <span aria-hidden>
        {words.map((w, i) => (
          // The space sits outside the word, so the underline is the word's width only.
          <Fragment key={i}>
            {i ? ' ' : null}
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

/** Where a talked-over reply stopped: the words said, then a dash, dimming back. The mockup cuts at ~40%; the app at the player's position. */
export function CutReply({ text, className }: { text: string; className?: string }) {
  const words = text.split(/\s+/).filter(Boolean)
  const said = words.slice(0, Math.max(1, Math.round(words.length * 0.4))).join(' ')
  return (
    <p className={cn('vn-cut m-0 leading-snug text-muted', className)} data-vn-cut>
      {`${said} —`}
      <span className="sr-only"> (cut off: you started talking)</span>
    </p>
  )
}

type CaptionSize = 'display' | 'title' | 'heading' | 'md'

const VOICE_SIZE: Record<CaptionSize, string> = { display: 'text-display', title: 'text-title', heading: 'text-heading', md: 'text-md' }
/** Your words sit one step down unless you're saying them now. */
const YOU_SIZE: Record<CaptionSize, string> = { display: 'text-heading', title: 'text-md', heading: 'text-md', md: 'text-sm' }

/**
 * The current exchange, as captions: your words, then its answer, spoken
 * word by word. The one being said now is strong; the other steps back.
 * Captions off, a quiet line says it still speaks.
 */
export function Captions({ scene, size = 'heading', align = 'center', lines = 3 }: { scene: Scene; size?: CaptionSize; align?: 'center' | 'start'; lines?: 2 | 3 | 4 }) {
  const on = useContext(CaptionsContext)
  if (!on) return <p className={cn('m-0 text-caption text-tertiary', align === 'center' ? 'text-center' : null)}>Captions are off. It still speaks.</p>
  const x = exchange(scene)
  if (!x.you && !x.voice && !scene.cut) return null
  const lastYou = [...scene.entries].reverse().find((e) => e.who === 'you')
  const unanswered = !x.live && !x.voice && lastYou?.who === 'you' && lastYou.unanswered
  const clamp = lines === 2 ? 'line-clamp-2' : lines === 3 ? 'line-clamp-3' : 'line-clamp-4'
  return (
    <div className={cn('flex w-full min-w-0 flex-col gap-3', align === 'center' ? 'items-center text-center' : 'items-start')} aria-live="off" data-vn-captions>
      {scene.cut ? <CutReply text={scene.cut} className={YOU_SIZE[size]} /> : null}
      {x.you ? (
        <p key={`you-${x.live === 'you' ? 'live' : x.you}`} className={cn('vn-rise m-0 leading-snug', clamp, x.live === 'you' ? cn(VOICE_SIZE[size], 'text-fg-strong') : cn(YOU_SIZE[size], 'text-muted'))}>
          {x.live === 'you' ? null : <span className="mr-1.5 text-caption text-tertiary">{WHO.you}</span>}
          {x.you}
          {x.live === 'you' ? <span className="vn-caret ml-0.5 inline-block h-[1em] w-0.5 translate-y-[0.15em] bg-accent" aria-hidden /> : null}
          {unanswered ? <span className="ml-2 text-caption text-tertiary">Not answered</span> : null}
        </p>
      ) : null}
      {x.voice ? (
        <p key={`voice-${x.voice}`} className={cn('vn-rise m-0 leading-snug text-fg-strong', VOICE_SIZE[size], clamp)}>
          <Spoken text={x.voice} live={x.live === 'voice'} />
        </p>
      ) : null}
    </div>
  )
}

/**
 * What the run is stopped on, answerable here: an ordinary approval (Allow
 * once, Always allow where the card offers it, Deny), a question with picks.
 * A risky approval is never a button here; neither is a free-text question.
 */
export function AskRow({ work }: { work: Work }) {
  const ask = work.ask
  if (!ask || work.state !== 'needs') return null
  const onTask = (
    <Button size="xs" variant="secondary" icon="minimize">
      Answer on the task
    </Button>
  )
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-l-2 border-accent pl-3 vy-rise" data-vn-ask={ask.kind}>
      {ask.kind === 'approval' ? (
        <>
          <span className="min-w-0 flex-1 text-sm text-fg-strong">
            {`Allow it to ${ask.what}?`}
            <span className="ml-1.5 whitespace-nowrap font-mono text-caption text-tertiary">{ask.command}</span>
          </span>
          {ask.risky ? (
            onTask
          ) : (
            <span className="flex shrink-0 items-center gap-1.5">
              <Button size="xs" variant="primary">
                Allow once
              </Button>
              {ask.always ? (
                <Button size="xs" variant="secondary">
                  Always allow
                </Button>
              ) : null}
              <Button size="xs" variant="secondary">
                Deny
              </Button>
            </span>
          )}
        </>
      ) : (
        <>
          <span className="w-full text-sm text-fg-strong">{ask.prompt}</span>
          {ask.options.length > 0
            ? ask.options.map((o) => (
                <Button key={o} size="xs" variant="secondary">
                  {o}
                </Button>
              ))
            : onTask}
        </>
      )}
    </div>
  )
}

const STEP_GLYPH: Record<Step['state'], TaskState> = { running: 'running', done: 'done', failed: 'failed' }

/** The last three steps while the task runs: what it just did, and what it's doing now. */
function RecentSteps({ work }: { work: Work }) {
  const recent = work.steps.slice(-3)
  const hidden = work.steps.length - recent.length
  return (
    <ol className="m-0 flex list-none flex-col p-0 pl-[21px]" aria-label="Recent steps" data-vn-recent={recent.length}>
      {recent.map((s) => (
        <li key={s.id} className="flex h-6 min-w-0 items-center gap-2 motion-safe:animate-fade-in">
          <StatusGlyph state={STEP_GLYPH[s.state]} size={11} />
          <span className={cn('w-14 shrink-0 truncate text-xs', s.state === 'running' ? 'text-secondary vy-text-live' : s.state === 'failed' ? 'text-danger' : 'text-muted')}>{s.tool}</span>
          <span className={cn('min-w-0 truncate font-mono text-caption', s.state === 'running' ? 'text-secondary' : 'text-tertiary')}>{s.summary}</span>
        </li>
      ))}
      {hidden > 0 ? <li className="pl-[19px] text-caption text-tertiary">{`${hidden} earlier in the task`}</li> : null}
    </ol>
  )
}

/**
 * The task the session is on, in one strip: how it stands, the brief, how far
 * (steps · time), and below it what matters now: the last three steps while
 * it runs, the question with its buttons, why it wasn't sent, or the outcome.
 */
export function WorkStrip({ scene, work, className }: { scene: Scene; /** A given hand-off (Inline's thread); else the current one. */ work?: Work; className?: string }) {
  const style = useStyle()
  const w = work ?? workOf(scene)
  if (!w) return null
  const time = w.notSent ? null : w.state === 'done' || w.state === 'failed' ? `${w.steps.length} steps · ${w.elapsed}` : w.elapsed
  return (
    <div className={cn('w-full min-w-0 px-3 py-2.5', style === 'ambient' ? 'vn-glass rounded-xl' : cn('rounded-lg border', BORDER_DIVIDER), className)} data-vn-work={w.notSent ? 'not_sent' : w.state}>
      <div className="flex h-6 min-w-0 items-center gap-2">
        <StatusGlyph state={workGlyph(w)} size={13} />
        <span className="min-w-0 flex-1 truncate text-sm text-fg">{w.brief}</span>
        {time ? <span className="shrink-0 font-mono text-caption text-tertiary tnum">{time}</span> : null}
      </div>
      {w.notSent ? (
        <p className="m-0 flex items-center gap-1.5 pl-[21px] text-caption text-danger">
          <Icon name="warningCircle" size={12} />
          {w.notSent}
        </p>
      ) : null}
      {!w.notSent && w.state === 'running' && w.steps.length > 0 ? <RecentSteps work={w} /> : null}
      <div className="pl-[21px]">
        <AskRow work={w} />
      </div>
      {!w.notSent && (w.state === 'done' || w.state === 'failed') && w.result ? (
        <p className={cn('m-0 mt-1 line-clamp-2 pl-[21px] text-sm leading-relaxed', w.state === 'failed' ? 'text-danger' : 'text-secondary')}>{w.result}</p>
      ) : null}
    </div>
  )
}

/** Your level as four bars inside Mute; flat while muted. */
export function MicMeter({ live }: { live: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const level = useLevel()
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const bars = [...el.children] as HTMLElement[]
    const weights = [0.55, 1, 0.8, 0.45]
    const set = (l: number): void => bars.forEach((b, i) => (b.style.transform = `scaleY(${(0.3 + weights[i]! * (0.3 + 0.4 * l)).toFixed(3)})`))
    set(0)
    if (!live) return
    let raf = 0
    let s = 0
    const tick = (): void => {
      s += (level() * 0.6 - s) * 0.3
      set(s)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [live, level])
  return (
    <span ref={ref} className="flex h-3 items-center gap-px" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="h-3 w-0.5 origin-center rounded-full bg-current" />
      ))}
    </span>
  )
}

/** The keys that apply now, as keycaps; Esc pressed once says what the next press does. */
export function KeyHints({ scene }: { scene: Scene }) {
  if (scene.escArmed) return <span aria-live="polite">Press Esc again to end voice mode</span>
  // Stopped or still opening, only ending applies.
  const live = scene.state !== 'error' && scene.state !== 'connecting'
  if (!live)
    return (
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="flex gap-0.5">
          <Kbd>Esc</Kbd>
          <Kbd>Esc</Kbd>
        </span>
        End
      </span>
    )
  return (
    <>
      <span className="flex shrink-0 items-center gap-1.5">
        <Kbd>Space</Kbd>Hold to talk
      </span>
      {scene.state === 'speaking' ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <Kbd>Esc</Kbd>Stop speaking
        </span>
      ) : null}
      <span className="flex shrink-0 items-center gap-1.5">
        <Kbd>M</Kbd>Mute
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="flex gap-0.5">
          <Kbd>Esc</Kbd>
          <Kbd>Esc</Kbd>
        </span>
        End
      </span>
    </>
  )
}

const SETTINGS_TABS: readonly Pop[] = ['voice', 'devices', 'layout']

/**
 * The controls. Quiet: a footer row, keys (or what's wrong) on the left edge,
 * actions on the right. Ambient: one glass capsule centred under the orb, the
 * keys a quiet line beneath it. Compact (Companion, Capsule card, Mini):
 * icon-first, every icon named. Voice, devices and layout share one settings
 * popover; the history drawer has its own button.
 */
export function Dock({ scene, compact = false, bare = false, extra }: { scene: Scene; compact?: boolean; /** Mute and End live elsewhere (the mini window's pill row). */ bare?: boolean; extra?: ReactNode }) {
  const style = useStyle()
  const { pop, setPop } = useContext(PopContext)
  const talk = useContext(TalkContext)
  const muted = scene.state === 'paused'
  const dead = scene.state === 'error' || scene.state === 'connecting'
  const taskLive = scene.state === 'working' || scene.state === 'waiting_on_you' || (muted && workOf(scene)?.state === 'running')
  const settingsOpen = SETTINGS_TABS.includes(pop)
  const [focused, setFocused] = useState(false)
  // Out of the way while nothing moves, never while something needs a hand, and never with focus inside (an invisible focused control).
  const idle = useIdle(3000) && !focused && pop === 'none' && !dead && !muted && scene.state !== 'waiting_on_you' && !scene.escArmed
  const fade = cn('vn-idle', idle ? 'opacity-0' : 'opacity-100')
  const focusProps = {
    onFocus: () => setFocused(true),
    onBlur: (e: FocusEvent<HTMLDivElement>) => setFocused(e.currentTarget.contains(e.relatedTarget as Node | null))
  }
  const actions = (
    <>
      {bare ? null : (
        <Button
          size="sm"
          variant="ghost"
          icon={muted ? 'micSlash' : 'mic'}
          aria-pressed={muted}
          aria-label={compact ? 'Mute' : undefined}
          disabled={dead}
          onClick={talk.toggleMute}
        >
          {compact ? null : muted ? 'Unmute' : 'Mute'}
          {muted || dead ? null : <MicMeter live />}
        </Button>
      )}
      {scene.state === 'speaking' ? (
        <Button size="sm" variant="ghost" icon="stop" onClick={talk.stopSpeaking}>
          {compact ? 'Stop' : 'Stop speaking'}
        </Button>
      ) : taskLive ? (
        <Button size="sm" variant="ghost" icon="stop">
          {compact ? 'Stop task' : 'Stop the task'}
        </Button>
      ) : null}
      <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
      <IconButton icon="sliders" label="Voice, devices and layout" size="sm" active={settingsOpen} aria-expanded={settingsOpen} onClick={() => setPop(settingsOpen ? 'none' : 'voice')} />
      <IconButton icon="chat" label="Conversation history" size="sm" active={pop === 'history'} aria-expanded={pop === 'history'} onClick={() => setPop(pop === 'history' ? 'none' : 'history')} />
      {extra}
      {bare ? null : (
        <Button size="sm" variant="secondary" icon="close" onClick={talk.end}>
          End
        </Button>
      )}
    </>
  )
  if (style === 'ambient') {
    return (
      <div className={cn('flex shrink-0 flex-col items-center gap-2 pb-3 pt-2', fade)} data-vn-dock={idle ? 'idle' : 'shown'} {...focusProps}>
        <Float shape="pill" className="relative flex h-12 items-center gap-1 px-2">
          {actions}
          <Popovers />
        </Float>
        {compact ? null : (
          <span className="flex h-5 items-center gap-4 text-caption text-tertiary">
            <KeyHints scene={scene} />
          </span>
        )}
      </div>
    )
  }
  return (
    <div className={cn('relative flex h-12 shrink-0 items-center gap-3 border-t px-4', BORDER_DIVIDER, fade)} data-vn-dock={idle ? 'idle' : 'shown'} {...focusProps}>
      {compact ? (
        <span className="flex-1" />
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden text-caption text-tertiary">
          <KeyHints scene={scene} />
        </span>
      )}
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
      <Popovers />
    </div>
  )
}

/** A popover row: a radio mark, a name, a quiet note on the right edge. */
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
function bars(seed: string, n = 22): number[] {
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return Array.from({ length: n }, (_, i) => {
    h = (h * 1103515245 + 12345) >>> 0
    const env = Math.sin((i / (n - 1)) * Math.PI) * 0.6 + 0.4
    return 0.2 + env * ((h % 1000) / 1000) * 0.8
  })
}

const SAMPLE_MS = 2400

/** The sample's shape, filling in the accent as it plays. */
function Waveform({ id, playing }: { id: string; playing: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const shape = useMemo(() => bars(id), [id])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const kids = [...el.children] as HTMLElement[]
    // An inline colour, not a second bg class: cn() has no merge, so bg-accent beside bg-border would lose to emission order.
    const paint = (p: number): void => kids.forEach((b, i) => (b.style.backgroundColor = i / kids.length < p ? 'var(--vy-accent)' : ''))
    paint(0)
    if (!playing) return
    if (reducedMotion()) {
      paint(1)
      return
    }
    const start = performance.now()
    let raf = 0
    const tick = (now: number): void => {
      paint(Math.min(1, (now - start) / SAMPLE_MS))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])
  return (
    <span ref={ref} className="flex h-4 items-center gap-px" aria-hidden>
      {shape.map((v, i) => (
        <span key={i} className="w-[2px] rounded-full bg-border" style={{ height: `${Math.round(v * 16)}px` }} />
      ))}
    </span>
  )
}

/**
 * Voice and speed. Each voice plays a sample from its row, its shape filling
 * as it plays; listening pauses while it does, so the mic doesn't hear it.
 * Speeds outside the speaking provider's range are off.
 */
function VoiceTab() {
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>('1.0')
  const [voice, setVoice] = useState<string>(VOICES[0].id)
  const [playing, setPlaying] = useState<string | null>(null)
  useEffect(() => {
    if (!playing) return
    const id = window.setTimeout(() => setPlaying(null), SAMPLE_MS + 200)
    return () => window.clearTimeout(id)
  }, [playing])
  return (
    <>
      <div className="p-1" role="radiogroup" aria-label="Voice">
        <GroupLabel>{`Speaks with ${SPEAKS_WITH}`}</GroupLabel>
        {VOICES.map((v) => (
          <PickRow key={v.id} on={voice === v.id} label={v.label} note={playing === v.id ? <Waveform id={v.id} playing /> : v.note} onClick={() => setVoice(v.id)}>
            <IconButton
              icon={playing === v.id ? 'stop' : 'play'}
              label={playing === v.id ? `Stop the ${v.label} sample` : `Play a ${v.label} sample`}
              size="xs"
              active={playing === v.id}
              onClick={() => setPlaying(playing === v.id ? null : v.id)}
            />
          </PickRow>
        ))}
      </div>
      <div className={cn('flex h-11 items-center gap-3 border-t px-3', BORDER_DIVIDER)}>
        <span className="flex-1 text-sm text-fg">Speed</span>
        <Segmented
          items={SPEEDS.map((s) => {
            const out = Number(s) < SPEED_RANGE[0] || Number(s) > SPEED_RANGE[1]
            return { id: s, label: `${s}×`, disabled: out, title: out ? `${SPEAKS_WITH} speaks between ${SPEED_RANGE[0]}× and ${SPEED_RANGE[1]}×` : undefined }
          })}
          value={speed}
          onChange={setSpeed}
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

/** Where it listens and where it speaks, switched live. The mic is the one dictation uses too. */
function DevicesTab() {
  const [mic, setMic] = useState<string>(MICS[0])
  const [out, setOut] = useState<string>(OUTPUTS[0])
  return (
    <>
      <div className="p-1">
        <GroupLabel>Microphone · also for dictation</GroupLabel>
        <div role="radiogroup" aria-label="Microphone">
          {MICS.map((m) => (
            <PickRow key={m} on={mic === m} label={m} note={mic === m ? <MicMeter live /> : undefined} onClick={() => setMic(m)} />
          ))}
        </div>
        <GroupLabel>Output</GroupLabel>
        <div role="radiogroup" aria-label="Output">
          {OUTPUTS.map((m) => (
            <PickRow key={m} on={out === m} label={m} onClick={() => setOut(m)} />
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

const PLACEMENTS: readonly { id: Placement; label: string; note: string }[] = [
  { id: 'companion', label: 'Companion', note: 'Beside the task' },
  { id: 'orb', label: 'Takeover', note: 'The whole window' },
  { id: 'capsule', label: 'Capsule', note: 'Floats over any view' },
  { id: 'mini', label: 'Mini window', note: 'Over other apps' },
  { id: 'inline', label: 'Inline', note: 'In the task thread' }
]

const TAKEOVER: readonly Placement[] = ['conversation', 'orb', 'split']

/** Placement, the Takeover layout and the style, switched live; Settings › Voice mode keeps the pick. */
function LayoutTab() {
  const { placement, setPlacement, setStyle } = useContext(PlacementContext)
  const style = useStyle()
  const takeover = TAKEOVER.includes(placement)
  const kind: Placement = takeover ? 'orb' : placement === 'capsule-open' ? 'capsule' : placement === 'mini-open' ? 'mini' : placement
  return (
    <>
      <div className="p-1" role="radiogroup" aria-label="Placement">
        {PLACEMENTS.map((p) => (
          <PickRow key={p.id} on={kind === p.id} label={p.label} note={p.note} onClick={() => setPlacement(p.id === 'orb' && takeover ? placement : p.id)} />
        ))}
      </div>
      {takeover ? (
        <div className={cn('flex h-11 items-center gap-3 border-t px-3', BORDER_DIVIDER)}>
          <span className="flex-1 text-sm text-fg">Shows</span>
          <Segmented
            items={[
              { id: 'conversation', label: 'Words' },
              { id: 'orb', label: 'Orb' },
              { id: 'split', label: 'Split' }
            ]}
            value={placement as 'conversation' | 'orb' | 'split'}
            onChange={setPlacement}
            label="Takeover layout"
          />
        </div>
      ) : null}
      <div className={cn('flex h-11 items-center gap-3 border-t px-3', BORDER_DIVIDER)}>
        <span className="flex-1 text-sm text-fg">Style</span>
        <Segmented
          items={[
            { id: 'quiet', label: 'Quiet' },
            { id: 'ambient', label: 'Ambient' }
          ]}
          value={style}
          onChange={setStyle}
          label="Style"
        />
      </div>
    </>
  )
}

/** One popover for everything about how it sounds, hears and sits: Voice · Devices · Layout. */
export function SettingsPopover() {
  const { pop, setPop } = useContext(PopContext)
  const tab = SETTINGS_TABS.includes(pop) ? (pop as 'voice' | 'devices' | 'layout') : 'voice'
  const box = useFocusIn<HTMLDivElement>('[role="tab"][aria-selected="true"]')
  return (
    <Float className="w-80 overflow-hidden">
      <div ref={box} role="dialog" aria-label="Voice settings">
        <div className="flex h-10 items-center gap-2 border-b border-border pl-3 pr-2">
          <Tabs
            size="row"
            label="Voice settings"
            panelIdPrefix="vn-settings-"
            items={[
              { id: 'voice', label: 'Voice' },
              { id: 'devices', label: 'Devices' },
              { id: 'layout', label: 'Layout' }
            ]}
            value={tab}
            onChange={setPop}
          />
          <span className="flex-1" />
          <IconButton icon="close" label="Close" size="xs" onClick={() => setPop('none')} />
        </div>
        <div id={`vn-settings-${tab}`} role="tabpanel">
          {tab === 'voice' ? <VoiceTab /> : tab === 'devices' ? <DevicesTab /> : <LayoutTab />}
        </div>
      </div>
    </Float>
  )
}

/** Everything said so far, newest last; each hand-off as one row. Captions off, only the work is listed. */
export function HistoryList({ scene }: { scene: Scene }) {
  const words = useContext(CaptionsContext)
  const rows = history(scene).filter((e) => words || e.who === 'work')
  if (rows.length === 0) return <p className="m-0 px-4 py-6 text-center text-sm text-tertiary">{words ? 'Nothing said yet.' : 'Captions are off: only the work it handed over is listed.'}</p>
  return (
    <ol className="m-0 flex list-none flex-col px-4 py-3">
      {rows.map((e, i) =>
        e.who === 'work' ? (
          <li key={e.id} className="grid grid-cols-[56px_minmax(0,1fr)] gap-3 py-1.5" data-vn-line="work">
            <span className="flex items-center gap-1 text-caption text-tertiary">
              <StatusGlyph state={workGlyph(e.work)} size={12} />
              {WHO.work}
            </span>
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted">
                <span className="truncate">{e.work.brief}</span>
                {e.work.notSent ? null : <span className="shrink-0 font-mono text-caption text-tertiary tnum">{e.work.elapsed}</span>}
              </span>
              {e.work.notSent ? <span className="block text-caption text-danger">{e.work.notSent}</span> : null}
            </span>
          </li>
        ) : (
          <li key={e.id} className="grid grid-cols-[56px_minmax(0,1fr)] gap-3 py-1.5" data-vn-line={e.who}>
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
export function HistoryDrawer({ scene, width = 380 }: { scene: Scene; width?: number | string }) {
  const { pop } = useContext(PopContext)
  // Its own component, so focus moves in when it opens and back when it closes.
  return pop === 'history' ? <Drawer scene={scene} width={width} /> : null
}

function Drawer({ scene, width }: { scene: Scene; width: number | string }) {
  const style = useStyle()
  const { setPop } = useContext(PopContext)
  const box = useFocusIn<HTMLElement>('button[aria-label="Close"]')
  return (
    <aside
      ref={box}
      className={cn('vn-slide-in absolute inset-y-0 right-0 z-10 flex max-w-full flex-col shadow-menu', style === 'ambient' ? 'vn-glass-pane' : 'vy-panel')}
      style={{ width }}
      aria-label="Conversation history"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <Icon name="chat" size={14} className="text-muted" />
        <span className="flex-1 text-sm text-fg-strong">Conversation</span>
        <IconButton icon="close" label="Close" size="sm" onClick={() => setPop('none')} />
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <HistoryList scene={scene} />
      </div>
    </aside>
  )
}

/** The settings popover opens upwards from the dock's settings button. */
export function Popovers() {
  const { pop } = useContext(PopContext)
  if (!SETTINGS_TABS.includes(pop)) return null
  return (
    <div className="absolute bottom-full right-2 z-20 mb-2 motion-safe:animate-menu-in">
      <SettingsPopover />
    </div>
  )
}

/** The task's record behind Companion and Capsule, so the frame reads as the app. Not part of the design. */
export function RecordStub({ scene, composer = false }: { scene: Scene; composer?: boolean }) {
  const w = workOf(scene)
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <StatusGlyph state={w ? workGlyph(w) : 'queued'} size={13} />
        <span className="truncate text-sm text-fg-strong">{scene.task?.title ?? 'New task'}</span>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-[640px]">
          <p className="m-0 text-caption text-tertiary">Brief</p>
          <p className="m-0 mt-1 text-sm leading-relaxed text-fg">{w && !w.notSent ? w.brief : 'Said by voice: what you ask for becomes the brief.'}</p>
          {w && !w.notSent ? (
            <>
              <p className="m-0 mt-6 text-caption text-tertiary">Work</p>
              <div className="mt-1">
                <Steps work={w} keep={8} />
              </div>
              <AskRow work={w} />
              {w.result && w.state === 'done' ? <Result work={w} clamp={false} /> : null}
              {w.result && w.state === 'failed' ? <p className="m-0 mt-2 text-sm text-danger">{w.result}</p> : null}
            </>
          ) : null}
        </div>
      </div>
      {composer ? (
        // The task's composer, as the app draws it: the capsule floats just above it.
        <div className="shrink-0 px-8 pb-5" aria-hidden>
          <div className="mx-auto flex h-[76px] max-w-[680px] flex-col justify-between rounded-xl border border-border bg-surface px-3 py-2.5">
            <span className="text-sm text-tertiary">Ask for a change, or type / for commands</span>
            <span className="flex items-center gap-2 text-caption text-tertiary">
              <Icon name="paperclip" size={13} />
              <span className="flex-1" />
              <span className="h-6 w-6 rounded-md bg-surface-2" />
            </span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
