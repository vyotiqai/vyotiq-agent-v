import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, IconButton, StatusGlyph, cn } from '@renderer/lib/ui'
import { BORDER_DIVIDER, ROW_HOVER } from '@renderer/lib/utils/layout'
import type { Scene } from '../data'
import { Steps } from '../parts'
import { AskRow, Captions, Dock, EngineToken, Field, Float, Header, HistoryDrawer, HistoryList, LiveWave, Notice, Orb, PlacementContext, PopContext, RecordStub, StateLine, TalkContext, WorkStrip, useStyle, workGlyph, type Talk } from './kit'
import { Inline } from './inline'
import { HEADLINE, SUMMARY, exchange, work as workOf, type Placement } from './model'

/*
  Every placement the 2026-10-15 picks asked for, on one structure:
  orb · what's happening · the current exchange as captions · the task's
  strip · the dock; history in a drawer that slides over the stage, voice,
  devices and layout in one settings popover.

  Companion   a wide column docked right of the task record, with the task's strip.
  Takeover    the whole window, sidebar included, in three layouts:
                Conversation  captions are the hero, the orb above them
                Orb           the orb is the hero, captions under it
                Split         stage on the left, the task's full work on the right
  Capsule     a pill above the composer on any view; opens into a card.
  Mini window its own always-on-top window, a pill that opens while the
              pointer (or focus) is on it, or while it needs you.
  Summary     what End leaves: the task outcomes and two buttons.
*/

// ── Companion ─────────────────────────────────────────────────────────────

export function Companion({ scene }: { scene: Scene }) {
  return (
    <>
      <RecordStub scene={scene} />
      <Field className="w-[460px] shrink-0 border-l border-border">
        <Header scene={scene}>
          <EngineToken scene={scene} />
          <IconButton icon="collapse" label="Shrink to a capsule" size="sm" />
        </Header>
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="scroll-thin flex min-h-0 flex-1 flex-col items-center gap-6 overflow-y-auto px-9 pb-5 pt-12">
            <Orb scene={scene} size={200} />
            <StateLine scene={scene} size="title" />
            <Notice scene={scene} />
            <Captions scene={scene} size="heading" lines={4} />
            <span className="flex-1" />
            <WorkStrip scene={scene} />
          </div>
          <HistoryDrawer scene={scene} width="100%" />
        </div>
        <Dock scene={scene} compact />
      </Field>
    </>
  )
}

// ── Takeover ──────────────────────────────────────────────────────────────

/** The whole window: the sidebar gives way too, and "Show the task" brings the app back with voice as a capsule. */
function Takeover({ scene, children }: { scene: Scene; children: ReactNode }) {
  return (
    <Field className="flex-1">
      <Header scene={scene}>
        <EngineToken scene={scene} />
        <Button size="xs" variant="ghost" icon="minimize">
          Show the task
        </Button>
      </Header>
      <div className="relative flex min-h-0 flex-1">
        {children}
        <HistoryDrawer scene={scene} />
      </div>
      <Dock scene={scene} />
    </Field>
  )
}

/** Captions are the hero: what was just said, at display size, with the orb above. */
export function TakeoverConversation({ scene }: { scene: Scene }) {
  const x = exchange(scene)
  return (
    <Takeover scene={scene}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center px-16 pb-8 pt-20">
        <div className="flex w-full max-w-[780px] flex-1 flex-col gap-10">
          <div className="flex items-center gap-6">
            <Orb scene={scene} size={104} />
            <StateLine scene={scene} size="title" align="start" />
          </div>
          <Notice scene={scene} align="start" />
          {x.you || x.voice || scene.cut ? (
            <Captions scene={scene} size="display" align="start" lines={4} />
          ) : (
            <p className="m-0 text-display leading-snug text-tertiary">Say what you want done.</p>
          )}
          {/* No hero orb here, so the voice gets a ribbon under the words. */}
          <LiveWave state={scene.state} width={320} />
          <span className="flex-1" />
          <WorkStrip scene={scene} />
        </div>
      </div>
    </Takeover>
  )
}

/** The orb is the hero; the exchange and the task's strip under it. */
export function TakeoverOrb({ scene }: { scene: Scene }) {
  return (
    <Takeover scene={scene}>
      <div className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col items-center gap-7 overflow-y-auto px-16 pb-6 pt-10">
        <Orb scene={scene} size={232} />
        <StateLine scene={scene} size="title" />
        <Notice scene={scene} />
        <div className="w-full max-w-[640px]">
          <Captions scene={scene} size="title" />
        </div>
        <span className="flex-1" />
        <div className="w-full max-w-[560px]">
          <WorkStrip scene={scene} />
        </div>
      </div>
    </Takeover>
  )
}

/** The stage on the left; the task's every step, question and full answer on the right. */
export function TakeoverSplit({ scene }: { scene: Scene }) {
  const style = useStyle()
  const w = workOf(scene)
  return (
    <Takeover scene={scene}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center gap-8 px-12 pb-8 pt-16">
        <Orb scene={scene} size={224} />
        {/* The task pane says how far it has got. */}
        <StateLine scene={scene} size="title" sub={scene.state === 'working' ? 'It keeps going while you talk' : undefined} />
        <Notice scene={scene} />
        <div className="w-full max-w-[480px]">
          <Captions scene={scene} size="heading" lines={4} />
        </div>
      </div>
      <aside className={cn('flex w-[42%] min-w-[340px] max-w-[560px] shrink-0 flex-col', style === 'ambient' ? 'vn-glass-pane' : 'vy-panel')} aria-label="Its task">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
          <StatusGlyph state={w ? workGlyph(w) : 'queued'} size={13} />
          <span className={cn('flex-1 truncate text-sm', w ? 'text-fg-strong' : 'text-muted')}>{scene.task?.title ?? 'Nothing handed over yet'}</span>
          {w && !w.notSent ? <span className="font-mono text-caption text-tertiary tnum">{`${w.steps.length} steps · ${w.elapsed}`}</span> : null}
        </div>
        {w ? (
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-7 py-6">
            <p className="m-0 text-sm leading-relaxed text-secondary">{w.brief}</p>
            {w.notSent ? (
              <p className="m-0 mt-2 flex items-center gap-1.5 text-caption text-danger">
                <Icon name="warningCircle" size={12} />
                {w.notSent}
              </p>
            ) : (
              <>
                <div className="mt-3">
                  <Steps work={w} keep={w.state === 'done' ? 0 : 12} />
                </div>
                <AskRow work={w} />
                {w.result ? <p className={cn('m-0 mt-3 text-sm leading-relaxed', w.state === 'failed' ? 'text-danger' : 'text-fg')}>{w.result}</p> : null}
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
            <Icon name="tasks" size={20} className="text-tertiary" />
            <p className="m-0 max-w-[260px] text-sm text-muted">Ask it to do something; its steps show here as it works.</p>
          </div>
        )}
      </aside>
    </Takeover>
  )
}

// ── Pills (Capsule, Mini window) ──────────────────────────────────────────

/** State, time, any trouble, the words being said, and Answer when it needs you. */
function PillBody({ scene, words = 260, onAnswer }: { scene: Scene; words?: number; onAnswer?: () => void }) {
  const x = exchange(scene)
  const said = x.live === 'voice' ? x.voice : x.live === 'you' ? x.you : ''
  const notice = scene.problem ?? scene.trouble
  return (
    <>
      <Orb scene={scene} size={32} />
      <span className="shrink-0 text-sm text-fg-strong" role="status" aria-live="polite">
        {HEADLINE[scene.state]}
      </span>
      <span className="shrink-0 font-mono text-caption text-tertiary tnum">{scene.time}</span>
      {notice ? <Icon name="warningCircle" size={14} className={cn('shrink-0', scene.problem ? 'text-danger' : 'text-warning')} aria-label={notice.message} /> : null}
      {said ? (
        // min-w-0: the words give way before the controls do.
        <span className="min-w-0 truncate text-sm text-muted" style={{ maxWidth: words }}>
          {said}
        </span>
      ) : null}
      {scene.state === 'hearing' || scene.state === 'speaking' ? <LiveWave state={scene.state} width={56} height={20} /> : null}
      {/* Waiting on you: the one thing worth a click opens the card where it's answered. */}
      {scene.state === 'waiting_on_you' ? (
        <Button size="xs" variant="primary" onClick={onAnswer}>
          Answer
        </Button>
      ) : null}
    </>
  )
}

// ── Capsule ───────────────────────────────────────────────────────────────

function MuteButton({ scene }: { scene: Scene }) {
  const talk = useContext(TalkContext)
  const muted = scene.state === 'paused'
  const dead = scene.state === 'error' || scene.state === 'connecting'
  return <IconButton icon={muted ? 'micSlash' : 'mic'} label="Mute" size="sm" aria-pressed={muted} disabled={dead} onClick={talk.toggleMute} />
}

function EndButton() {
  const talk = useContext(TalkContext)
  return <IconButton icon="close" label="End voice mode" size="sm" onClick={talk.end} />
}

/** The card a pill opens into: the same stage, smaller. */
function Card({ scene, head, orb, dock }: { scene: Scene; head: ReactNode; orb: number; dock?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col motion-safe:animate-fade-in" data-vn-capsule="card">
      {head}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="scroll-thin flex min-h-0 flex-1 flex-col items-center gap-5 overflow-y-auto px-7 pb-5 pt-8">
          <Orb scene={scene} size={orb} />
          <StateLine scene={scene} size="heading" />
          <Notice scene={scene} />
          <Captions scene={scene} size="md" lines={3} />
          <span className="flex-1" />
          <WorkStrip scene={scene} />
        </div>
        <HistoryDrawer scene={scene} width="100%" />
      </div>
      {dock ?? <Dock scene={scene} compact />}
    </div>
  )
}

/**
 * One surface that grows from the pill into the card and back (width,
 * height and corners ease together, the contents cross-fade), anchored at
 * the bottom so it rises out of the composer.
 */
export function Capsule({ scene, open: initial }: { scene: Scene; open: boolean }) {
  const [open, setOpen] = useState(initial)
  useEffect(() => setOpen(initial), [initial])
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <RecordStub scene={scene} composer />
      {/* Bottom centre, just above the composer: where your eyes already are when you talk to a task. */}
      <div className="absolute bottom-[108px] left-1/2 flex -translate-x-1/2 flex-col items-center">
        <Float shape={open ? 'card' : 'pill'} className={cn('vn-morph relative flex flex-col', open ? 'h-[620px] w-[420px] overflow-visible' : 'h-12 w-[500px] overflow-hidden')}>
          {open ? (
            <Card
              scene={scene}
              orb={128}
              head={
                <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
                  <Icon name="waveform" size={14} className="text-muted" />
                  <span className="text-sm text-fg-strong">Voice</span>
                  <span className="font-mono text-caption text-tertiary tnum">{scene.time}</span>
                  <span className="flex-1" />
                  <EngineToken scene={scene} />
                  <IconButton icon="collapse" label="Back to the capsule" size="sm" onClick={() => setOpen(false)} />
                </div>
              }
            />
          ) : (
            <div className="flex h-12 items-center gap-2 pl-2 pr-1.5 motion-safe:animate-fade-in" data-vn-capsule="pill">
              <PillBody scene={scene} onAnswer={() => setOpen(true)} />
              <span className="flex-1" />
              <span className="mx-1 h-4 w-px bg-border" aria-hidden />
              <MuteButton scene={scene} />
              <IconButton icon="expand" label="Open" size="sm" onClick={() => setOpen(true)} />
              <EndButton />
            </div>
          )}
        </Float>
      </div>
    </div>
  )
}

// ── Mini window ───────────────────────────────────────────────────────────

/** A stand-in for the editor you're in: the mini window floats over another app. Not part of the design. */
function EditorBackdrop() {
  const widths = [62, 48, 74, 30, 0, 55, 68, 41, 0, 72, 36, 58, 64, 22, 0, 49, 70, 33, 61, 45]
  return (
    <div className="absolute inset-0 flex flex-col bg-chrome" aria-hidden>
      <div className="flex h-9 items-center gap-2 border-b border-border px-4 text-caption text-tertiary">
        <Icon name="code" size={13} />
        settings.ts — your editor
      </div>
      <div className="flex flex-col gap-2 px-14 py-6">
        {widths.map((w, i) => (
          <span key={i} className="h-2 rounded-full bg-border" style={{ width: `${w}%`, opacity: w ? 1 : 0 }} />
        ))}
      </div>
    </div>
  )
}

/**
 * Its own always-on-top window. At rest a pill (the window is the pill's
 * size); it opens into a card while the pointer or focus is on it, while a
 * popover or the drawer is open, or while it needs you, then closes again.
 * The window mirrors the main window's session: the mic and the voice stay
 * there.
 */
/**
 * The pill's row, which is also the open window's top row: it never moves
 * when the window opens, so the pointer that opened it is still over the
 * same control.
 */
function MiniRow({ scene }: { scene: Scene }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 pl-2 pr-1.5">
      <PillBody scene={scene} words={150} />
      <span className="flex-1" />
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <MuteButton scene={scene} />
      <EndButton />
    </div>
  )
}

/** Open after the pointer rests a moment (passing over doesn't open it), close a moment after it leaves. */
const HOVER_OPEN_MS = 300
const HOVER_CLOSE_MS = 400

export function Mini({ scene, open: forced }: { scene: Scene; open: boolean }) {
  const { pop } = useContext(PopContext)
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const intend = (on: boolean): void => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setHover(on), on ? HOVER_OPEN_MS : HOVER_CLOSE_MS)
  }
  const open = forced || hover || focus || pop !== 'none' || scene.state === 'waiting_on_you'
  return (
    <div className="relative flex-1">
      <EditorBackdrop />
      {/* Positioned on its own wrapper, not on Field: cn() has no merge, so Field's \`relative\` would beat an appended \`absolute\`. */}
      <div
        className={cn('vn-morph absolute right-6 top-6 overflow-hidden', open ? 'vy-menu h-[600px] w-[380px]' : 'h-12 w-[380px] rounded-full bg-bg shadow-menu')}
        onMouseEnter={() => intend(true)}
        onMouseLeave={() => intend(false)}
        onFocus={() => setFocus(true)}
        onBlur={(e) => setFocus(e.currentTarget.contains(e.relatedTarget as Node | null))}
        data-vn-mini={open ? 'open' : 'pill'}
      >
        <Field className="h-full">
          {/* The row stays put; the window grows below it. Field is a column, so the row is its own element (no flex-col/flex-row pair through cn()). */}
          <MiniRow scene={scene} />
          {open ? (
            <div className={cn('flex min-h-0 flex-1 flex-col border-t motion-safe:animate-fade-in', BORDER_DIVIDER)}>
              <Card
                scene={scene}
                // Smaller than the capsule card's: the pill row sits above it in the same 600px window.
                orb={112}
                head={null}
                dock={
                  // Mute and End are in the row above; here the rest, and the window's own: keep on top, open the app.
                  <Dock
                    scene={scene}
                    compact
                    bare
                    extra={
                      <>
                        <IconButton icon="pin" label="Keep on top" size="sm" active aria-pressed />
                        <IconButton icon="external" label="Open in Agent V" size="sm" />
                      </>
                    }
                  />
                }
              />
            </div>
          ) : null}
        </Field>
      </div>
    </div>
  )
}

// ── After End ─────────────────────────────────────────────────────────────

/** "2 tasks done · 1 still going", or what happened when no work was handed over. */
function summaryTitle(): string {
  const done = SUMMARY.tasks.filter((t) => t.state === 'done').length
  const going = SUMMARY.tasks.filter((t) => t.state === 'running').length
  const failed = SUMMARY.tasks.filter((t) => t.state === 'failed').length
  if (SUMMARY.tasks.length === 0) return 'Nothing handed over'
  return [done ? `${done} task${done === 1 ? '' : 's'} done` : null, going ? `${going} still going` : null, failed ? `${failed} stopped` : null].filter(Boolean).join(' · ')
}

/**
 * The outcomes and two buttons. Each task is a row that opens it (and
 * closes the summary); Conversation shows what was said, Talk again starts
 * a new session here.
 */
export function Summary({ scene }: { scene: Scene }) {
  const { pop, setPop } = useContext(PopContext)
  const { setPlacement } = useContext(PlacementContext)
  const showing = pop === 'history'
  return (
    <Field className="flex-1">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <Icon name="waveform" size={14} className="text-muted" />
        <h2 className="m-0 text-sm text-fg-strong">{showing ? 'Conversation' : 'Voice'}</h2>
        <span className="font-mono text-caption text-tertiary tnum">{`Ended · ${scene.time}`}</span>
        <span className="flex-1" />
        {showing ? (
          <Button size="xs" variant="ghost" icon="arrowLeft" onClick={() => setPop('none')}>
            Summary
          </Button>
        ) : null}
        <IconButton icon="close" label="Close" size="sm" />
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {showing ? (
          <div className="mx-auto max-w-[720px]">
            <HistoryList scene={scene} />
          </div>
        ) : (
          <div className="mx-auto flex max-w-[640px] flex-col gap-6 px-8 py-14">
            <div>
              <p className="m-0 text-display text-fg-strong">{summaryTitle()}</p>
              <p className="m-0 mt-1 text-sm text-muted">{`Talked for ${SUMMARY.length}`}</p>
            </div>
            <ol className="m-0 flex list-none flex-col p-0">
              {SUMMARY.tasks.map((t) => (
                <li key={t.title} className={cn('border-t', BORDER_DIVIDER)}>
                  <button type="button" className={cn('group flex w-full min-w-0 items-start gap-3 rounded-md px-2 py-3 text-left focus-visible:vy-focus-ring', ROW_HOVER)}>
                    <span className="sr-only">Open task: </span>
                    <StatusGlyph state={t.state} size={14} className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm text-fg-strong">{t.title}</span>
                        <span className="shrink-0 font-mono text-caption text-tertiary tnum">{t.state === 'running' ? 'still going' : t.elapsed}</span>
                      </span>
                      <span className="mt-0.5 block text-sm text-secondary">{t.outcome}</span>
                    </span>
                    <Icon name="arrowRight" size={14} className="mt-0.5 shrink-0 text-tertiary group-hover:text-fg" />
                  </button>
                </li>
              ))}
            </ol>
            <div className="flex items-center gap-2">
              <Button size="md" variant="primary" icon="waveform" onClick={() => setPlacement(last.placement)}>
                Talk again
              </Button>
              <Button size="md" variant="secondary" icon="chat" onClick={() => setPop('history')}>
                Conversation
              </Button>
            </div>
          </div>
        )}
      </div>
    </Field>
  )
}

/** What a hold puts in your mouth in the mockup; over a reply, it cuts in. */
const HELD_WORDS = { over: 'Wait, check the Linux path too', fresh: 'And check the Linux path too' }

/** Where Talk again goes back to: the placement the session was in when it ended (set after render, read on click). */
const last: { placement: Placement } = { placement: 'orb' }

/** A second Esc within this long ends voice mode (the app's double-press window). */
const ESC_MS = 2000

type TalkState = {
  id: string
  muted: boolean
  holding: boolean
  /** What a finished hold said: it becomes your turn, and it thinks. */
  sent?: string
  /** The reply that turn talked over, or that Stop / Esc cut short. */
  cut?: string
  /** Stop speaking (or Esc) while it spoke. */
  stopped: boolean
}

/**
 * Mute, hold-to-talk, stop and Esc for the frame, and the scene they make:
 * muted is Muted; held is Listening with your words coming in (over a reply
 * it cuts it off); letting go sends them and it thinks; Stop or Esc while it
 * speaks cuts the reply and it listens; a second Esc ends. Resets when the
 * scene changes.
 */
function useTalk(base: Scene, id: string, end: () => void): { scene: Scene; value: Talk } {
  const fresh: TalkState = { id, muted: base.state === 'paused', holding: false, stopped: false }
  const [talk, setTalk] = useState(fresh)
  const cur = talk.id === id ? talk : fresh
  if (talk.id !== id) setTalk(fresh)
  const update = (f: (t: TalkState) => TalkState): void => setTalk((t) => f(t.id === id ? t : fresh))
  const live = base.state !== 'error' && base.state !== 'connecting' && base.state !== 'off'
  const speaking = base.state === 'speaking' && !cur.stopped && !cur.sent
  let scene = base
  // Holding talks even while muted (push-to-talk); otherwise muted wins over everything it would hear or say.
  const sentEntries = cur.sent ? [...base.entries, { id: 'held', who: 'you' as const, text: cur.sent }] : base.entries
  if (cur.holding && live)
    scene = { ...base, state: 'hearing', saying: undefined, partial: speaking ? HELD_WORDS.over : HELD_WORDS.fresh, cut: speaking ? base.saying : cur.cut }
  else if (cur.muted && live) scene = { ...base, state: 'paused', saying: undefined, cut: cur.cut, entries: sentEntries }
  else if (cur.sent && live) scene = { ...base, state: 'thinking', saying: undefined, partial: undefined, cut: cur.cut, entries: sentEntries }
  else if (cur.stopped && base.state === 'speaking') scene = { ...base, state: 'listening', saying: undefined, cut: cur.cut }
  else if (!cur.muted && base.state === 'paused') scene = { ...base, state: 'listening' }
  return {
    scene,
    value: {
      muted: scene.state === 'paused',
      holding: cur.holding,
      toggleMute: () => update((t) => ({ ...t, muted: !t.muted })),
      hold: (on) =>
        update((t) => {
          if (on) return t.holding || !live ? t : { ...t, holding: true }
          if (!t.holding) return t
          // Letting go sends what you said; a hold over a reply leaves it cut.
          const over = base.state === 'speaking' && !t.stopped && !t.sent
          return { ...t, holding: false, sent: over ? HELD_WORDS.over : HELD_WORDS.fresh, cut: over ? base.saying : t.cut }
        }),
      stopSpeaking: () => update((t) => (base.state === 'speaking' && !t.stopped ? { ...t, stopped: true, cut: base.saying } : t)),
      end
    }
  }
}

/**
 * The frame's keys, as the hints show them: Space held is hold-to-talk, M
 * mutes, Esc closes what's open, else stops it speaking and arms End; a
 * second Esc ends. Only for keys inside the frame (the viewer's own controls
 * keep theirs), and never while typing in a field.
 */
function useVoiceKeys(talk: Talk, escArmed: boolean, arm: () => void, speaking: boolean) {
  const { pop, setPop } = useContext(PopContext)
  useEffect(() => {
    const mine = (e: KeyboardEvent): boolean => {
      const t = e.target as HTMLElement | null
      if (!t || t.closest('input, textarea, select, [contenteditable="true"]')) return false
      return t === document.body || Boolean(t.closest('[data-skin]'))
    }
    const down = (e: KeyboardEvent): void => {
      if (!mine(e) || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === ' ') {
        // Space is hold-to-talk everywhere in voice mode, even on a focused button.
        e.preventDefault()
        if (!e.repeat) talk.hold(true)
      } else if (e.key === 'm' || e.key === 'M') {
        if (!e.repeat) talk.toggleMute()
      } else if (e.key === 'Escape') {
        if (pop !== 'none') return setPop('none')
        if (escArmed) return talk.end()
        if (speaking) talk.stopSpeaking()
        arm()
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key !== ' ' || !mine(e)) return
      e.preventDefault()
      talk.hold(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [talk, escArmed, arm, speaking, pop, setPop])
}

/** useTalk plus the one thing only the keys do: arm Esc. */
function useFrameTalk(base: Scene, id: string, end: () => void): { scene: Scene; value: Talk; arm: () => void } {
  const [armedAt, setArmedAt] = useState<{ id: string; on: boolean }>({ id, on: false })
  const armed = armedAt.id === id && armedAt.on
  const { scene, value } = useTalk(armed ? { ...base, escArmed: true } : base, id, end)
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmedAt({ id, on: false }), ESC_MS)
    return () => window.clearTimeout(t)
  }, [armed, id])
  return { scene, value, arm: () => setArmedAt({ id, on: true }) }
}

export function NextFrame({ placement, scene: base, sceneId }: { placement: Placement; scene: Scene; sceneId: string }) {
  const { setPlacement } = useContext(PlacementContext)
  useEffect(() => {
    if (placement !== 'summary') last.placement = placement
  }, [placement])
  const { scene, value, arm } = useFrameTalk(base, `${sceneId}:${placement}`, () => setPlacement('summary'))
  useVoiceKeys(value, Boolean(scene.escArmed), arm, scene.state === 'speaking')
  return (
    <TalkContext.Provider value={value}>
      <Placed placement={placement} scene={scene} />
    </TalkContext.Provider>
  )
}

function Placed({ placement, scene }: { placement: Placement; scene: Scene }) {
  switch (placement) {
    case 'inline':
      return <Inline scene={scene} />
    case 'companion':
      return <Companion scene={scene} />
    case 'conversation':
      return <TakeoverConversation scene={scene} />
    case 'orb':
      return <TakeoverOrb scene={scene} />
    case 'split':
      return <TakeoverSplit scene={scene} />
    case 'capsule':
      return <Capsule scene={scene} open={false} />
    case 'capsule-open':
      return <Capsule scene={scene} open />
    case 'mini':
      return <Mini scene={scene} open={false} />
    case 'mini-open':
      return <Mini scene={scene} open />
    case 'summary':
      return <Summary scene={scene} />
  }
}
