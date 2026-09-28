import type { ReactNode } from 'react'
import type { IconName } from '@renderer/lib/icons'
import { Button, Keys, ProgressBar, cn } from '@renderer/lib/ui'
import { VIcon, type VoiceIconName } from '../lib/icons'
import { LiveMeter, Meter, flatEnvelope, speechEnvelope } from './Meter'

/*
  A take: one stretch of dictation, from the mic opening to the words landing.

  The old design had four phases (idle, checking, recording, transcribing) and
  a strip that *replaced* the instruction field. Here the field never goes
  away — words land in it as you speak — and the take gets a strip of its own
  under it: what the mic hears, how long, where the audio goes, and the two
  ways out (Insert, Discard). Every state below is a row of the same 32px
  strip, so the eye learns one place and one shape.
*/

export type Engine = 'local' | 'openai' | 'openrouter'

/** Where the audio goes. Said once per take, in the strip — nowhere else. */
export const ENGINES: Record<Engine, { label: string; icon: VoiceIconName; privacy: string }> = {
  local: { label: 'This PC', icon: 'lock', privacy: 'Audio stays on this PC' },
  openai: { label: 'OpenAI', icon: 'cloud', privacy: 'Audio is sent to OpenAI with your key' },
  openrouter: { label: 'OpenRouter', icon: 'cloud', privacy: 'Audio is sent to OpenRouter with your key' }
}

export type Take =
  /** The mic is opening. Usually under 200 ms — the engine is checked before the press, not after. */
  | { kind: 'starting'; engine: Engine }
  | { kind: 'listening'; engine: Engine; elapsed: string; seed?: number; left?: string }
  /** Push-to-talk: the shortcut is held. Letting go inserts. */
  | { kind: 'hold'; engine: Engine; elapsed: string; seed?: number }
  /** Listening, but nothing has come in for a few seconds. */
  | { kind: 'silent'; engine: Engine; elapsed: string; device: string }
  /** Stopped listening; the last words are being settled. `progress` only where the engine reports it. */
  | { kind: 'finishing'; engine: Engine; audio: string; progress: number | null }
  /** The words are in the field. The strip stays a few seconds so Undo is findable. */
  | { kind: 'inserted'; words: number }
  /** Esc or Discard. The audio is kept a few seconds so a slip costs nothing. */
  | { kind: 'discarded'; audio: string }
  /** Transcription failed. The audio is kept, so Retry needs no re-speaking. */
  | { kind: 'failed'; engine: Engine; audio: string; reason: string; fix?: { label: string; icon?: IconName }; fallback?: Engine }

export function EngineToken({ engine, className }: { engine: Engine; className?: string }) {
  const e = ENGINES[engine]
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 text-caption text-tertiary', className)} title={e.privacy}>
      <VIcon name={e.icon} size={12} />
      {e.label}
    </span>
  )
}

function Time({ children, warn = false }: { children: ReactNode; warn?: boolean }) {
  return <span className={cn('shrink-0 font-mono text-xs tnum', warn ? 'text-warning' : 'text-secondary')}>{children}</span>
}

function RecDot({ hollow = false }: { hollow?: boolean }) {
  return (
    // Left-aligned in its 16px cell, so the dot sits on the field's text edge.
    <span className="flex size-4 shrink-0 items-center" aria-hidden="true">
      <span className={cn('size-2 rounded-full', hollow ? 'border border-border-strong' : 'animate-live bg-accent')} />
    </span>
  )
}

function Lead({ icon, tone }: { icon: VoiceIconName; tone: 'muted' | 'success' | 'danger' | 'warning' }) {
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center',
        tone === 'muted' ? 'text-muted' : tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-warning'
      )}
      aria-hidden="true"
    >
      <VIcon name={icon} size={14} className={icon === 'loader' ? 'motion-safe:animate-spin' : undefined} />
    </span>
  )
}

/**
 * The strip's grid: lead glyph · meter · time · engine · (message) · actions.
 * `gutter` is the width of whatever sits left of the field on this surface, so
 * the strip's first glyph lands on the field's left edge — one edge, not two.
 */
export function TakeStrip({
  take,
  sendLabel = 'Send',
  gutter,
  className
}: {
  take: Take
  /** The line's Ctrl+Enter. `null` where inserting is the only way out (the brief: Start task is its own button). */
  sendLabel?: string | null
  gutter?: ReactNode
  className?: string
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-take={take.kind}
      className={cn('flex h-8 min-w-0 items-center gap-2 text-xs', className)}
    >
      {gutter}
      <StripBody take={take} sendLabel={sendLabel} />
    </div>
  )
}

function StripBody({ take, sendLabel }: { take: Take; sendLabel: string | null }) {
  switch (take.kind) {
    case 'starting':
      return (
        <>
          <RecDot hollow />
          <Meter samples={flatEnvelope()} tone="quiet" />
          <span className="text-muted">Opening the mic</span>
          <span className="flex-1" />
          <EngineToken engine={take.engine} />
        </>
      )
    case 'listening':
      return (
        <>
          <RecDot />
          <span className="sr-only">Listening</span>
          <LiveMeter seed={take.seed ?? 3} />
          <Time>{take.elapsed}</Time>
          {take.left ? <Time warn>{`${take.left} left`}</Time> : null}
          <EngineToken engine={take.engine} />
          <span className="flex-1" />
          <Button size="xs" variant="ghost" kbd={['Esc']}>
            Discard
          </Button>
          {sendLabel ? (
            <Button size="xs" variant="ghost" kbd={['Ctrl', '↵']}>
              {sendLabel}
            </Button>
          ) : null}
          <Button size="xs" variant="secondary" kbd={['↵']}>
            Insert
          </Button>
        </>
      )
    case 'hold':
      return (
        <>
          <RecDot />
          <LiveMeter seed={take.seed ?? 5} />
          <Time>{take.elapsed}</Time>
          <EngineToken engine={take.engine} />
          <span className="flex-1" />
          <span className="flex items-center gap-1.5 text-muted">
            Release
            <Keys keys={['Ctrl', 'M']} />
            to insert
          </span>
        </>
      )
    case 'silent':
      return (
        <>
          <RecDot hollow />
          <Meter samples={flatEnvelope()} tone="quiet" />
          <Time>{take.elapsed}</Time>
          <span className="flex min-w-0 items-center gap-1.5 text-warning">
            <VIcon name="warningCircle" size={13} />
            <span className="min-w-0 truncate">{`Nothing heard from ${take.device}`}</span>
          </span>
          <span className="flex-1" />
          <Button size="xs" variant="ghost">
            Change mic
          </Button>
          <Button size="xs" variant="ghost" kbd={['Esc']}>
            Discard
          </Button>
        </>
      )
    case 'finishing':
      return (
        <>
          <Lead icon="loader" tone="muted" />
          <Meter samples={speechEnvelope(7)} tone="quiet" />
          <Time>{take.audio}</Time>
          <span className="text-muted">Finishing</span>
          {take.progress != null ? <ProgressBar value={take.progress} tone="accent" className="w-16" label="Transcription progress" /> : null}
          <EngineToken engine={take.engine} />
          <span className="flex-1" />
          <Button size="xs" variant="ghost" kbd={['Esc']}>
            Discard
          </Button>
        </>
      )
    case 'inserted':
      return (
        <>
          <Lead icon="check" tone="success" />
          <span className="text-secondary">
            <span className="font-mono tnum">{take.words}</span> words inserted
          </span>
          <span className="flex-1" />
          <Button size="xs" variant="ghost" kbd={['Ctrl', 'Z']}>
            Undo
          </Button>
        </>
      )
    case 'discarded':
      return (
        <>
          <Lead icon="trash" tone="muted" />
          <span className="text-muted">
            Discarded a <span className="font-mono tnum">{take.audio}</span> take
          </span>
          <span className="flex-1" />
          <Button size="xs" variant="ghost">
            Restore
          </Button>
        </>
      )
    case 'failed':
      return (
        <>
          <Lead icon="xCircle" tone="danger" />
          <span className="min-w-0 truncate text-danger" title={take.reason}>
            {take.reason}
          </span>
          <span className="shrink-0 text-tertiary">
            · <span className="font-mono tnum">{take.audio}</span> kept
          </span>
          <span className="flex-1" />
          <Button size="xs" variant="ghost" kbd={['Esc']}>
            Discard
          </Button>
          {take.fix ? (
            <Button size="xs" variant="ghost" icon={take.fix.icon}>
              {take.fix.label}
            </Button>
          ) : null}
          {take.fallback ? (
            <Button size="xs" variant="ghost">
              {`Try ${ENGINES[take.fallback].label}`}
            </Button>
          ) : null}
          <Button size="xs" variant="secondary" icon="retry">
            Retry
          </Button>
        </>
      )
    default: {
      const _exhaustive: never = take
      return _exhaustive
    }
  }
}
