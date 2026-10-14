import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { sttEntry, ttsEntry } from '@shared/voice'
import type { VoiceHandOffFailure, VoiceSettings, VoiceWork, VoiceWorkStep } from '@shared/ipc/schemas/voice'
import { VOICE_STATE_LABEL, type VoiceSessionState } from '@shared/voiceSession'
import { Icon } from '@renderer/lib/icons'
import { Button, StatusGlyph, cn, type TaskState } from '@renderer/lib/ui'
import { CONTROL_HOVER } from '@renderer/lib/utils/layout'
import { toolLabel } from '@renderer/features/chat/toolUi'
import { RecordProse } from '@renderer/features/task/record/RecordProse'
import { FIRST_TIP, ProblemText, formatTime, sessionNotes, type ShownProblem } from '../VoiceBar'
import { endVoiceMode, setVoiceViewOpen, startVoiceMode, stopVoiceTarget, voiceController } from '../voiceMode'
import type { VoiceLine, VoiceSnapshot } from '../voiceSessionController'

/*
  What the three voice view layouts share (docs/voice-mode.md §25):
  - one name each: You, Agent V (the voice you talk to), and its Task (the work);
  - a turn split by a pause reads as one turn;
  - a hand-off is one folded line that owns its run's live steps, what the run
    waits on, and its result, instead of a "To the agent" paragraph.
*/

/** What's happening, in a word or two. Working says what, not who. */
export const HEADLINE: Readonly<Record<VoiceSessionState, string>> = {
  ...VOICE_STATE_LABEL,
  hearing: 'Listening',
  working: 'Working on it',
  waiting_on_you: 'Needs you'
}

export const WHO = { you: 'You', voice: 'Agent V', work: 'Task' } as const

export type Entry =
  | { id: string; who: 'you' | 'voice'; text: string }
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
    if (l.who === 'you' && last?.who === 'you') out[out.length - 1] = { ...last, text: `${last.text} ${l.text}` }
    else out.push({ id: l.id, who: l.who, text: l.text })
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

export function subline(v: VoiceSnapshot, settings: VoiceSettings, work: VoiceWork | undefined, brief: string | undefined): string {
  switch (v.state) {
    case 'connecting':
      return 'Opening the microphone'
    case 'listening':
      return settings.pushToTalkOnly ? 'Hold Space to talk' : 'Talk any time'
    case 'hearing':
      return 'Pause when you’re done'
    case 'thinking':
      return 'Working out an answer'
    case 'speaking':
      return 'Talk any time to interrupt'
    case 'working': {
      const step = work?.state === 'running' ? work.steps.at(-1) : undefined
      if (step?.state === 'running') return step.summary ? `${stepVerb(step)} ${step.summary}` : stepVerb(step)
      return brief ?? 'It keeps going while you talk'
    }
    case 'waiting_on_you': {
      const ask = work?.ask
      if (ask?.kind === 'approval') {
        if (ask.risky) return `It wants to ${ask.what}. Approve or deny it on screen`
        return `Allow it to ${ask.what}? Say yes${ask.always ? ', no, or always allow' : ' or no'}`
      }
      if (ask?.kind === 'question') return ask.prompt
      return 'It needs an answer: say it, or use the card on screen'
    }
    case 'paused':
      return work?.state === 'running' || work?.state === 'needs' ? 'It keeps working. Press M to talk again' : 'Press M or Unmute to talk again'
    case 'reconnecting':
      return `Reconnecting${v.reconnectAttempt > 1 ? ` (try ${v.reconnectAttempt})` : ''}…`
    default:
      return ''
  }
}

/** The pane's 40px row: Voice, its clock, who listens and speaks, and the way back to the task. */
export function Header({ v, now, startedAt, children }: { v: VoiceSnapshot; now: number; startedAt: number | null; children?: ReactNode }) {
  const listener = v.listener ? sttEntry(v.listener) : null
  const speaker = v.speaker ? ttsEntry(v.speaker) : null
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2" data-voice-header>
      <Icon name="waveform" size={14} className="text-muted" />
      <h2 className="m-0 text-sm text-fg-strong">Voice</h2>
      <span className="font-mono text-caption text-tertiary tnum" aria-label="Voice mode time">
        {formatTime(now - (startedAt ?? now))}
      </span>
      <span className="min-w-0 flex-1 truncate text-right text-caption text-tertiary" data-voice-engines>
        {listener ? `Hears with ${listener.label}` : ''}
        {speaker ? ` · speaks with ${speaker.label}` : ''}
      </span>
      {children}
      <Button size="xs" variant="ghost" icon="minimize" onClick={() => setVoiceViewOpen(false)} data-voice-close-view>
        Show the task
      </Button>
    </div>
  )
}

/** Mute, the one stop that applies now, and End. */
export function Controls({ v, work }: { v: VoiceSnapshot; work: VoiceWork | undefined }) {
  const controller = voiceController()
  const taskLive = v.state === 'working' || v.state === 'waiting_on_you' || work?.state === 'running' || work?.state === 'needs'
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        size="sm"
        variant="ghost"
        icon={v.muted ? 'micSlash' : 'mic'}
        aria-pressed={v.muted}
        disabled={v.state === 'error' || v.state === 'connecting'}
        onClick={() => controller.setMuted(!v.muted)}
      >
        {v.muted ? 'Unmute' : 'Mute'}
      </Button>
      {v.state === 'speaking' ? (
        <Button size="sm" variant="ghost" icon="stop" onClick={() => controller.interrupt()}>
          Stop speaking
        </Button>
      ) : taskLive ? (
        <Button size="sm" variant="ghost" icon="stop" onClick={() => void stopVoiceTarget()}>
          Stop the task
        </Button>
      ) : null}
      <Button size="sm" variant="secondary" icon="close" onClick={() => void endVoiceMode()} data-voice-end>
        End
      </Button>
    </div>
  )
}

function FixButtons({ problem, owner, workspacePath, onOpenVoiceSettings, primary }: { problem: ShownProblem; owner: string | null; workspacePath: string | null; onOpenVoiceSettings?: () => void; primary: boolean }) {
  const variant = primary ? 'secondary' : 'ghost'
  return (
    <>
      {problem.fix === 'settings' && onOpenVoiceSettings ? (
        <Button size="xs" variant={variant} onClick={onOpenVoiceSettings}>
          Voice settings
        </Button>
      ) : null}
      {problem.fix === 'mic' ? (
        <Button size="xs" variant={variant} onClick={() => void window.vyotiq.dictationOpenMicSettings?.()}>
          Open mic settings
        </Button>
      ) : null}
      {problem.fix === 'retry' && owner ? (
        <Button size="xs" variant={variant} onClick={() => void startVoiceMode(owner, { workspacePath })}>
          Try again
        </Button>
      ) : null}
    </>
  )
}

/** What's wrong (and how to fix it), or else the keys hint. */
export function Notes({
  v,
  escArmed,
  firstTip,
  owner,
  workspacePath,
  onOpenVoiceSettings
}: {
  v: VoiceSnapshot
  escArmed: boolean
  firstTip: boolean
  owner: string | null
  workspacePath: string | null
  onOpenVoiceSettings?: () => void
}) {
  const { problem, trouble } = sessionNotes(v)
  const hint = escArmed ? 'Press Esc again to end voice mode' : firstTip ? FIRST_TIP : 'M mutes · Esc twice ends'
  if (problem) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-danger" role="alert">
        <Icon name="warningCircle" size={13} className="shrink-0" />
        <ProblemText problem={problem} />
        <FixButtons problem={problem} owner={owner} workspacePath={workspacePath} onOpenVoiceSettings={onOpenVoiceSettings} primary />
      </span>
    )
  }
  if (trouble) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-warning" role="status">
        <Icon name="warningCircle" size={13} className="shrink-0" />
        <ProblemText problem={trouble} />
        <FixButtons problem={trouble} owner={owner} workspacePath={workspacePath} onOpenVoiceSettings={onOpenVoiceSettings} primary={false} />
      </span>
    )
  }
  return (
    <span className="min-w-0 truncate text-caption text-tertiary" aria-live={escArmed ? 'polite' : undefined}>
      {hint}
    </span>
  )
}

/** One line of the conversation: a fixed label column, then the words, on two hard edges. */
export function Line({ who, children, label = true }: { who: 'you' | 'voice'; children: ReactNode; label?: boolean }) {
  return (
    <li className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-1.5" data-voice-line={who}>
      <span className="pt-px text-caption text-tertiary">{label ? WHO[who] : ''}</span>
      <span className={cn('text-sm leading-relaxed', who === 'you' ? 'text-fg-strong' : 'text-fg')}>{children}</span>
    </li>
  )
}

/** Your words as you say them. */
export function PartialLine({ text, label }: { text: string; label: boolean }) {
  return (
    <li className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-1.5" data-voice-line="partial">
      <span className="pt-px text-caption text-tertiary">{label ? WHO.you : ''}</span>
      <span className="text-sm leading-relaxed text-muted">{text}</span>
    </li>
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

/** What the run is stopped on, answerable here (or by voice, or on the task's card). */
export function Ask({ work }: { work: VoiceWork }) {
  // One set of buttons per request: a second approval in the same run starts with them live.
  return <AskFor key={work.ask?.requestId ?? 'none'} work={work} />
}

function AskFor({ work }: { work: VoiceWork }) {
  const [sent, setSent] = useState<string | null>(null)
  const ask = work.ask
  if (!ask || work.state !== 'needs') return null
  // The buttons stay off once an answer is on its way; one main refused (or that failed) can be given again.
  const answer = (key: string, fn: () => Promise<{ ok: boolean } | undefined> | undefined): void => {
    setSent(key)
    void Promise.resolve(fn()).then(
      (res) => {
        if (res && !res.ok) setSent(null)
      },
      () => setSent(null)
    )
  }
  const onTask = (
    <Button size="xs" variant="secondary" icon="minimize" onClick={() => setVoiceViewOpen(false)}>
      Answer on the task
    </Button>
  )
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-l-2 border-accent pl-3" data-voice-ask={ask.kind}>
      {ask.kind === 'approval' ? (
        <>
          <span className="min-w-0 flex-1 text-sm text-fg-strong">{`Allow it to ${ask.what}?`}</span>
          {ask.risky ? (
            onTask
          ) : (
            <>
              <Button
                size="xs"
                variant="primary"
                disabled={sent !== null}
                onClick={() => answer('once', () => window.vyotiq.respondToolApproval?.(ask.requestId, 'once', work.runId))}
              >
                Allow once
              </Button>
              {ask.always ? (
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={sent !== null}
                  onClick={() => answer('always', () => window.vyotiq.respondToolApproval?.(ask.requestId, 'always', work.runId))}
                >
                  Always allow
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="secondary"
                disabled={sent !== null}
                onClick={() => answer('deny', () => window.vyotiq.respondToolApproval?.(ask.requestId, 'deny', work.runId))}
              >
                Deny
              </Button>
            </>
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
                  onClick={() =>
                    answer(option, () => window.vyotiq.respondAgentQuestion?.(ask.requestId, [{ questionId: ask.questionId, values: [option] }], work.runId))
                  }
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

/**
 * A result taller than this opens folded to it; the voice already said the
 * short form. Measured, not counted in characters: a code block or a list is
 * tall for its length, and folding away a line or two saves nothing.
 */
const FOLD_REM = 9
const FOLD_OVER = 1.5

/** How the run ended, and its answer in its own words. */
export function Result({ work, now, fold = true }: { work: VoiceWork; now: number; fold?: boolean }) {
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
      <div className={cn('flex items-center gap-1.5 text-caption', head.tone)}>
        <Icon name={head.icon} size={12} />
        {head.text}
      </div>
      {work.result ? (
        <div className={cn('mt-1', long && !open ? 'max-h-[9rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]' : null)}>
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

/**
 * A hand-off: one line with the brief folded under it, then its run's live
 * steps, what it waits on, and its result.
 */
export function HandOff({ entry, now, steps = 3 }: { entry: Extract<Entry, { who: 'work' }>; now: number; steps?: number }) {
  const [briefOpen, setBriefOpen] = useState(false)
  const work = entry.continued ? undefined : entry.work
  const done = work ? work.state !== 'running' && work.state !== 'needs' : false
  return (
    <li className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-2" data-voice-line="agent" data-voice-work={entry.failed ? 'not_sent' : (work?.state ?? 'handed')}>
      <span className="flex items-center gap-1.5 self-start pt-[3px] text-caption text-tertiary">
        <StatusGlyph state={workGlyph(entry)} size={12} />
        {WHO.work}
      </span>
      <div className="min-w-0">
        <button
          type="button"
          className={cn('-mx-1.5 flex max-w-full items-center gap-1.5 rounded-sm px-1.5 text-left focus-visible:vy-focus-ring', CONTROL_HOVER)}
          aria-expanded={briefOpen}
          onClick={() => setBriefOpen(!briefOpen)}
        >
          <span className="shrink-0 text-sm text-fg">{entry.failed ? 'Asked' : done ? 'Did' : 'Doing'}</span>
          <span className={cn('min-w-0 text-sm text-muted', briefOpen ? null : 'truncate')}>{entry.brief}</span>
          <Icon name={briefOpen ? 'chevronUp' : 'chevron'} size={12} className="shrink-0 text-tertiary" />
        </button>
        {entry.failed ? (
          <div className="mt-1 flex items-center gap-1.5 text-caption text-danger" data-voice-handoff-failed={entry.failed}>
            <Icon name="warningCircle" size={12} />
            {HAND_OFF_FAILED[entry.failed]}
          </div>
        ) : null}
        {work && !done ? (
          <div className="mt-1">
            <Steps work={work} keep={steps} />
          </div>
        ) : null}
        {work ? <Ask work={work} /> : null}
        {work ? <Result work={work} now={now} /> : null}
      </div>
    </li>
  )
}

/** The conversation's lines, in any layout. */
export function ConversationItems({ entries, partial, now, steps }: { entries: readonly Entry[]; partial: string; now: number; steps?: number }) {
  return (
    <>
      {entries.map((e, i) =>
        e.who === 'work' ? (
          <HandOff key={e.id} entry={e} now={now} steps={steps} />
        ) : (
          <Line key={e.id} who={e.who} label={i === 0 || entries[i - 1]!.who !== e.who}>
            {e.text}
          </Line>
        )
      )}
      {partial ? <PartialLine text={partial} label={entries.at(-1)?.who !== 'you'} /> : null}
    </>
  )
}
