import { memo, useState, type Ref } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import { fileIconUrl } from '@renderer/lib/fileIcons'
import { slashKindIcon } from '../../../../renderer/src/features/chat/components/composer/slashCommandPresentation'
import type { Segment } from './data'

/*
  ComposerMentionInput, replicated: the contentEditable field, its chips and
  its placeholder. `sm` is the instruction line and Edit and rerun; `brief`
  is the New task box. Chip classes are chipClassName's; file chips carry
  their file-type image, every other chip its menu row's glyph.
*/

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

function Chip({ segment }: { segment: Extract<Segment, { type: 'chip' }> }) {
  const slash = segment.kind === 'slash'
  return (
    <span
      contentEditable={false}
      data-mention-kind={segment.kind}
      className={cn(
        'mention-chip mx-0.5 inline-flex max-w-[12rem] items-center gap-1 align-baseline',
        'px-0.5 text-sm leading-none',
        slash ? 'text-accent' : 'text-secondary',
        'select-none'
      )}
    >
      {segment.kind === 'file' ? (
        <img src={fileIconUrl(segment.path)} alt="" aria-hidden="true" width={14} height={14} draggable={false} className="shrink-0 object-contain" />
      ) : segment.kind === 'slash' ? (
        <Icon name={slashKindIcon(segment.slashKind, segment.trigger)} size={13} className="text-muted" />
      ) : (
        <Icon name="branch" size={13} className="text-muted" />
      )}
      <span className="truncate">
        {segment.kind === 'file' ? basename(segment.path) : segment.kind === 'slash' ? segment.trigger : segment.label}
      </span>
    </span>
  )
}

/** Words a take has heard but not settled: painted like `::highlight(vy-take-partial)`. */
export type LiveWords = { settled: string; partial: string } | null

export const Field = memo(function Field({
  segments,
  placeholder,
  size,
  ariaLabel,
  live = null,
  inserted = null,
  readOnly = false,
  anchorRef,
  onTypedChange
}: {
  segments: Segment[]
  placeholder: string
  size: 'sm' | 'brief'
  ariaLabel: string
  /** A take writing into the field: the field is read-only and shows these words. */
  live?: LiveWords
  /** The words the last take added, tinted while Undo is offered. */
  inserted?: string | null
  readOnly?: boolean
  /** The input wrap the @ and / menus anchor to. */
  anchorRef?: Ref<HTMLDivElement>
  /** Whether the field holds words, each time that changes. */
  onTypedChange?: (typed: boolean) => void
}) {
  const startsEmpty = !live && !inserted && segments.every((s) => s.type === 'text' && !s.value.trim())
  const [empty, setEmpty] = useState(startsEmpty)
  const locked = readOnly || Boolean(live)
  return (
    <div ref={anchorRef} className="min-w-0" data-composer-input-wrap>
      <div className="relative w-full min-w-0">
        {empty && placeholder ? (
          <div
            className={cn(
              'pointer-events-none absolute inset-0 flex tracking-normal',
              size === 'sm' ? 'items-center truncate text-sm text-tertiary' : 'items-start text-md leading-[22px] text-tertiary'
            )}
            aria-hidden
          >
            {placeholder}
          </div>
        ) : null}
        <div
          role={locked ? 'textbox' : 'combobox'}
          aria-multiline="true"
          aria-label={ariaLabel}
          aria-readonly={locked || undefined}
          data-composer-input
          tabIndex={locked ? -1 : 0}
          contentEditable={!locked}
          suppressContentEditableWarning
          onInput={(e) => {
            const nowEmpty = !(e.currentTarget.textContent ?? '').trim()
            setEmpty(nowEmpty)
            onTypedChange?.(!nowEmpty)
          }}
          className={cn(
            'w-full min-w-0 overflow-y-auto whitespace-pre-wrap break-words',
            size === 'sm' ? 'min-h-5 text-sm leading-5 text-fg-strong' : 'min-h-[88px] text-md leading-[22px] text-fg-strong',
            size === 'brief' ? 'max-h-[50vh]' : 'max-h-[280px]',
            'border-0 bg-transparent p-0 outline-none ring-0 focus:ring-0 focus-visible:ring-0'
          )}
        >
          {live ? (
            <>
              {live.settled}
              <span className="text-tertiary">{live.partial}</span>
            </>
          ) : inserted ? (
            <span className="bg-accent-soft">{inserted}</span>
          ) : (
            segments.map((s, i) => (s.type === 'text' ? <span key={i}>{s.value}</span> : <Chip key={i} segment={s} />))
          )}
        </div>
      </div>
    </div>
  )
})
