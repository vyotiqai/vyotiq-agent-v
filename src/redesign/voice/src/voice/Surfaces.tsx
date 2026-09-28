import type { ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { IconButton, Ring, cn } from '@renderer/lib/ui'
import { VIcon } from '../lib/icons'
import { TakeStrip, type Take } from './Take'

/*
  The two places you dictate into — the instruction line under a task and the
  brief on New task — built the same way: the field, then the take strip.
  (Edit and rerun reuses the brief box, so it is covered by the same pieces.)
*/

/** What the mic says about dictation before you press it. */
export type MicState =
  /** Ready. Tooltip: "Dictate · Ctrl M · This PC". */
  | 'idle'
  /** Nothing to transcribe with yet. The dot is the one "needs you" mark; pressing opens setup. */
  | 'setup'
  /** A take is open: pressing inserts. */
  | 'live'
  /** Windows is blocking the microphone. Pressing explains how to allow it. */
  | 'blocked'

const micLook = 'inline-grid size-7 shrink-0 place-items-center rounded-md vy-transition focus-visible:vy-focus-ring'

export function MicButton({ state, className }: { state: MicState; className?: string }) {
  switch (state) {
    case 'idle':
      return <IconButton icon="mic" label="Dictate (Ctrl+M)" size="md" tone="muted" className={className} />
    case 'live':
      return <IconButton icon="mic" label="Insert (Ctrl+M)" size="md" active weight="fill" className={className} />
    case 'setup':
      return (
        <button type="button" aria-label="Set up dictation" className={cn(micLook, 'relative text-tertiary hover:bg-surface hover:text-fg', className)}>
          <Icon name="mic" size={16} />
          <span aria-hidden="true" className="absolute right-1 top-1 size-1.5 rounded-full bg-accent" />
        </button>
      )
    case 'blocked':
      return (
        <button type="button" aria-label="Microphone blocked — how to allow it" className={cn(micLook, 'text-warning hover:bg-surface', className)}>
          <VIcon name="micSlash" size={16} />
        </button>
      )
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

/** The mode · model · effort token, as the line shows it. */
export function OptionsToken() {
  return (
    <span className="inline-flex h-7 min-w-0 max-w-full shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted">
      <Ring value={0.34} size={12} stroke={1.75} />
      <span className="font-mono tnum">34%</span>
      <span aria-hidden="true" className="text-tertiary">
        ·
      </span>
      <span className="min-w-0 truncate">Agent · v4.1-flash · High</span>
      <Icon name="chevron" size={10} className="shrink-0 text-tertiary" />
    </span>
  )
}

/** A draft in the field, with the take's words at the caret. */
export type Draft = {
  before: string
  live?:
    | { mode: 'words'; settled: string; partial?: string }
    /** An engine that only answers at the end: a marker holds the place. The time is the strip's to say. */
    | { mode: 'pending' }
    /** Just inserted: tinted for a moment so you can see what the take added. */
    | { mode: 'inserted'; text: string }
  after?: string
}

function Caret() {
  return <span aria-hidden="true" className="mx-px inline-block h-[15px] w-[2px] translate-y-[3px] animate-live rounded-full bg-accent" />
}

export function DraftText({ draft, placeholder }: { draft: Draft; placeholder?: string }) {
  const empty = !draft.before && !draft.live && !draft.after
  if (empty) return <span className="text-tertiary">{placeholder}</span>
  const live = draft.live
  return (
    <>
      {draft.before}
      {live?.mode === 'words' ? (
        <>
          {draft.before && !/\s$/.test(draft.before) ? ' ' : null}
          <span className="text-fg-strong">{live.settled}</span>
          {live.partial ? <span className="text-tertiary">{` ${live.partial}`}</span> : null}
          <Caret />
        </>
      ) : null}
      {live?.mode === 'pending' ? (
        <>
          {draft.before && !/\s$/.test(draft.before) ? ' ' : null}
          <span
            className="mx-0.5 inline-flex h-5 translate-y-[-1px] items-center rounded-sm bg-accent-soft px-1 align-middle text-accent"
            title="Your words land here"
          >
            <Icon name="waveform" size={13} />
          </span>
        </>
      ) : null}
      {live?.mode === 'inserted' ? (
        <>
          {draft.before && !/\s$/.test(draft.before) ? ' ' : null}
          <span className="rounded-sm bg-accent-soft text-fg-strong [box-decoration-break:clone]">{live.text}</span>
        </>
      ) : null}
      {draft.after}
    </>
  )
}

/** The states in which the mic is open. Pressing it then inserts; attaching waits. */
const CAPTURING: ReadonlySet<Take['kind']> = new Set(['starting', 'listening', 'hold', 'silent'])

/** The `›` glyph, and an invisible twin that puts the strip on the field's left edge. */
function Prompt({ ghost = false }: { ghost?: boolean }) {
  return (
    <span
      aria-hidden="true"
      // The strip's gap is 8px and the line's is 10px; the ghost carries the 2px
      // difference itself, since cn() cannot override the strip's gap.
      className={cn('flex shrink-0 items-center font-mono text-md font-semibold', ghost ? 'invisible mr-0.5 h-4' : 'h-7 text-accent')}
    >
      ›
    </span>
  )
}

/**
 * The instruction line. While a take is open the field keeps its text and the
 * strip sits under it, on the field's edge; the paperclip steps aside (you
 * cannot attach mid-sentence) and the mic shows as pressed.
 */
export function InstructionLine({
  draft,
  take,
  mic = 'idle',
  placeholder = 'Steer the run — it reads this between steps',
  sendLabel = 'Send',
  popover,
  popoverAlign = 'end'
}: {
  draft: Draft
  take?: Take
  mic?: MicState
  placeholder?: string
  sendLabel?: string | null
  /** Opened from the mic: a popover hangs from its right edge, a tooltip centres on it. */
  popover?: ReactNode
  popoverAlign?: 'end' | 'center'
}) {
  const capturing = take != null && CAPTURING.has(take.kind)
  return (
    <div className="relative shrink-0 border-t border-border bg-bg" data-composer-line>
      <div className="flex min-h-11 items-start gap-2.5 px-4 py-2">
        <Prompt />
        <p className="m-0 min-w-0 flex-1 whitespace-pre-wrap py-1 text-sm leading-5 text-fg [overflow-wrap:anywhere]">
          <DraftText draft={draft} placeholder={placeholder} />
        </p>
        {capturing ? null : <IconButton icon="paperclip" label="Attach files" size="md" tone="muted" />}
        <span className="relative shrink-0">
          <MicButton state={capturing ? 'live' : mic} />
          {popover ? (
            <div className={cn('absolute bottom-full z-dropdown mb-3', popoverAlign === 'center' ? 'left-1/2 -translate-x-1/2' : 'right-0')}>
              {popover}
            </div>
          ) : null}
        </span>
        <OptionsToken />
      </div>
      {take ? (
        <TakeStrip take={take} sendLabel={sendLabel} gutter={<Prompt ghost />} className="-mt-1.5 px-4 pb-1.5" />
      ) : null}
    </div>
  )
}

/**
 * The brief's box on New task. The take strip takes the place of its bottom
 * row (attachments, @, paperclip, mic) — the same row, the same edges.
 */
export function BriefBox({
  draft,
  take,
  mic = 'idle',
  popover
}: {
  draft: Draft
  take?: Take
  mic?: MicState
  popover?: ReactNode
}) {
  const capturing = take != null && CAPTURING.has(take.kind)
  return (
    <div className={cn('relative rounded-lg border bg-bg', capturing ? 'border-border-strong' : 'border-border')}>
      <p className="m-0 min-h-[110px] whitespace-pre-wrap px-4 pt-3 text-md leading-[22px] text-fg [overflow-wrap:anywhere]">
        <DraftText draft={draft} placeholder="Describe the task — the agent plans it, does it, and shows you the result" />
      </p>
      {take ? (
        <TakeStrip take={take} sendLabel={null} className="px-4 pb-2 pt-1" />
      ) : (
        <div className="flex items-center gap-1 px-3 pb-3 pt-1">
          <span className="flex-1" />
          <IconButton icon="at" label="Add context" size="md" tone="muted" />
          <IconButton icon="paperclip" label="Attach files" size="md" tone="muted" />
          <MicButton state={mic} />
        </div>
      )}
      {popover ? <div className="absolute right-0 top-full z-dropdown mt-1.5">{popover}</div> : null}
    </div>
  )
}
