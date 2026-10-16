import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { VOICE_COMPANION_WIDTH } from '@shared/ipc/schemas/voice'
import type { VoiceSessionState } from '@shared/voiceSession'
import { Icon } from '@renderer/lib/icons'
import { Button, IconButton, PanelResizeHandle, StatusGlyph, cn } from '@renderer/lib/ui'
import { BORDER_DIVIDER, ROW_HOVER } from '@renderer/lib/utils/layout'
import { formatTime, sessionNotes } from '../VoiceBar'
import { WHO, buildEntries, workGlyph } from '../view/parts'
import {
  Captions,
  CutReply,
  Dock,
  EngineToken,
  Field,
  Float,
  HistoryDrawer,
  HistoryList,
  InterruptCue,
  KeyHints,
  LiveWave,
  MuteButton,
  Notice,
  PopContext,
  Popovers,
  StageHeader,
  StageOrb,
  StateLine,
  StopButton,
  Spoken,
  WorkPane,
  WorkStrip,
  usePop,
  useCover,
  useNow,
  useStage
} from './kit'
import { exchange, headline, hint, latestWork, summaryTasks, summaryTitle, type SummaryTask } from './model'

/*
  The five placements (docs/voice-mode.md §26), one structure: orb · what's
  happening · the current exchange as captions · the task's strip · the
  dock; history in a drawer over the stage; voice, devices and layout in one
  popover.

  Inline     covers the task pane: the voice thread, the composer as the voice control, a glow behind it.
  Companion  a column docked right of the task, dragged to width.
  Takeover   the whole window under the title bar, sidebar included: Words, Orb or Split.
  Capsule    a pill at the bottom of the pane, growing into a card.
  (Mini      its own window: mini/MiniVoice.tsx.)
  Summary    what End leaves: the outcomes and two buttons.
*/

/** One status for the whole surface: state changes are announced, the words are not (too fast to be useful read out). */
function Announce() {
  const { v } = useStage()
  return (
    <span className="sr-only" role="status" aria-live="polite">
      {headline(v)}
    </span>
  )
}

/** A surface's own popover state, shared with everything in it. */
function WithPop({ children }: { children: ReactNode }) {
  const pop = usePop()
  return <PopContext.Provider value={pop}>{children}</PopContext.Provider>
}

// ── Inline ─────────────────────────────────────────────────────────────────

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
 * Light rising from behind the composer. The outer layer breathes (still
 * under reduced motion); the inner follows the voice level in an animation
 * frame, never through React state.
 */
function Glow() {
  const { v, settings, level } = useStage()
  const inner = useRef<HTMLDivElement>(null)
  const live = v.state === 'hearing' || v.state === 'speaking'
  const tone = GLOW[v.state]
  useEffect(() => {
    const el = inner.current
    if (!el) return
    el.style.transform = ''
    if (!live || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    let s = 0
    const tick = (): void => {
      s += (Math.min(1, Math.max(0, level())) - s) * 0.18
      el.style.transform = `scale(${(1 + s * 0.22).toFixed(3)}, ${(1 + s * 0.45).toFixed(3)})`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [live, level])
  // Ambient is the bolder style: a stronger pool of light.
  const strength = settings.style === 'ambient' ? 55 : 34
  return (
    <div
      className={cn('pointer-events-none absolute inset-x-0 bottom-0 h-[380px] transition-opacity duration-300', tone ? (v.state === 'listening' ? 'vy-voice-breathe' : null) : 'opacity-0')}
      aria-hidden
      data-voice-glow={tone ? v.state : 'none'}
    >
      <div
        ref={inner}
        className="absolute inset-0 origin-bottom"
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
function placeholder(api: ReturnType<typeof useStage>, now: number): string {
  const { v, settings } = api
  const entry = latestWork(v)
  const line = hint(v, settings, entry, now)
  if (v.state === 'error') return 'Voice mode stopped'
  // An ellipsis only while something is under way; "Needs you" and "Muted" are states, not progress.
  const ongoing = v.state !== 'waiting_on_you' && v.state !== 'paused'
  const head = `${headline(v)}${ongoing ? '…' : ''}`
  return line ? `${head} · ${line}` : head
}

/** The composer as the voice control: the state or your words as you say them, the mic and its settings, Stop, End. */
function VoiceComposer() {
  const api = useStage()
  const { v, settings } = api
  const { pop, setPop } = useContext(PopContext)
  const now = useNow()
  const settingsOpen = pop === 'voice' || pop === 'devices' || pop === 'layout'
  const partial = settings.captions && v.state === 'hearing' ? v.partial : ''
  return (
    <div className="relative mx-auto flex h-14 w-full max-w-[760px] items-center gap-2 rounded-xl border border-border bg-surface pl-4 pr-2 shadow-menu" data-voice-composer={v.state}>
      <p className={cn('m-0 min-w-0 flex-1 truncate text-md', partial ? 'text-fg-strong' : v.state === 'error' ? 'text-danger' : 'text-tertiary')} aria-live="off">
        {partial ? (
          <>
            {partial}
            <span className="vy-caret ml-0.5 inline-block h-[1em] w-0.5 translate-y-[0.15em] bg-accent" aria-hidden />
          </>
        ) : (
          <span className="flex min-w-0 items-center gap-2">
            {v.state === 'speaking' ? <InterruptCue /> : null}
            <span className="truncate">{placeholder(api, now)}</span>
          </span>
        )}
      </p>
      <LiveWave width={96} height={24} />
      <span className="flex shrink-0 items-center">
        <MuteButton compact />
        <IconButton icon="chevron" label="Voice, devices and layout" size="xs" active={settingsOpen} aria-expanded={settingsOpen} onClick={() => setPop(settingsOpen ? 'none' : api.pickers ? 'voice' : 'layout')} data-voice-settings-button />
      </span>
      <StopButton compact />
      <Button size="sm" variant="secondary" icon="close" onClick={api.end} data-voice-end>
        End
      </Button>
      <Popovers />
    </div>
  )
}

/** The voice thread: your words, its replies (the one being spoken lit word by word), each hand-off as its work in place. */
function Thread() {
  const { v, settings } = useStage()
  const end = useRef<HTMLDivElement>(null)
  const words = settings.captions
  const rows = useMemo(() => buildEntries(v.transcript, v.works).filter((e) => words || e.who === 'work'), [v.transcript, v.works, words])
  const lastVoice = rows.map((e) => e.who).lastIndexOf('voice')
  const x = exchange(v)
  const partial = words && v.state === 'hearing' ? v.partial : ''
  // A block body: Chromium's scrollIntoView now returns a promise, and an effect may only return its clean-up.
  useEffect(() => {
    void end.current?.scrollIntoView?.({ block: 'end' })
  }, [rows.length, partial])
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-8 px-2 pb-8 pt-12" data-voice-transcript>
      {rows.length === 0 ? <p className="m-0 text-heading text-tertiary">Say what you want done. It listens for as long as voice mode is on.</p> : null}
      {rows.map((e, i) =>
        e.who === 'work' ? (
          <WorkStrip key={e.id} entry={e} />
        ) : e.who === 'you' ? (
          <div key={e.id} className="flex flex-col gap-1" data-voice-line="you" data-voice-unanswered={e.unanswered || undefined}>
            <span className="text-caption text-tertiary">{WHO.you}</span>
            <p className={cn('m-0 text-md leading-relaxed', e.unanswered ? 'text-muted' : 'text-fg-strong')}>
              {e.text}
              {e.unanswered ? <span className="ml-2 text-caption text-tertiary">Not answered</span> : null}
            </p>
          </div>
        ) : (
          <div key={e.id} className="flex flex-col gap-1" data-voice-line="voice">
            <span className="text-caption text-tertiary">{WHO.voice}</span>
            {e.id === v.cutLineId ? (
              <CutReply text={e.text} className="text-heading" />
            ) : (
              <p className="m-0 text-heading leading-relaxed text-fg">
                <Spoken text={e.text} piece={v.saying} live={i === lastVoice && x.live === 'voice' && x.voiceLineId === e.id} />
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

/**
 * Inline (§26.1): voice stays in the task. The thread fills the pane, the
 * composer becomes the voice control, and a glow behind it carries the
 * state. No orb, no panel.
 */
export function Inline() {
  const api = useStage()
  const entry = latestWork(api.v)
  // The task pane beneath is inert while the thread covers it.
  const cover = useCover<HTMLElement>()
  return (
    <WithPop>
      <section
        ref={cover}
        tabIndex={-1}
        className={cn('absolute inset-0 z-sticky flex min-h-0 flex-col outline-none', api.settings.style === 'ambient' ? 'vy-voice-ambient-dim vy-voice-grain' : 'bg-bg')}
        aria-label="Voice mode"
        data-voice-view={api.v.state}
        data-voice-placement="inline"
      >
        <Announce />
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
          <StatusGlyph state={entry ? workGlyph(entry) : 'queued'} size={13} />
          <span className="min-w-0 flex-1 truncate text-sm text-fg-strong">{entry?.brief ?? 'Voice'}</span>
          {api.showTask ? (
            <Button size="xs" variant="ghost" icon="minimize" onClick={api.showTask} data-voice-close-view>
              Show the task
            </Button>
          ) : null}
        </div>
        <Glow />
        <div className="scroll-thin relative min-h-0 flex-1 overflow-y-auto px-12">
          <Thread />
        </div>
        <div className="relative shrink-0 px-12 pb-3">
          <div className="mx-auto mb-2 flex max-w-[760px] justify-start empty:hidden">
            <Notice align="start" />
          </div>
          <VoiceComposer />
          <div className="mx-auto flex h-9 max-w-[760px] items-center gap-4 text-caption text-tertiary">
            <span className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden" data-voice-keys>
              <KeyHints />
            </span>
            <EngineToken />
          </div>
        </div>
      </section>
    </WithPop>
  )
}

// ── Companion ──────────────────────────────────────────────────────────────

/**
 * Companion (§26.2): a column docked right of the task, dragged to width
 * like the inspector. The record keeps the steps; the column keeps the
 * conversation, how far the task has got, and the controls.
 */
export function Companion() {
  const api = useStage()
  const [width, setWidth] = useState(api.settings.companionWidth)
  const saved = useRef(api.settings.companionWidth)
  // Read at save time: the session changes many times a second, and a new `api` must not restart the wait.
  const patch = useRef(api.patchSettings)
  patch.current = api.patchSettings
  useEffect(() => {
    saved.current = api.settings.companionWidth
    setWidth(api.settings.companionWidth)
  }, [api.settings.companionWidth])
  // Saved a moment after the drag settles, not on every pixel.
  useEffect(() => {
    if (width === saved.current) return
    const t = window.setTimeout(() => patch.current({ companionWidth: width }), 400)
    return () => window.clearTimeout(t)
  }, [width])
  return (
    <WithPop>
      <PanelResizeHandle
        label="Resize voice"
        value={width}
        min={VOICE_COMPANION_WIDTH.min}
        max={VOICE_COMPANION_WIDTH.max}
        defaultValue={VOICE_COMPANION_WIDTH.default}
        edge="start"
        onChange={setWidth}
        hairline
      />
      <Field as="aside" className="shrink-0 border-l border-border" label="Voice mode">
        {/* Never more than half the window: on a narrow one the task beside it keeps its room. */}
        <div className="flex min-h-0 flex-1 flex-col" style={{ width, maxWidth: '50vw' }} data-voice-view={api.v.state} data-voice-placement="companion">
          <Announce />
          <StageHeader>
            <EngineToken />
            {api.showTask ? <IconButton icon="collapse" label="Shrink to a capsule" size="sm" onClick={api.showTask} data-voice-close-view /> : null}
          </StageHeader>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div className="scroll-thin flex min-h-0 flex-1 flex-col items-center gap-6 overflow-y-auto px-9 pb-5 pt-12">
              <StageOrb size={200} />
              <StateLine size="title" escNote />
              <Notice />
              <Captions size="heading" lines={4} />
              <span className="flex-1" />
              <WorkStrip />
            </div>
            <HistoryDrawer width="100%" />
          </div>
          <Dock compact />
        </div>
      </Field>
    </WithPop>
  )
}

// ── Takeover ───────────────────────────────────────────────────────────────

/** The whole window under the title bar: the sidebar gives way too. "Show the task" brings the app back. */
function TakeoverShell({ children, layout }: { children: ReactNode; layout: 'conversation' | 'orb' | 'split' }) {
  const api = useStage()
  return (
    <WithPop>
      <Field as="section" cover label="Voice mode">
        <div className="flex min-h-0 flex-1 flex-col" data-voice-view={api.v.state} data-voice-placement="takeover" data-voice-layout={layout}>
          <Announce />
          <StageHeader>
            <EngineToken />
            {api.showTask ? (
              <Button size="xs" variant="ghost" icon="minimize" onClick={api.showTask} data-voice-close-view>
                Show the task
              </Button>
            ) : null}
          </StageHeader>
          <div className="relative flex min-h-0 flex-1">
            {children}
            <HistoryDrawer />
          </div>
          <Dock />
        </div>
      </Field>
    </WithPop>
  )
}

/** Words: what was just said is the hero at display size, the orb above it, a ribbon of the voice under it. */
function TakeoverWords() {
  const { v } = useStage()
  const x = exchange(v)
  return (
    <TakeoverShell layout="conversation">
      <div className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col items-center overflow-y-auto px-16 pb-8 pt-16">
        <div className="flex w-full max-w-[780px] flex-1 flex-col gap-10">
          <div className="flex items-center gap-6">
            <StageOrb size={104} />
            <StateLine size="title" align="start" />
          </div>
          <Notice align="start" />
          {x.you || x.voice || v.cutLineId ? <Captions size="display" align="start" lines={4} /> : <p className="m-0 text-display leading-snug text-tertiary">Say what you want done.</p>}
          <LiveWave width={320} />
          <span className="flex-1" />
          <WorkStrip />
        </div>
      </div>
    </TakeoverShell>
  )
}

/** Orb: the sphere is the hero; the exchange and the task's strip under it. */
function TakeoverOrb() {
  return (
    <TakeoverShell layout="orb">
      <div className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col items-center gap-7 overflow-y-auto px-16 pb-6 pt-10">
        <StageOrb size={232} />
        <StateLine size="title" />
        <Notice />
        <div className="w-full max-w-[640px]">
          <Captions size="title" />
        </div>
        <span className="flex-1" />
        <div className="w-full max-w-[560px]">
          <WorkStrip />
        </div>
      </div>
    </TakeoverShell>
  )
}

/** Split: the stage on the left; the task's every step, question and full answer on the right. */
function TakeoverSplit() {
  const api = useStage()
  const entry = latestWork(api.v)
  const w = entry && !entry.continued ? entry.work : undefined
  return (
    <TakeoverShell layout="split">
      <div className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col items-center gap-8 overflow-y-auto px-12 pb-8 pt-16">
        <StageOrb size={224} />
        {/* The task pane says how far it has got. */}
        <StateLine size="title" sub={api.v.state === 'working' ? 'It keeps going while you talk' : undefined} />
        <Notice />
        <div className="w-full max-w-[480px]">
          <Captions size="heading" lines={4} />
        </div>
      </div>
      <aside className={cn('flex w-[42%] min-w-[340px] max-w-[560px] shrink-0 flex-col', api.settings.style === 'ambient' ? 'vy-voice-glass-pane' : 'vy-panel')} aria-label="Its task">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
          <StatusGlyph state={entry ? workGlyph(entry) : 'queued'} size={13} />
          <span className={cn('min-w-0 flex-1 truncate text-sm', entry ? 'text-fg-strong' : 'text-muted')}>{entry ? 'Its task' : 'No work yet'}</span>
          {w && !entry?.failed ? <span className="font-mono text-caption text-tertiary tnum">{`${w.stepCount} step${w.stepCount === 1 ? '' : 's'}`}</span> : null}
        </div>
        {entry ? (
          <WorkPane entry={entry} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
            <Icon name="tasks" size={20} className="text-tertiary" />
            <p className="m-0 max-w-[260px] text-sm text-muted">Ask it to do something; its steps show here as it works.</p>
          </div>
        )}
      </aside>
    </TakeoverShell>
  )
}

/** Takeover (§26.3) in the layout Settings › Voice mode (or the Layout tab) picked. */
export function Takeover() {
  const { settings } = useStage()
  return settings.viewLayout === 'orb' ? <TakeoverOrb /> : settings.viewLayout === 'split' ? <TakeoverSplit /> : <TakeoverWords />
}

// ── Capsule ────────────────────────────────────────────────────────────────

/** State, time, any trouble, the words being said, and Answer when it needs you. */
export function PillBody({ words = 260, onAnswer }: { words?: number; onAnswer?: () => void }) {
  const { v, settings, escArmed } = useStage()
  const x = exchange(v)
  const said = escArmed ? 'Press Esc again to end' : !settings.captions ? '' : x.live === 'voice' ? x.voice : x.live === 'you' ? x.you : ''
  const { problem, trouble } = useNotes()
  const notice = problem ?? trouble
  return (
    <>
      <StageOrb size={32} interactive={false} />
      <span className="shrink-0 text-sm text-fg-strong" data-voice-headline>
        {headline(v)}
      </span>
      <PillClock />
      {notice ? (
        <span className={cn('flex shrink-0', problem ? 'text-danger' : 'text-warning')} role="img" aria-label={notice.message} title={notice.message}>
          <Icon name="warningCircle" size={14} />
        </span>
      ) : null}
      {said ? (
        // min-w-0: the words give way before the controls do.
        <span className="min-w-0 truncate text-sm text-muted" style={{ maxWidth: words }}>
          {said}
        </span>
      ) : null}
      {v.state === 'hearing' || v.state === 'speaking' ? <LiveWave width={56} height={20} /> : null}
      {v.state === 'waiting_on_you' && onAnswer ? (
        <Button size="xs" variant="primary" onClick={onAnswer} data-voice-answer>
          Answer
        </Button>
      ) : null}
    </>
  )
}

function PillClock() {
  const { startedAt } = useStage()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return <span className="shrink-0 font-mono text-caption text-tertiary tnum">{formatTime(now - (startedAt ?? now))}</span>
}

function useNotes() {
  const { v } = useStage()
  return useMemo(() => sessionNotes(v), [v])
}

/** The card a pill opens into: the same stage, smaller. */
export function Card({ head, orb, dock }: { head: ReactNode; orb: number; dock?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col motion-safe:animate-fade-in" data-voice-capsule="card">
      {head}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="scroll-thin flex min-h-0 flex-1 flex-col items-center gap-5 overflow-y-auto px-7 pb-5 pt-8">
          <StageOrb size={orb} />
          <StateLine size="heading" escNote />
          <Notice />
          <Captions size="md" lines={3} />
          <span className="flex-1" />
          <WorkStrip />
        </div>
        <HistoryDrawer width="100%" />
      </div>
      {dock ?? <Dock compact />}
    </div>
  )
}

/**
 * Capsule (§26.4): one surface at the bottom of the pane that grows from the
 * pill into the card and back (width, height and corners ease together),
 * anchored at the bottom so it rises out of where the composer is.
 */
export function Capsule({ startOpen = false }: { startOpen?: boolean }) {
  const api = useStage()
  const [cardOpen, setCardOpen] = useState(startOpen)
  const open = cardOpen
  // Standing in for a placement that was put away ("Show the task" with no bar on screen): Open brings that placement back.
  const standIn = api.settings.placement !== 'capsule' && Boolean(api.openView)
  const setOpen = (on: boolean): void => {
    if (on && standIn) api.openView!()
    else setCardOpen(on)
  }
  return (
    <WithPop>
      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-sticky flex justify-center px-4" data-voice-placement="capsule" data-voice-view={api.v.state}>
        <Announce />
        <Float
          shape={open ? 'card' : 'pill'}
          className={cn('vy-voice-morph pointer-events-auto relative flex max-w-full flex-col', open ? 'h-[620px] max-h-[calc(100vh-160px)] w-[420px] overflow-visible' : 'h-12 w-[500px] overflow-hidden')}
        >
          {open ? (
            <Card
              orb={128}
              head={
                <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
                  <Icon name="waveform" size={14} className="text-muted" />
                  <span className="text-sm text-fg-strong">Voice</span>
                  <PillClock />
                  <span className="flex-1" />
                  <EngineToken />
                  <IconButton icon="collapse" label="Back to the capsule" size="sm" onClick={() => setOpen(false)} data-voice-capsule-close />
                </div>
              }
            />
          ) : (
            <div className="flex h-12 items-center gap-2 pl-2 pr-1.5 motion-safe:animate-fade-in" data-voice-capsule="pill" role="group" aria-label="Voice mode">
              <PillBody onAnswer={() => setOpen(true)} />
              <span className="flex-1" />
              <span className="mx-1 h-4 w-px bg-border" aria-hidden />
              <MuteButton compact />
              <IconButton icon="expand" label="Open" size="sm" onClick={() => setOpen(true)} data-voice-capsule-open />
              <IconButton icon="close" label="End voice mode" size="sm" onClick={api.end} data-voice-end />
            </div>
          )}
        </Float>
      </div>
    </WithPop>
  )
}

// ── After End ──────────────────────────────────────────────────────────────

/**
 * What End leaves (§26.7): the outcomes and two buttons. Each task is a row
 * that opens it (and closes the summary); Conversation shows what was said;
 * Talk again starts a session on the line you last used.
 */
export function Summary({
  endedAt,
  workspacePath,
  onClose,
  onOpenTask,
  onTalkAgain,
  onAllConversations
}: {
  endedAt: number
  workspacePath: string | null
  onClose: () => void
  onOpenTask?: (workspacePath: string, runId: string) => void
  /** False when there was no task line to start it on. */
  onTalkAgain: () => void
  onAllConversations?: () => void
}) {
  const { v, startedAt } = useStage()
  const [showing, setShowing] = useState(false)
  const tasks = useMemo(() => summaryTasks(v.transcript, v.works, endedAt), [v.transcript, v.works, endedAt])
  const length = formatDurationShort(endedAt - (startedAt ?? endedAt))
  // Esc closes it (capture, so it never also stops a run).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || document.querySelector('[aria-modal="true"], dialog[open]')) return
      e.preventDefault()
      e.stopPropagation()
      if (showing) setShowing(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [showing, onClose])
  return (
    <Field as="section" cover label="Voice summary">
      <div className="flex min-h-0 flex-1 flex-col" data-voice-ended data-voice-summary={showing ? 'conversation' : 'summary'}>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
          <Icon name="waveform" size={14} className="text-muted" />
          <h2 className="m-0 text-sm text-fg-strong">{showing ? 'Conversation' : 'Voice'}</h2>
          <span className="font-mono text-caption text-tertiary tnum">{`Ended · ${formatTime(endedAt - (startedAt ?? endedAt))}`}</span>
          <span className="flex-1" />
          {showing ? (
            <Button size="xs" variant="ghost" icon="arrowLeft" onClick={() => setShowing(false)} data-voice-summary-back>
              Summary
            </Button>
          ) : null}
          {onAllConversations && workspacePath ? (
            <Button size="xs" variant="ghost" icon="clock" onClick={onAllConversations} data-voice-ended-history>
              All voice conversations
            </Button>
          ) : null}
          <IconButton icon="close" label="Close" size="sm" onClick={onClose} data-voice-ended-close />
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {showing ? (
            <div className="mx-auto max-w-[720px]">
              <HistoryList />
            </div>
          ) : (
            <div className="mx-auto flex max-w-[640px] flex-col gap-6 px-8 py-14">
              <div>
                <p className="m-0 text-display text-fg-strong" data-voice-summary-title>
                  {summaryTitle(tasks)}
                </p>
                <p className="m-0 mt-1 text-sm text-muted">{`Talked for ${length}`}</p>
              </div>
              {tasks.length > 0 ? (
                <ol className="m-0 flex list-none flex-col p-0">
                  {tasks.map((t) => (
                    <SummaryRow key={t.runId} task={t} onOpen={onOpenTask && workspacePath ? () => onOpenTask(workspacePath, t.runId) : undefined} />
                  ))}
                </ol>
              ) : null}
              <div className="flex items-center gap-2">
                <Button size="md" variant="primary" icon="waveform" onClick={onTalkAgain} data-voice-talk-again>
                  Talk again
                </Button>
                <Button size="md" variant="secondary" icon="chat" onClick={() => setShowing(true)} data-voice-summary-conversation>
                  Conversation
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Field>
  )
}

function SummaryRow({ task, onOpen }: { task: SummaryTask; onOpen?: () => void }) {
  const glyph = task.state === 'stopped' ? 'stopped' : task.state
  const body = (
    <>
      <StatusGlyph state={glyph} size={14} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-fg-strong">{task.brief}</span>
          <span className="shrink-0 font-mono text-caption text-tertiary tnum">{task.time}</span>
        </span>
        <span className="mt-0.5 block text-sm text-secondary">{task.outcome}</span>
      </span>
    </>
  )
  return (
    <li className={cn('border-t', BORDER_DIVIDER)} data-voice-summary-task={task.state}>
      {onOpen ? (
        <button type="button" className={cn('group flex w-full min-w-0 items-start gap-3 rounded-md px-2 py-3 text-left focus-visible:vy-focus-ring', ROW_HOVER)} onClick={onOpen}>
          <span className="sr-only">Open task: </span>
          {body}
          <Icon name="arrowRight" size={14} className="mt-0.5 shrink-0 text-tertiary group-hover:text-fg" />
        </button>
      ) : (
        <div className="flex w-full min-w-0 items-start gap-3 px-2 py-3">{body}</div>
      )}
    </li>
  )
}

/** "9 min 47 s". */
function formatDurationShort(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

