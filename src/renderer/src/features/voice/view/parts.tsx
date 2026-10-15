import { useLayoutEffect, useRef, useState } from 'react'
import { sttEntry, ttsEntry } from '@shared/voice'
import type { VoiceHandOffFailure, VoiceWork, VoiceWorkStep } from '@shared/ipc/schemas/voice'
import { Icon } from '@renderer/lib/icons'
import { StatusGlyph, Tooltip, cn, type TaskState } from '@renderer/lib/ui'
import { CONTROL_HOVER } from '@renderer/lib/utils/layout'
import { toolLabel } from '@renderer/features/chat/toolUi'
import { RecordProse } from '@renderer/features/task/record/RecordProse'
import type { VoiceLine, VoiceSnapshot } from '../voiceSessionController'

/*
  The voice view's reading of the conversation and its work, shared by the
  placements (docs/voice-mode.md §25, §26; the pieces themselves are in
  stage/):
  - one name each: You, Agent V (the voice you talk to), and its Task (the work);
  - a turn split by a pause reads as one turn;
  - a hand-off owns its run's live steps, what the run waits on, and its result.
*/

export const WHO = { you: 'You', voice: 'Agent V', work: 'Task' } as const

export type Entry =
  | { id: string; who: 'you' | 'voice'; text: string; unanswered?: true }
  | {
      id: string
      who: 'work'
      brief: string
      work: VoiceWork | undefined
      /** A later hand-off joined the same run: its steps and result show there. */
      continued: boolean
      /** The task never took it, and why. */
      failed?: VoiceHandOffFailure
    }

/**
 * The transcript as the view reads it: hand-offs carry their run's work, and
 * a turn of yours split by a pause reads as one. The voice's replies stay
 * apart: each is its own moment (an approval asked, a result a minute later),
 * and one paragraph would run them together.
 */
export function buildEntries(transcript: readonly VoiceLine[], works: VoiceSnapshot['works']): Entry[] {
  const lastForRun = new Map<string, string>()
  for (const l of transcript) if (l.who === 'agent' && l.runId) lastForRun.set(l.runId, l.id)
  const out: Entry[] = []
  for (const l of transcript) {
    if (l.who === 'agent') {
      out.push({
        id: l.id,
        who: 'work',
        brief: l.text,
        work: l.runId ? works[l.runId] : undefined,
        continued: Boolean(l.runId && lastForRun.get(l.runId) !== l.id),
        ...(l.failed ? { failed: l.failed } : {})
      })
      continue
    }
    const last = out.at(-1)
    // One turn split by a pause reads as one; words left unanswered stay apart from answered ones.
    if (l.who === 'you' && last?.who === 'you' && Boolean(last.unanswered) === Boolean(l.unanswered)) {
      out[out.length - 1] = { ...last, text: `${last.text} ${l.text}` }
    } else out.push({ id: l.id, who: l.who, text: l.text, ...(l.unanswered ? { unanswered: true as const } : {}) })
  }
  return out
}

/** The work the session is on now: the newest hand-off's run. */
export function currentWork(entries: readonly Entry[]): Extract<Entry, { who: 'work' }> | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.who === 'work') return e
  }
  return undefined
}

export function stepVerb(step: VoiceWorkStep): string {
  return toolLabel(step.tool, step.state === 'running' ? 'running' : 'done')
}

/** "40 s", "1 min 12 s", "2 h 5 min". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

export function elapsed(work: VoiceWork, now: number): string {
  return formatDuration((work.endedAt ?? now) - work.startedAt)
}

const GLYPH: Record<VoiceWork['state'], TaskState> = { running: 'running', needs: 'needs', done: 'done', failed: 'failed', stopped: 'stopped' }

export function workGlyph(entry: Extract<Entry, { who: 'work' }>): TaskState {
  if (entry.failed) return 'failed'
  return entry.work ? GLYPH[entry.work.state] : 'running'
}

/** Why a hand-off never reached the task, under its line. */
export const HAND_OFF_FAILED: Readonly<Record<VoiceHandOffFailure, string>> = {
  no_task: 'Not sent: no task was open to take it',
  refused: 'Not sent: the task wasn’t ready to take it',
  error: 'Not sent: it couldn’t be sent'
}

/**
 * Who hears you and who speaks, in one token: a cloud (or a lock when audio
 * stays on this PC) and the provider's name, once when one does both. The
 * whole sentence, with where your audio goes, is the tooltip and the
 * accessible name; a key that fell back says so with a warning glyph. With
 * Voice settings in reach it is the way there (where providers are changed),
 * so the tooltip reaches the keyboard on a real control, not a focusable span.
 */
export function EngineToken({ v, onOpenVoiceSettings }: { v: VoiceSnapshot; onOpenVoiceSettings?: () => void }) {
  const listener = v.listener ? sttEntry(v.listener) : null
  if (!listener) return null
  const speaker = v.speaker ? ttsEntry(v.speaker) : null
  const fellBack = Boolean(v.listenerFellBackFrom || v.speakerFellBackFrom)
  const label = !speaker || speaker.label === listener.label ? listener.label : `${listener.label} · ${speaker.label}`
  const full = [
    `Hears with ${listener.label}`,
    speaker ? `speaks with ${speaker.label}` : 'nothing can speak, so replies stay on screen'
  ].join(' · ')
  const fallback = [
    v.listenerFellBackFrom ? `No ${sttEntry(v.listenerFellBackFrom).label} key, so it listens with ${listener.label}.` : null,
    v.speakerFellBackFrom && speaker ? `No ${ttsEntry(v.speakerFellBackFrom).label} key, so it speaks with ${speaker.label}.` : null
  ]
    .filter(Boolean)
    .join(' ')
  const tip = `${full}. ${listener.privacy}.${fallback ? ` ${fallback}` : ''}`
  const body = (
    <>
      <Icon name={fellBack ? 'warningCircle' : listener.key.kind === 'none' ? 'lock' : 'cloud'} size={12} className={cn('shrink-0', fellBack ? 'text-warning' : null)} />
      <span className="truncate">{label}</span>
    </>
  )
  const attrs = { 'aria-label': tip, 'data-voice-engines': label, 'data-voice-fell-back': fellBack || undefined }
  return (
    <Tooltip content={tip} side="bottom" describeChild={false}>
      {onOpenVoiceSettings ? (
        <button
          type="button"
          onClick={onOpenVoiceSettings}
          className={cn('flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-caption text-tertiary hover:text-fg focus-visible:vy-focus-ring', CONTROL_HOVER)}
          {...attrs}
        >
          {body}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-1 px-1 text-caption text-tertiary" role="img" {...attrs}>
          {body}
        </span>
      )}
    </Tooltip>
  )
}

function StepRow({ step }: { step: VoiceWorkStep }) {
  const running = step.state === 'running'
  return (
    <li className="flex h-6 min-w-0 items-center gap-2" data-voice-step={step.state}>
      <StatusGlyph state={running ? 'running' : step.state === 'failed' ? 'failed' : 'done'} size={13} />
      <span className={cn('shrink-0 text-xs', running ? 'text-fg' : 'text-muted')}>{stepVerb(step)}</span>
      <span className={cn('min-w-0 truncate font-mono text-caption', running ? 'text-secondary' : 'text-tertiary')}>{step.summary}</span>
    </li>
  )
}

/** The steps, newest last; older ones fold behind a count so the live one stays in view. */
export function Steps({ work, keep = 3 }: { work: VoiceWork; keep?: number }) {
  const [open, setOpen] = useState(false)
  // Steps the event no longer lists are counted with the folded ones.
  const unlisted = work.stepCount - work.steps.length
  const hidden = Math.max(0, work.steps.length - keep)
  const shown = open ? work.steps : work.steps.slice(hidden)
  const folded = (open ? 0 : hidden) + unlisted
  if (work.steps.length === 0) return null
  return (
    <ol className="m-0 list-none p-0" aria-label="Steps">
      {hidden > 0 || unlisted > 0 ? (
        <li>
          {hidden > 0 ? (
            <button
              type="button"
              className="flex h-6 items-center gap-2 rounded-sm text-xs text-tertiary hover:text-fg focus-visible:vy-focus-ring"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              <Icon name={open ? 'chevronUp' : 'chevronRight'} size={12} />
              {open ? (unlisted > 0 ? `${unlisted} earlier, on the task` : 'Fewer steps') : `${folded} earlier step${folded === 1 ? '' : 's'}`}
            </button>
          ) : (
            <span className="flex h-6 items-center text-xs text-tertiary">{`${unlisted} earlier, on the task`}</span>
          )}
        </li>
      ) : null}
      {shown.map((s) => (
        <StepRow key={s.id} step={s} />
      ))}
    </ol>
  )
}

/**
 * A result taller than this opens folded to it; the voice already said the
 * short form. Measured, not counted in characters: a code block or a list is
 * tall for its length, and folding away a line or two saves nothing.
 */
const FOLD_REM = 9
const FOLD_OVER = 1.5

/** How the run ended, and its answer in its own words. */
export function Result({ work, now, fold = true, head: withHead = true }: { work: VoiceWork; now: number; fold?: boolean; head?: boolean }) {
  const [open, setOpen] = useState(false)
  const [tall, setTall] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = body.current
    if (!el || !fold) return
    // In rem, as the clamp is, so the app's text size moves both.
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const check = (): void => setTall(el.offsetHeight > FOLD_REM * rem * FOLD_OVER)
    check()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fold, work.result, work.state])
  if (work.state === 'running' || work.state === 'needs') return null
  const steps = `${work.stepCount} step${work.stepCount === 1 ? '' : 's'}`
  const head =
    work.state === 'done'
      ? { tone: 'text-success', icon: 'checkCircle' as const, text: `Done in ${elapsed(work, now)} · ${steps}` }
      : work.state === 'failed'
        ? { tone: 'text-danger', icon: 'warningCircle' as const, text: `Stopped by an error after ${elapsed(work, now)} · ${steps}` }
        : { tone: 'text-tertiary', icon: 'stop' as const, text: `Stopped after ${elapsed(work, now)} · ${steps}` }
  const long = fold && tall
  return (
    <div className="mt-2" data-voice-result={work.state}>
      {withHead ? (
        <div className={cn('flex items-center gap-1.5 text-caption', head.tone)}>
          <Icon name={head.icon} size={12} />
          {head.text}
        </div>
      ) : null}
      {work.result ? (
        <div className={cn(withHead ? 'mt-1' : null, long && !open ? 'max-h-[9rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]' : null)}>
          {/* Measured unclamped: the fold's own height never changes with the text. */}
          <div ref={body}>
            <RecordProse text={work.result} size="sm" />
          </div>
        </div>
      ) : null}
      {long ? (
        <button
          type="button"
          className="mt-1 flex h-6 items-center gap-1 rounded-sm text-xs text-tertiary hover:text-fg focus-visible:vy-focus-ring"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? 'chevronUp' : 'chevron'} size={12} />
          {open ? 'Show less' : 'Show all'}
        </button>
      ) : null}
    </div>
  )
}
