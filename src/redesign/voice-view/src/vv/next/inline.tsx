import { useContext, useEffect, useRef } from 'react'
import type { VoiceSessionState } from '@shared/voiceSession'
import { Button, IconButton, StatusGlyph, cn } from '@renderer/lib/ui'
import type { Scene } from '../data'
import { WHO } from '../parts'
import { CaptionsContext, CutReply, EngineToken, InterruptCue, KeyHints, LiveWave, MicMeter, Notice, PopContext, Popovers, Spoken, TalkContext, WorkStrip, useLevel, useStyle, workGlyph } from './kit'
import { HEADLINE, hint, history, work as workOf } from './model'

/*
  Inline (2026-10-15, fifth placement, from Claude's own voice mode): voice
  stays in the task's thread. No orb and no panel: what you say and what it
  answers are rows of the thread, its reply lit word by word as it's spoken,
  each hand-off a work block in place. The composer becomes the voice
  control: it says the state where the placeholder was (your words as you
  say them), and a glow rising behind it breathes while it listens and
  follows the voice level while you or it speak.
*/

/** The glow's colour per state; null is none (muted, off). */
const GLOW: Record<VoiceSessionState, string | null> = {
  off: null,
  connecting: '--vy-muted',
  listening: '--vy-accent',
  hearing: '--vy-accent',
  thinking: '--vy-accent',
  working: '--vy-accent',
  speaking: '--vy-accent',
  waiting_on_you: '--vy-accent',
  paused: null,
  reconnecting: '--vy-warning',
  error: '--vy-danger'
}

/**
 * Light rising from behind the composer. The outer layer breathes (CSS,
 * still under reduced motion); the inner follows the voice level in an
 * animation frame, never through React state.
 */
function Glow({ state }: { state: VoiceSessionState }) {
  const style = useStyle()
  const inner = useRef<HTMLDivElement>(null)
  const level = useLevel()
  const live = state === 'hearing' || state === 'speaking'
  const tone = GLOW[state]
  useEffect(() => {
    const el = inner.current
    if (!el) return
    el.style.transform = ''
    if (!live || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    let s = 0
    const tick = (): void => {
      s += (level() - s) * 0.18
      el.style.transform = `scale(${(1 + s * 0.22).toFixed(3)}, ${(1 + s * 0.45).toFixed(3)})`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [live, level])
  // Ambient is the bolder style: a stronger, taller pool of light.
  const strength = style === 'ambient' ? 55 : 34
  return (
    <div className={cn('pointer-events-none absolute inset-x-0 bottom-0 h-[380px] transition-opacity duration-300', tone ? (state === 'listening' ? 'vn-breathe' : null) : 'opacity-0')} aria-hidden>
      <div
        ref={inner}
        className="absolute inset-0 origin-bottom transition-[background] duration-300"
        style={{
          background: tone
            ? `radial-gradient(46% 62% at 50% 92%, color-mix(in srgb, var(${tone}) ${strength}%, transparent), transparent 72%), radial-gradient(70% 34% at 50% 100%, color-mix(in srgb, var(${tone}) ${Math.round(strength / 2)}%, transparent), transparent 80%)`
            : undefined
        }}
      />
    </div>
  )
}

/** What the composer says where its placeholder was: the state, and the one thing to know. */
function placeholder(s: Scene): string {
  if (s.state === 'error') return s.problem?.message ?? 'Voice stopped'
  // An ellipsis only while something is under way; "Needs you" and "Muted" are states, not progress.
  const ongoing = s.state !== 'waiting_on_you' && s.state !== 'paused'
  const head = `${HEADLINE[s.state]}${ongoing ? '…' : ''}`
  const h = hint(s)
  return h ? `${head} · ${h}` : head
}

/** The composer as the voice control: state or your live words, the mic and its settings, Stop while it speaks, End. */
function VoiceComposer({ scene }: { scene: Scene }) {
  const { pop, setPop } = useContext(PopContext)
  const talk = useContext(TalkContext)
  const muted = scene.state === 'paused'
  const dead = scene.state === 'error' || scene.state === 'connecting'
  const settingsOpen = pop === 'voice' || pop === 'devices' || pop === 'layout'
  return (
    <div className="relative mx-auto flex h-14 w-full max-w-[760px] items-center gap-2 rounded-xl border border-border bg-surface pl-4 pr-2 shadow-menu" data-vn-composer={scene.state}>
      {/* The state is announced; your words as they come in are not (a word-by-word stream would drown a screen reader). */}
      <span className="sr-only" role="status" aria-live="polite">
        {HEADLINE[scene.state]}
      </span>
      <p className={cn('m-0 min-w-0 flex-1 truncate text-md', scene.partial ? 'text-fg-strong' : scene.state === 'error' ? 'text-danger' : 'text-tertiary')} aria-live="off">
        {scene.partial ? (
          <>
            {scene.partial}
            <span className="vn-caret ml-0.5 inline-block h-[1em] w-0.5 translate-y-[0.15em] bg-accent" aria-hidden />
          </>
        ) : (
          <span className="flex min-w-0 items-center gap-2">
            {/* While it speaks, the way in: talk over it. */}
            {scene.state === 'speaking' ? <InterruptCue /> : null}
            <span className="truncate">{placeholder(scene)}</span>
          </span>
        )}
      </p>
      <LiveWave state={scene.state} width={96} height={24} />
      <span className="flex shrink-0 items-center">
        <Button size="sm" variant="ghost" icon={muted ? 'micSlash' : 'mic'} aria-pressed={muted} aria-label="Mute" disabled={dead} onClick={talk.toggleMute}>
          {muted || dead ? null : <MicMeter live />}
        </Button>
        <IconButton icon="chevron" label="Voice, devices and layout" size="xs" active={settingsOpen} aria-expanded={settingsOpen} onClick={() => setPop(settingsOpen ? 'none' : 'voice')} />
      </span>
      {scene.state === 'speaking' ? (
        <Button size="sm" variant="primary" icon="stop" onClick={talk.stopSpeaking}>
          Stop
        </Button>
      ) : scene.state === 'working' || scene.state === 'waiting_on_you' ? (
        <Button size="sm" variant="secondary" icon="stop">
          Stop task
        </Button>
      ) : null}
      <Button size="sm" variant="secondary" icon="close" onClick={talk.end}>
        End
      </Button>
      <Popovers />
    </div>
  )
}

/** The thread: your words, its replies (the one being spoken lit word by word), each hand-off as a work block. */
function Thread({ scene }: { scene: Scene }) {
  const words = useContext(CaptionsContext)
  const end = useRef<HTMLDivElement>(null)
  const rows = history(scene).filter((e) => words || e.who === 'work')
  const lastVoice = rows.map((e) => e.who).lastIndexOf('voice')
  // A block body: Chromium's scrollIntoView now returns a promise, and an effect may only return its clean-up.
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' })
  }, [rows.length])
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8 px-2 pb-8 pt-12">
      {rows.length === 0 ? <p className="m-0 text-heading text-tertiary">Say what you want done. It listens for as long as voice mode is on.</p> : null}
      {rows.map((e, i) =>
        e.who === 'work' ? (
          <WorkStrip key={e.id} scene={scene} work={e.work} />
        ) : e.who === 'you' ? (
          <div key={e.id} className="flex flex-col gap-1" data-vn-line="you">
            <span className="text-caption text-tertiary">{WHO.you}</span>
            <p className={cn('m-0 text-md leading-relaxed', e.unanswered ? 'text-muted' : 'text-fg-strong')}>
              {e.text}
              {e.unanswered ? <span className="ml-2 text-caption text-tertiary">Not answered</span> : null}
            </p>
          </div>
        ) : (
          <div key={e.id} className="flex flex-col gap-1" data-vn-line="voice">
            <span className="text-caption text-tertiary">{WHO.voice}</span>
            {i === lastVoice && scene.cut ? (
              <CutReply text={scene.cut} className="text-heading" />
            ) : (
              <p className="m-0 text-heading leading-relaxed text-fg">
                <Spoken text={e.text} live={i === lastVoice && scene.state === 'speaking'} />
              </p>
            )}
          </div>
        )
      )}
      {words ? null : <p className="m-0 text-caption text-tertiary">Captions are off. It still speaks; the work stays here.</p>}
      <div ref={end} />
    </div>
  )
}

export function Inline({ scene }: { scene: Scene }) {
  const style = useStyle()
  const w = workOf(scene)
  return (
    <div className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col', style === 'ambient' ? 'vn-ambient-dim vn-grain' : 'bg-bg')}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <StatusGlyph state={w ? workGlyph(w) : 'queued'} size={13} />
        <span className="min-w-0 flex-1 truncate text-sm text-fg-strong">{scene.task?.title ?? 'New task'}</span>
        <span className="flex items-center gap-1.5 text-caption text-tertiary">
          <span className="font-mono tnum">{scene.time}</span>
        </span>
      </div>
      <Glow state={scene.state} />
      <div className="scroll-thin relative min-h-0 flex-1 overflow-y-auto px-12">
        <Thread scene={scene} />
      </div>
      <div className="relative shrink-0 px-12 pb-3">
        <div className="mx-auto mb-2 flex max-w-[760px] justify-start empty:hidden">
          <Notice scene={scene} align="start" />
        </div>
        <VoiceComposer scene={scene} />
        <div className="mx-auto flex h-9 max-w-[760px] items-center gap-4 text-caption text-tertiary">
          <span className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden">
            <KeyHints scene={scene} />
          </span>
          <EngineToken scene={scene} />
        </div>
      </div>
    </div>
  )
}
