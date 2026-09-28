import { useState, type ReactNode } from 'react'
import { formatDisplayTime } from '@shared/utils/timeFormat'
import { Icon } from '@renderer/lib/icons'
import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { IconButton, cn } from '@renderer/lib/ui'
import type { RecordRun } from '../recordModel'
import { RecordRow } from './RecordLayout'

/** Past this many characters the brief folds to six lines until opened. */
const FOLD_AT = 600

function kb(chars: number): string {
  return chars >= 1024 ? `${Math.round(chars / 1024)}k chars` : `${chars} chars`
}

/**
 * The instruction a run started from — the brief, or a follow-up. It is the
 * one thing in the record you wrote, so it sits on its own quiet plane: a
 * surface fill that bleeds into the gutter as far as every other fill in the
 * record (a live step, a hovered row), its text on the column's edge like
 * every row under it. No heading and no avatar — the plane says whose words
 * these are. Edit-and-rerun and rewind sit at its right edge on hover, beside
 * the words rather than over them.
 */
export function Brief({
  run,
  editing,
  editComposer,
  onEdit,
  onRewind,
  onImageClick
}: {
  run: RecordRun
  /** This brief is being edited: the editor takes its place. */
  editing?: boolean
  editComposer?: ReactNode
  onEdit?: () => void
  onRewind?: () => void
  onImageClick?: (src: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (editing && editComposer) {
    return <RecordRow className="pt-5">{editComposer}</RecordRow>
  }
  const long = run.text.length > FOLD_AT
  const when = run.at != null ? formatDisplayTime(new Date(run.at).toISOString()) : ''
  const title = when ? `${run.n === 1 ? 'Brief' : 'Follow-up'} · ${when}` : undefined
  return (
    <RecordRow className="pt-5">
      <div className="group -mx-2 flex items-start gap-3 rounded-lg bg-surface px-2 py-2.5" data-brief={run.n}>
        <div className="min-w-0 flex-1">
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
          {run.text ? (
            <p
              className={cn(
                'whitespace-pre-wrap text-md leading-[22px] text-fg-strong [overflow-wrap:anywhere]',
                long && !open && 'line-clamp-6'
              )}
              title={title}
            >
              {run.text}
            </p>
          ) : null}
          {long ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="mt-1 rounded-sm text-xs text-muted hover:text-fg focus-visible:vy-focus-ring"
            >
              {open ? 'Show less' : 'Show all'}
            </button>
          ) : null}
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
              {run.attachments.map((a) => (
                <span
                  key={a.name}
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
        {onEdit || onRewind ? (
          // Centred on the first line; hidden until the brief is hovered or holds focus.
          <div className="-my-px flex shrink-0 gap-1 opacity-0 vy-transition group-hover:opacity-100 group-focus-within:opacity-100">
            {onEdit ? <IconButton icon="edit" label="Edit and rerun" size="sm" tone="onSurface" onClick={onEdit} /> : null}
            {onRewind ? (
              <IconButton
                icon="undo"
                label="Rewind files and record to before this instruction"
                size="sm"
                tone="onSurface"
                onClick={onRewind}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </RecordRow>
  )
}
