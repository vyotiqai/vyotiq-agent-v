import { useContext, useState, type ReactNode } from 'react'
import { formatDisplayTime } from '@shared/utils/timeFormat'
import { Icon } from '@renderer/lib/icons'
import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { IconButton, cn } from '@renderer/lib/ui'
import type { RecordRun } from '../recordModel'
import { followUpOrigin, type FollowUpOrigin } from '../followUps'
import { RecordOpenContext, briefOpenKey } from '../recordFind'
import { RecordRow } from './RecordLayout'
import { TickedText } from './TickedText'

/** Past this many characters the brief folds to six lines until opened. */
const FOLD_AT = 600

function kb(chars: number): string {
  return chars >= 1024 ? `${Math.round(chars / 1024)}k chars` : `${chars} chars`
}

/**
 * The brief as written — no markdown, it is your words — except that a
 * `backticked` span reads as code, as it does everywhere else in the record.
 * A check's follow-up quoted `pnpm exec vitest run …` with its ticks showing.
 * The chip is a step up from the brief's own surface plane.
 */
export function BriefText({ text }: { text: string }) {
  return <TickedText text={text} code="rounded-sm bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]" />
}

/**
 * A follow-up the app wrote and sent for you: what it asked, a step quieter
 * than words you typed — the ask, and the check or failure it is about —
 * with the instruction as sent behind "Show as sent".
 */
function AppFollowUp({
  origin,
  text,
  title,
  open,
  onToggle
}: {
  origin: FollowUpOrigin
  text: string
  title?: string
  open: boolean
  onToggle: () => void
}) {
  return (
    <div data-brief-origin={origin.kind}>
      <p className="m-0 flex min-w-0 items-center gap-2 text-sm leading-[22px]" title={title}>
        <Icon name={origin.icon} size={14} className="shrink-0 text-tertiary" />
        <span className="min-w-0 font-medium text-fg-strong [overflow-wrap:anywhere]">{origin.ask}</span>
      </p>
      {origin.about ? (
        <p className="m-0 whitespace-pre-wrap pl-[22px] text-sm text-secondary [overflow-wrap:anywhere]">
          <BriefText text={origin.about} />
        </p>
      ) : null}
      {open ? (
        <p className="m-0 mt-1.5 whitespace-pre-wrap pl-[22px] text-xs leading-relaxed text-muted [overflow-wrap:anywhere]" data-brief-sent>
          <BriefText text={text} />
        </p>
      ) : null}
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="ml-[22px] mt-1 rounded-sm text-xs text-muted hover:text-fg focus-visible:vy-focus-ring"
      >
        {open ? 'Hide what was sent' : 'Show as sent'}
      </button>
    </div>
  )
}

/**
 * A brief Structure wrote: the words you typed are one click away, under it,
 * a step quieter — the brief is what the agent worked from.
 */
function StructuredFrom({ words }: { words: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-0.5" data-brief-structured-from>
      {/* 24px tall: it sits a line under "Show all", and two small targets that close must each be 24px (WCAG 2.5.8). */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex min-h-6 items-center gap-1 rounded-sm text-xs text-muted hover:text-fg focus-visible:vy-focus-ring"
      >
        <Icon name="sparkles" size={12} className="shrink-0" />
        {open ? 'Hide what you wrote' : 'Structured from what you wrote'}
      </button>
      {open ? (
        <p className="m-0 mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">
          <BriefText text={words} />
        </p>
      ) : null}
    </div>
  )
}

/**
 * An instruction you said in voice mode: the conversation it came from is a
 * click away (docs/voice-mode.md §24.8).
 */
function SaidByVoice({ turns, onOpen }: { turns: number; onOpen: () => void }) {
  return (
    <div className="mt-0.5" data-brief-voice>
      {/* 24px tall, as "Structured from what you wrote" (WCAG 2.5.8). */}
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex min-h-6 items-center gap-1 rounded-sm text-xs text-muted hover:text-fg focus-visible:vy-focus-ring"
      >
        <Icon name="mic" size={12} className="shrink-0" />
        Said by voice · {turns} {turns === 1 ? 'turn' : 'turns'}
      </button>
    </div>
  )
}

/**
 * The instruction a run started from — the brief, or a follow-up. It is the
 * one thing in the record you wrote, so it reads as your side of the
 * conversation: a bubble on the column's right edge, as wide as its words,
 * its fill bleeding into the gutter as far as every other fill in the record
 * (a live step, a hovered row). No heading and no avatar — the side says
 * whose words these are. Edit-and-rerun and rewind sit just left of it on
 * hover, beside the words rather than over them.
 */
export function Brief({
  run,
  editing,
  editComposer,
  onEdit,
  onRewind,
  onFork,
  onImageClick,
  voice
}: {
  run: RecordRun
  /** Said in voice mode: how long the conversation ran, and how to open it. */
  voice?: { turns: number; onOpen: () => void }
  /** This brief is being edited: the editor takes its place. */
  editing?: boolean
  editComposer?: ReactNode
  onEdit?: () => void
  onRewind?: () => void
  /** A new task with the record up to here, this instruction's turn included. */
  onFork?: () => void
  onImageClick?: (src: string) => void
}) {
  const [userOpen, setOpen] = useState(false)
  // Find in record opens a brief whose folded words hold a match.
  const forced = useContext(RecordOpenContext).has(briefOpenKey(run.n))
  const open = userOpen || forced
  if (editing && editComposer) {
    return (
      <RecordRow className="pt-5">
        {editComposer}
        {/* What Rerun does before it starts, said before you press it. */}
        <p className="m-0 mt-1.5 text-caption text-tertiary" data-rerun-note>
          Rerunning undoes this task’s edits since this brief first, then starts again from it.
        </p>
      </RecordRow>
    )
  }
  // A follow-up the app wrote for you reads as what it asked; the words it sent are a click away.
  const origin = run.command ? null : followUpOrigin(run.text)
  const long = !origin && run.text.length > FOLD_AT
  const when = run.at != null ? formatDisplayTime(new Date(run.at).toISOString()) : ''
  const title = when ? `${run.n === 1 ? 'Brief' : 'Follow-up'} · ${when}` : undefined
  return (
    <RecordRow className="pt-5">
      <div className="group relative -mr-2 ml-auto w-fit min-w-0 max-w-[85%] rounded-lg bg-surface px-3.5 py-2.5" data-brief={run.n}>
        <div className="min-w-0">
          {run.command ? (
            // The command it invoked, as the composer showed it, slash and all —
            // not the prompt it expanded to.
            <p
              className={cn('min-w-0 truncate font-mono text-sm leading-[22px] text-accent', run.text && 'mb-0.5')}
              title={title}
              data-brief-command
            >
              /{run.command}
            </p>
          ) : null}
          {origin ? (
            <AppFollowUp origin={origin} text={run.text} title={title} open={open} onToggle={() => setOpen(!open)} />
          ) : run.text ? (
            <p
              className={cn(
                'whitespace-pre-wrap text-md leading-[22px] text-fg-strong [overflow-wrap:anywhere]',
                long && !open && 'line-clamp-6'
              )}
              title={title}
            >
              <BriefText text={run.text} />
            </p>
          ) : null}
          {long ? (
            <button
              type="button"
              onClick={() => setOpen(!open)}
              className="mt-1 rounded-sm text-xs text-muted hover:text-fg focus-visible:vy-focus-ring"
            >
              {open ? 'Show less' : 'Show all'}
            </button>
          ) : null}
          {run.structuredFrom && !origin ? <StructuredFrom words={run.structuredFrom} /> : null}
          {voice && !origin ? <SaidByVoice turns={voice.turns} onOpen={voice.onOpen} /> : null}
          {run.images.length > 0 || run.attachments.length > 0 ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {run.images.map((src, i) => (
                <button
                  key={`img-${i}`}
                  type="button"
                  onClick={() => onImageClick?.(src)}
                  className="overflow-hidden rounded-md bg-bg focus-visible:vy-focus-ring"
                  aria-label={`Open attached image ${i + 1}`}
                >
                  <img src={src} alt="" className="h-14 w-20 object-cover" />
                </button>
              ))}
              {run.attachments.map((a, i) => (
                <span
                  // Names repeat: every dictated clip is "audio".
                  key={`${i}:${a.name}`}
                  className="inline-flex h-7 items-center gap-2 rounded-md bg-bg pl-1.5 pr-2 text-xs text-secondary"
                >
                  {a.mime.startsWith('image/') ? (
                    <Icon name="image" size={13} className="text-muted" />
                  ) : (
                    <FileTypeIcon path={a.name} size={14} />
                  )}
                  {a.name}
                  <span className="font-mono text-caption text-tertiary tnum">{kb(a.chars)}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {onEdit || onRewind || onFork ? (
          // Beside the first line, outside the bubble; hidden until the brief is hovered or holds focus.
          <div className="absolute right-full top-2 mr-1 flex gap-1 opacity-0 vy-transition group-hover:opacity-100 group-focus-within:opacity-100">
            {onEdit ? <IconButton icon="edit" label="Edit and rerun" size="sm" tone="muted" onClick={onEdit} /> : null}
            {onRewind ? (
              <IconButton
                icon="undo"
                label="Rewind files and record to before this instruction"
                size="sm"
                tone="muted"
                onClick={onRewind}
              />
            ) : null}
            {onFork ? (
              <IconButton
                icon="fork"
                label="Fork from here: a new task with the record up to this instruction's result"
                size="sm"
                tone="muted"
                onClick={onFork}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </RecordRow>
  )
}
