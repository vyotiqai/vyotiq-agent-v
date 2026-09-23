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
 * The instruction a run started from — the brief, or a follow-up. Its own
 * shape says what it is, so it carries no heading. Edit-and-rerun and rewind
 * sit on hover, where the old prompt bubble kept them.
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
  return (
    <RecordRow className="pt-5">
      <div className="group relative" data-brief={run.n}>
        <p
          className={cn(
            'whitespace-pre-wrap text-md leading-[22px] text-fg-strong [overflow-wrap:anywhere]',
            long && !open && 'line-clamp-6'
          )}
          title={when ? `${run.n === 1 ? 'Brief' : 'Follow-up'} · ${when}` : undefined}
        >
          {run.text}
        </p>
        {long ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-1 text-xs text-tertiary hover:text-fg focus-visible:vy-focus-ring"
          >
            {open ? 'Show less' : 'Show all'}
          </button>
        ) : null}
        {run.images.length > 0 || run.attachments.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {run.images.map((src, i) => (
              <button
                key={`img-${i}`}
                type="button"
                onClick={() => onImageClick?.(src)}
                className="overflow-hidden rounded-md bg-surface focus-visible:vy-focus-ring"
                aria-label={`Open attached image ${i + 1}`}
              >
                <img src={src} alt="" className="h-14 w-20 object-cover" />
              </button>
            ))}
            {run.attachments.map((a) => (
              <span
                key={a.name}
                className="inline-flex h-7 items-center gap-2 rounded-md bg-surface pl-1.5 pr-2 text-xs text-secondary"
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
        {onEdit || onRewind ? (
          <div className="absolute -right-1 -top-1 flex gap-0.5 opacity-0 vy-transition group-hover:opacity-100 group-focus-within:opacity-100">
            {onEdit ? <IconButton icon="edit" label="Edit and rerun" size="sm" tone="muted" className="bg-bg" onClick={onEdit} /> : null}
            {onRewind ? (
              <IconButton
                icon="undo"
                label="Rewind files and record to before this instruction"
                size="sm"
                tone="muted"
                className="bg-bg"
                onClick={onRewind}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </RecordRow>
  )
}
