import { useState, type ReactNode } from 'react'
import { VOICE_STATE_LABEL, type VoiceSessionState } from '@shared/voiceSession'
import { Icon } from '@renderer/lib/icons'
import { Button, StatusGlyph, cn, type TaskState } from '@renderer/lib/ui'
import { CONTROL_HOVER } from '@renderer/lib/utils/layout'
import { currentWork, type Scene, type Step, type Work } from './data'

/*
  The pieces all three directions share, with the fixes §24.7 calls for in
  every one of them:
  - the header names the task the session follows, not "OpenRouter · OpenRouter";
  - one name each: you, Agent V (the voice you talk to), and its task (the work);
  - a hand-off is one folded line that owns its steps and its result, not a
    "To the agent" paragraph in the conversation;
  - a turn split by a pause reads as one turn (mergeTurns).
*/

/** What's happening, in a word or two. Working says what, not who. */
export const HEADLINE: Readonly<Record<VoiceSessionState, string>> = {
  ...VOICE_STATE_LABEL,
  hearing: 'Listening',
  working: 'Working on it',
  waiting_on_you: 'Needs you'
}

export function subline(s: Scene): string {
  const work = currentWork(s)
  switch (s.state) {
    case 'listening':
      return s.entries.length === 0 ? 'Talk any time. Ask it to do something, or ask about the work.' : 'Talk any time'
    case 'hearing':
      return 'Pause when you’re done'
    case 'thinking':
      return 'Working out an answer'
    case 'working': {
      const step = work?.steps.at(-1)
      return step ? `${step.tool} ${step.summary}` : 'It keeps going while you talk'
    }
    case 'speaking':
      return 'Talk any time to interrupt'
    case 'waiting_on_you':
      return work?.ask?.kind === 'approval' ? `Allow it to ${work.ask.what}? Say yes or no` : 'Say your answer, or pick it on screen'
    case 'paused':
      return 'It keeps working. Press M to talk again'
    case 'error':
      return s.problem?.message ?? ''
    default:
      return ''
  }
}

const TASK_GLYPH: Record<Work['state'], TaskState> = { running: 'running', needs: 'needs', done: 'done', failed: 'failed' }

/** The pane's 40px row: what you're in, how long, and the task it follows. */
export function Header({ scene, children }: { scene: Scene; children?: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2" data-vv-header>
      <Icon name="waveform" size={14} className="text-muted" />
      <h2 className="m-0 text-sm font-medium text-fg-strong">Voice</h2>
      <span className="font-mono text-caption text-tertiary tnum">{scene.time}</span>
      {scene.task ? (
        <span className="ml-2 flex min-w-0 items-center gap-1.5 border-l border-border/60 pl-3" data-vv-following>
          <StatusGlyph state={TASK_GLYPH[scene.task.state]} size={13} label />
          <span className="truncate text-sm text-secondary">{scene.task.title}</span>
        </span>
      ) : null}
      <span className="flex-1" />
      {children}
      <Button size="xs" variant="ghost" icon="minimize">
        Show the task
      </Button>
    </div>
  )
}

/** Mute, the one stop that applies now, and End. */
export function Controls({ scene }: { scene: Scene }) {
  const muted = scene.state === 'paused'
  const dead = scene.state === 'error' || scene.state === 'connecting'
  return (
    <div className="flex items-center gap-1.5">
      <Button size="sm" variant="ghost" icon={muted ? 'micSlash' : 'mic'} aria-pressed={muted} disabled={dead}>
        {muted ? 'Unmute' : 'Mute'}
      </Button>
      {scene.state === 'speaking' ? (
        <Button size="sm" variant="ghost" icon="stop">
          Stop speaking
        </Button>
      ) : null}
      {scene.state === 'working' || scene.state === 'waiting_on_you' || (scene.state === 'paused' && scene.task?.state === 'running') ? (
        <Button size="sm" variant="ghost" icon="stop">
          Stop the task
        </Button>
      ) : null}
      <Button size="sm" variant="secondary" icon="close">
        End
      </Button>
    </div>
  )
}

/** A problem the session hit, our sentence first and the provider's reason after (D-40). */
export function Problem({ scene }: { scene: Scene }) {
  const p = scene.problem
  if (!p) return null
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs" role="alert">
      <Icon name="warningCircle" size={14} className="shrink-0 text-danger" />
      <span className="min-w-0 truncate">
        <span className="text-danger">{p.message}</span>
        {p.detail ? <span className="text-tertiary"> {p.detail}</span> : null}
      </span>
      {p.fix ? (
        <Button size="xs" variant="secondary">
          {p.fix}
        </Button>
      ) : null}
      <Button size="xs" variant="ghost" icon="retry">
        Try again
      </Button>
    </div>
  )
}

export const WHO = { you: 'You', voice: 'Agent V', work: 'Task' } as const

/** One line of the conversation: a fixed label column, then the words, on two hard edges. */
export function Line({ who, children, label = true, live }: { who: 'you' | 'voice'; children: ReactNode; label?: boolean; live?: boolean }) {
  return (
    <li className={cn('grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-1.5', live ? 'vv-rise' : null)} data-vv-line={who}>
      <span className="pt-px text-caption text-tertiary">{label ? WHO[who] : ''}</span>
      <span className={cn('text-sm leading-relaxed', who === 'you' ? 'text-fg-strong' : 'text-fg')}>{children}</span>
    </li>
  )
}

function StepRow({ step }: { step: Step }) {
  return (
    <li className="flex h-6 min-w-0 items-center gap-2" data-vv-step={step.state}>
      <StatusGlyph state={step.state === 'running' ? 'running' : step.state === 'failed' ? 'failed' : 'done'} size={13} />
      <span className={cn('shrink-0 text-xs', step.state === 'running' ? 'text-fg' : 'text-muted')}>{step.tool}</span>
      <span className={cn('min-w-0 truncate font-mono text-caption', step.state === 'running' ? 'text-secondary' : 'text-tertiary')}>
        {step.summary}
      </span>
    </li>
  )
}

/** The steps, newest last; older ones fold behind a count so the live one stays in view. */
export function Steps({ work, keep = 3 }: { work: Work; keep?: number }) {
  const [open, setOpen] = useState(false)
  const hidden = Math.max(0, work.steps.length - keep)
  const shown = open ? work.steps : work.steps.slice(hidden)
  return (
    <ol className="m-0 list-none p-0" aria-label="Steps">
      {hidden > 0 ? (
        <li>
          <button
            type="button"
            className={cn('flex h-6 items-center gap-2 rounded-sm text-xs text-tertiary hover:text-fg focus-visible:vy-focus-ring')}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <Icon name={open ? 'chevronUp' : 'chevronRight'} size={12} />
            {open ? 'Fewer steps' : `${hidden} earlier step${hidden === 1 ? '' : 's'}`}
          </button>
        </li>
      ) : null}
      {shown.map((s) => (
        <StepRow key={s.id} step={s} />
      ))}
    </ol>
  )
}

/** What the task is stopped on, answerable here or by voice. */
export function Ask({ work }: { work: Work }) {
  const ask = work.ask
  if (!ask) return null
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-l-2 border-accent pl-3" data-vv-ask>
      {ask.kind === 'approval' ? (
        <>
          <span className="text-sm text-fg-strong">
            Allow it to run <span className="font-mono text-xs">{ask.command}</span>?
          </span>
          <span className="flex-1" />
          <Button size="xs" variant="primary">
            Allow once
          </Button>
          <Button size="xs" variant="secondary">
            Deny
          </Button>
        </>
      ) : (
        <span className="text-sm text-fg-strong">{ask.prompt}</span>
      )}
    </div>
  )
}

/** The agent's answer, in its words; the voice says the short form. */
export function Result({ work, clamp = true }: { work: Work; clamp?: boolean }) {
  if (!work.result) return null
  return (
    <div className="mt-2" data-vv-result>
      <div className="flex items-center gap-1.5 text-caption text-success">
        <Icon name="checkCircle" size={12} />
        Done in {work.elapsed} · {work.steps.length} steps
      </div>
      <p className={cn('m-0 mt-1 text-sm leading-relaxed text-fg', clamp ? 'line-clamp-3' : null)}>{work.result}</p>
    </div>
  )
}

/**
 * A hand-off: one line with the brief folded under it, then its live steps,
 * then its result. Replaces the "To the agent" paragraph.
 */
export function HandOff({ work, steps = 3 }: { work: Work; steps?: number }) {
  const [briefOpen, setBriefOpen] = useState(false)
  return (
    <li className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-2" data-vv-work={work.state}>
      <span className="flex items-center gap-1.5 self-start pt-[3px] text-caption text-tertiary">
        <StatusGlyph state={TASK_GLYPH[work.state]} size={12} />
        {WHO.work}
      </span>
      <div className="min-w-0">
        <button
          type="button"
          className={cn('-mx-1.5 flex max-w-full items-center gap-1.5 rounded-sm px-1.5 text-left focus-visible:vy-focus-ring', CONTROL_HOVER)}
          aria-expanded={briefOpen}
          onClick={() => setBriefOpen(!briefOpen)}
        >
          <span className="shrink-0 text-sm text-fg">{work.state === 'done' ? 'Did' : 'Doing'}</span>
          <span className={cn('min-w-0 text-sm text-muted', briefOpen ? null : 'truncate')}>{work.brief}</span>
          <Icon name={briefOpen ? 'chevronUp' : 'chevron'} size={12} className="shrink-0 text-tertiary" />
        </button>
        {work.state === 'done' ? null : (
          <div className="mt-1">
            <Steps work={work} keep={steps} />
          </div>
        )}
        <Ask work={work} />
        <Result work={work} />
      </div>
    </li>
  )
}

/** The navigator beside the view, so the frame reads at its real proportion. Not part of the design. */
export function NavigatorStub({ scene }: { scene: Scene }) {
  const rows = [scene.task?.title ?? 'Rename the voice settings keys', 'Audit the release notes', 'Fix the title-bar drag region']
  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-chrome" aria-hidden="true">
      <div className="flex h-10 items-center border-b border-border pl-4 pr-2 text-sm font-medium text-fg-strong">VYOTIQ - AGENT V</div>
      <div className="flex flex-col gap-0.5 p-2">
        {rows.map((r, i) => (
          <div key={r} className={cn('flex h-8 items-center gap-2 rounded-md px-2 text-sm', i === 0 ? 'bg-surface-2 text-fg-strong' : 'text-muted')}>
            <StatusGlyph state={i === 0 ? (scene.task ? TASK_GLYPH[scene.task.state] : 'queued') : 'done'} size={13} />
            <span className="truncate">{r}</span>
          </div>
        ))}
      </div>
    </aside>
  )
}
