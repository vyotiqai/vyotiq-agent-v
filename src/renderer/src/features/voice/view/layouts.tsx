import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { VoiceOrbLook, VoiceSettings } from '@shared/ipc/schemas/voice'
import { Icon } from '@renderer/lib/icons'
import { Button, StatusGlyph, cn } from '@renderer/lib/ui'
import { BORDER_DIVIDER } from '@renderer/lib/utils/layout'
import { AnimatedOrb } from '../orb/AnimatedOrb'
import type { VoiceSnapshot } from '../voiceSessionController'
import {
  Ask,
  Controls,
  ConversationItems,
  HEADLINE,
  Header,
  Line,
  Notes,
  Result,
  Steps,
  WHO,
  buildEntries,
  currentWork,
  elapsed,
  subline,
  workGlyph,
  HAND_OFF_FAILED,
  type Entry
} from './parts'

/*
  The voice view's three layouts (docs/voice-mode.md §25), picked in
  Settings › Voice mode › Layout. Each shows the same session: the orb in the
  chosen look, what's happening in a word, the conversation, and each
  hand-off's live work.

  - Conversation: the conversation is the page; the orb docks in the bar under
    it, so nothing scrolls under the orb. An empty session starts on a big orb.
  - Orb: the orb fills the pane with the one thing worth reading under it; the
    conversation opens beside it.
  - Split: the conversation under the orb on the left, the task's every step,
    question and full result on the right.
*/

export type LayoutProps = {
  v: VoiceSnapshot
  settings: VoiceSettings
  startedAt: number | null
  escArmed: boolean
  firstTip: boolean
  owner: string | null
  workspacePath: string | null
  level: () => number
  onOpenVoiceSettings?: () => void
}

/** A second's clock, for the session's time and each run's elapsed. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

/** Newest words in view, while you haven't scrolled up to read. */
function useFollowBottom(deps: readonly unknown[]) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  const onScroll = (): void => {
    const el = ref.current
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }
  return { ref, onScroll }
}

function useSession(p: LayoutProps) {
  const now = useNow()
  const words = p.settings.captions
  const entries = useMemo(() => (words ? buildEntries(p.v.transcript, p.v.works) : []), [words, p.v.transcript, p.v.works])
  // With captions off the words go, but the work stays: it's the task's, not speech.
  const latest = useMemo(() => {
    if (words) return currentWork(entries)
    const handOffs = buildEntries(p.v.transcript, p.v.works)
    return currentWork(handOffs)
  }, [words, entries, p.v.transcript, p.v.works])
  const work = latest?.work
  const partial = words && p.v.state === 'hearing' ? p.v.partial : ''
  return { now, words, entries, latest, work, partial, sub: subline(p.v, p.settings, work, latest?.brief) }
}

function Headline({ p, sub, size }: { p: LayoutProps; sub: string; size: 'title' | 'heading' }) {
  return (
    <>
      <p className={cn('m-0 text-fg-strong', size === 'title' ? 'text-title' : 'text-heading')} data-voice-headline>
        {HEADLINE[p.v.state]}
      </p>
      <p className="m-0 max-w-[480px] truncate text-sm text-muted" data-voice-subline>
        {sub}
      </p>
    </>
  )
}

function CaptionsOff() {
  return <p className="m-0 text-caption text-tertiary">Captions are off. It still speaks.</p>
}

function Shell({ p, layout, children }: { p: LayoutProps; layout: VoiceSettings['viewLayout']; children: ReactNode }) {
  return (
    <section
      className="absolute inset-0 z-sticky flex min-h-0 flex-col bg-bg"
      aria-label="Voice mode"
      data-voice-view={p.v.state}
      data-voice-layout={layout}
    >
      {children}
    </section>
  )
}

function Orb({ p, size, look }: { p: LayoutProps; size: number; look: VoiceOrbLook }) {
  return <AnimatedOrb look={look} state={p.v.state} size={size} level={p.level} />
}

// ── Conversation ───────────────────────────────────────────────────────────

export function ConversationLayout(p: LayoutProps) {
  const s = useSession(p)
  const follow = useFollowBottom([s.entries, s.partial])
  const empty = s.entries.length === 0 && !s.partial

  return (
    <Shell p={p} layout="conversation">
      <Header v={p.v} now={s.now} startedAt={p.startedAt} />
      {empty ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 pb-10">
          <Orb p={p} size={200} look={p.settings.orbLook} />
          <div className="flex flex-col items-center gap-1 px-4 text-center">
            <Headline p={p} sub={s.sub} size="title" />
          </div>
          {s.words ? null : <CaptionsOff />}
          {/* Captions off hides speech, not the task's work. */}
          {!s.words && s.work ? (
            <div className="w-full max-w-[520px] px-6">
              <Steps work={s.work} keep={4} />
              <Ask work={s.work} />
              <Result work={s.work} now={s.now} />
            </div>
          ) : null}
        </div>
      ) : (
        <div ref={follow.ref} onScroll={follow.onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <ol className="m-0 mx-auto flex w-full max-w-[720px] list-none flex-col px-6 pb-4 pt-6" aria-label="Conversation" data-voice-transcript>
            <ConversationItems entries={s.entries} partial={s.partial} now={s.now} />
          </ol>
        </div>
      )}
      <div className={cn('flex shrink-0 items-center gap-3 border-t px-4', BORDER_DIVIDER, empty ? 'h-12' : 'h-16')} data-voice-row="controls">
        {empty ? (
          <div className="min-w-0 flex-1">
            <Notes v={p.v} escArmed={p.escArmed} firstTip={p.firstTip} owner={p.owner} workspacePath={p.workspacePath} onOpenVoiceSettings={p.onOpenVoiceSettings} />
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Orb p={p} size={48} look={p.settings.orbLook} />
            <div className="min-w-0 flex-1">
              <p className="m-0 text-sm font-medium text-fg-strong" data-voice-headline>
                {HEADLINE[p.v.state]}
              </p>
              <div className="flex min-w-0">
                {p.v.state === 'error' || p.v.turnError || p.v.speakError || p.escArmed ? (
                  <Notes v={p.v} escArmed={p.escArmed} firstTip={false} owner={p.owner} workspacePath={p.workspacePath} onOpenVoiceSettings={p.onOpenVoiceSettings} />
                ) : (
                  <p className="m-0 truncate text-xs text-muted" data-voice-subline>
                    {s.sub}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
        <Controls v={p.v} work={s.work} />
      </div>
    </Shell>
  )
}

// ── Orb ────────────────────────────────────────────────────────────────────

/** The one thing worth reading now, under the orb. */
function Now({ p, s }: { p: LayoutProps; s: ReturnType<typeof useSession> }) {
  const work = s.work
  if (s.words && p.v.state === 'hearing' && p.v.partial) {
    return <p className="m-0 text-center text-md leading-relaxed text-fg-strong">{p.v.partial}</p>
  }
  if (s.words && p.v.state === 'speaking' && p.v.saying) {
    return <p className="m-0 text-center text-md leading-relaxed text-fg">{p.v.saying}</p>
  }
  if (s.words && p.v.state === 'thinking' && p.v.lastTurn) {
    return <p className="m-0 text-center text-md leading-relaxed text-muted">“{p.v.lastTurn}”</p>
  }
  if (work && (work.state === 'running' || work.state === 'needs')) {
    return (
      <div className="w-full">
        {s.latest ? <p className="m-0 mb-2 truncate text-sm text-muted">{s.latest.brief}</p> : null}
        <Steps work={work} keep={4} />
        <Ask work={work} />
      </div>
    )
  }
  if (work && (p.v.state === 'listening' || p.v.state === 'paused')) {
    return (
      <div className="w-full">
        <Result work={work} now={s.now} />
      </div>
    )
  }
  return null
}

export function OrbLayout(p: LayoutProps) {
  const s = useSession(p)
  const [open, setOpen] = useState(false)
  const follow = useFollowBottom([s.entries, s.partial, open])
  const turns = s.entries.length

  return (
    <Shell p={p} layout="orb">
      <Header v={p.v} now={s.now} startedAt={p.startedAt}>
        {s.words ? (
          <Button size="xs" variant="ghost" icon="chat" aria-pressed={open} onClick={() => setOpen(!open)} data-voice-conversation-toggle>
            {open ? 'Hide conversation' : `Conversation${turns ? ` · ${turns}` : ''}`}
          </Button>
        ) : null}
      </Header>
      <div className="flex min-h-0 flex-1">
        <div className="scroll-thin flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-8 py-6">
          <Orb p={p} size={240} look={p.settings.orbLook} />
          <div className="flex flex-col items-center gap-1 text-center">
            <Headline p={p} sub={s.sub} size="title" />
          </div>
          <div className="flex min-h-[120px] w-full max-w-[520px] flex-col items-center">
            {s.words ? <Now p={p} s={s} /> : <CaptionsOff />}
          </div>
        </div>
        {open && s.words ? (
          <aside className="vy-panel flex w-[380px] shrink-0 flex-col" aria-label="Conversation">
            <div className="flex h-10 shrink-0 items-center border-b border-border pl-4 pr-2 text-sm text-fg-strong">Conversation</div>
            <div ref={follow.ref} onScroll={follow.onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
              <ol className="m-0 list-none px-4 py-3" data-voice-transcript>
                <ConversationItems entries={s.entries} partial={s.partial} now={s.now} steps={2} />
              </ol>
            </div>
          </aside>
        ) : null}
      </div>
      <div className={cn('flex h-12 shrink-0 items-center gap-3 border-t px-4', BORDER_DIVIDER)} data-voice-row="controls">
        <div className="min-w-0 flex-1">
          <Notes v={p.v} escArmed={p.escArmed} firstTip={p.firstTip} owner={p.owner} workspacePath={p.workspacePath} onOpenVoiceSettings={p.onOpenVoiceSettings} />
        </div>
        <Controls v={p.v} work={s.work} />
      </div>
    </Shell>
  )
}

// ── Split ──────────────────────────────────────────────────────────────────

function workTitle(entry: Extract<Entry, { who: 'work' }> | undefined, now: number): string {
  const work = entry?.work
  if (!entry) return 'Its task'
  if (entry.failed) return 'Not sent'
  if (!work) return 'Handing it over'
  if (work.state === 'done') return `Done · ${elapsed(work, now)}`
  if (work.state === 'needs') return 'Waiting for you'
  if (work.state === 'failed') return 'Stopped by an error'
  if (work.state === 'stopped') return 'Stopped'
  return `Working · ${elapsed(work, now)}`
}

function WorkPane({ entries, latest, now }: { entries: readonly Entry[]; latest: Extract<Entry, { who: 'work' }> | undefined; now: number }) {
  if (!latest) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <Icon name="tasks" size={20} className="text-tertiary" />
        <p className="m-0 text-sm text-muted">Nothing handed over yet.</p>
        <p className="m-0 max-w-[300px] text-xs text-tertiary">Ask it to do something, and its steps show here as it works.</p>
      </div>
    )
  }
  const earlier = entries.filter((e): e is Extract<Entry, { who: 'work' }> => e.who === 'work' && e !== latest && !e.continued)
  const work = latest.work
  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4" data-voice-work={latest.failed ? 'not_sent' : (work?.state ?? 'handed')}>
      {earlier.length ? (
        <ol className={cn('m-0 mb-4 list-none border-b p-0 pb-3', BORDER_DIVIDER)} aria-label="Earlier">
          {earlier.map((e) => (
            <li key={e.id} className="flex h-7 min-w-0 items-center gap-2 text-xs">
              <StatusGlyph state={workGlyph(e)} size={13} />
              <span className="min-w-0 flex-1 truncate text-muted">{e.brief}</span>
              {e.work ? <span className="shrink-0 font-mono text-caption text-tertiary tnum">{elapsed(e.work, now)}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      <p className="m-0 text-sm leading-relaxed text-secondary">{latest.brief}</p>
      {latest.failed ? (
        <p className="m-0 mt-2 flex items-center gap-1.5 text-caption text-danger" data-voice-handoff-failed={latest.failed}>
          <Icon name="warningCircle" size={12} />
          {HAND_OFF_FAILED[latest.failed]}
        </p>
      ) : null}
      {work ? (
        <>
          <div className="mt-3">
            <Steps work={work} keep={work.state === 'running' || work.state === 'needs' ? 12 : 0} />
          </div>
          <Ask work={work} />
          <Result work={work} now={now} fold={false} />
        </>
      ) : null}
    </div>
  )
}

export function SplitLayout(p: LayoutProps) {
  const s = useSession(p)
  const follow = useFollowBottom([s.entries, s.partial])
  // The work pane lists every hand-off, captions or not: it's the task's record, not speech.
  const all = useMemo(() => buildEntries(p.v.transcript, p.v.works), [p.v.transcript, p.v.works])
  const latest = currentWork(all)

  return (
    <Shell p={p} layout="split">
      <Header v={p.v} now={s.now} startedAt={p.startedAt} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className={cn('flex shrink-0 items-center gap-4 border-b px-6 py-5', BORDER_DIVIDER)}>
            <Orb p={p} size={88} look={p.settings.orbLook} />
            <div className="min-w-0">
              <Headline p={p} sub={s.sub} size="heading" />
            </div>
          </div>
          {s.words ? (
            <div ref={follow.ref} onScroll={follow.onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
              <ol className="m-0 flex list-none flex-col px-6 py-4" aria-label="Conversation" data-voice-transcript>
                {s.entries.map((e, i) =>
                  e.who === 'work' ? (
                    <li key={e.id} className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-1.5" data-voice-line="agent">
                      <span className="flex items-center gap-1.5 pt-px text-caption text-tertiary">
                        <StatusGlyph state={workGlyph(e)} size={12} />
                        {WHO.work}
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted">
                        <span className="truncate">{e.brief}</span>
                        <Icon name="arrowRight" size={12} className="shrink-0 text-tertiary" />
                      </span>
                    </li>
                  ) : (
                    <Line
                      key={e.id}
                      who={e.who}
                      label={i === 0 || s.entries[i - 1]!.who !== e.who}
                      unanswered={e.who === 'you' && Boolean(e.unanswered)}
                    >
                      {e.text}
                    </Line>
                  )
                )}
                {s.partial ? (
                  <li className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-1.5" data-voice-line="partial">
                    <span className="pt-px text-caption text-tertiary">{s.entries.at(-1)?.who === 'you' ? '' : WHO.you}</span>
                    <span className="text-sm text-muted">{s.partial}</span>
                  </li>
                ) : null}
                {s.entries.length === 0 && !s.partial ? (
                  <li className="py-1.5 text-sm text-tertiary">What you say, and what it says back, shows here.</li>
                ) : null}
              </ol>
            </div>
          ) : (
            <div className="px-6 py-4">
              <CaptionsOff />
            </div>
          )}
        </div>
        <aside className="vy-panel flex w-[44%] min-w-[300px] max-w-[560px] shrink-0 flex-col" aria-label="Its task">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
            <StatusGlyph state={latest ? workGlyph(latest) : 'queued'} size={13} />
            <span className={cn('text-sm', latest ? 'text-fg-strong' : 'text-muted')}>{workTitle(latest, s.now)}</span>
            {latest?.work ? (
              <span className="ml-auto text-caption text-tertiary">{`${latest.work.stepCount} step${latest.work.stepCount === 1 ? '' : 's'}`}</span>
            ) : null}
          </div>
          <WorkPane entries={all} latest={latest} now={s.now} />
        </aside>
      </div>
      <div className={cn('flex h-12 shrink-0 items-center gap-3 border-t px-4', BORDER_DIVIDER)} data-voice-row="controls">
        <div className="min-w-0 flex-1">
          <Notes v={p.v} escArmed={p.escArmed} firstTip={p.firstTip} owner={p.owner} workspacePath={p.workspacePath} onOpenVoiceSettings={p.onOpenVoiceSettings} />
        </div>
        <Controls v={p.v} work={latest?.work} />
      </div>
    </Shell>
  )
}
