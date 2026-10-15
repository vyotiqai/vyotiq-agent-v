import { memo, useEffect, useRef, useState, type Ref } from 'react'
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

  Each chip carries its segment's index (`data-seg`), so the store can read
  the words back as segments when the field is redrawn.
*/

function basename(path: string): string {
  return path.split('/').pop() ?? path
}

function chipText(segment: Extract<Segment, { type: 'chip' }>): string {
  switch (segment.kind) {
    case 'file':
      return basename(segment.path)
    case 'slash':
      return segment.trigger
    default:
      return segment.label
  }
}

function Chip({ segment, index }: { segment: Extract<Segment, { type: 'chip' }>; index: number }) {
  const slash = segment.kind === 'slash'
  return (
    <span
      contentEditable={false}
      data-seg={index}
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
        <Icon name={segment.kind === 'context' ? segment.icon : 'branch'} size={13} className="text-muted" />
      )}
      <span className="truncate">{chipText(segment)}</span>
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
  inputRef,
  focusOnMount = false,
  caretAfter = null,
  onEdit
}: {
  segments: Segment[]
  placeholder: string
  size: 'sm' | 'brief'
  ariaLabel: string
  /** A take writing into the field: the field is read-only and shows these words. */
  live?: LiveWords
  /** The words the last take added after the typed ones, tinted while Undo is offered. */
  inserted?: string | null
  readOnly?: boolean
  /** The input wrap the @ and / menus anchor to. */
  anchorRef?: Ref<HTMLDivElement>
  /** The editable element itself. */
  inputRef?: (el: HTMLDivElement | null) => void
  /** Redrawn after a click (a pick, Send, a take), the field takes focus back with the caret at the end. */
  focusOnMount?: boolean
  /** ...with the caret after this segment (a chip just picked) instead of at the end. */
  caretAfter?: number | null
  /** Each edit, with the editable element. */
  onEdit?: (el: HTMLDivElement) => void
}) {
  const startsEmpty = !live && !inserted && segments.every((s) => s.type === 'text' && !s.value.trim())
  const [empty, setEmpty] = useState(startsEmpty)
  const locked = readOnly || Boolean(live)
  const el = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const node = el.current
    if (!focusOnMount || !node) return
    node.focus({ preventScroll: true })
    if (locked) return
    const sel = window.getSelection()
    const range = document.createRange()
    // After a picked chip: past the space that follows it, so typing goes on from there.
    const next = caretAfter === null ? null : node.querySelector(`[data-seg="${caretAfter}"]`)?.nextSibling?.firstChild
    if (next?.nodeType === Node.TEXT_NODE && (next as Text).data.startsWith(' ')) {
      range.setStart(next, 1)
    } else {
      range.selectNodeContents(node)
      range.collapse(false)
    }
    sel?.removeAllRanges()
    sel?.addRange(range)
    // Mount-only: the field is keyed by the store's rev, so each redraw is a new mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
          ref={(node) => {
            el.current = node
            inputRef?.(node)
          }}
          role={locked ? 'textbox' : 'combobox'}
          aria-multiline="true"
          aria-label={ariaLabel}
          aria-readonly={locked || undefined}
          data-composer-input
          tabIndex={locked ? -1 : 0}
          contentEditable={!locked}
          suppressContentEditableWarning
          onInput={(e) => {
            setEmpty(!(e.currentTarget.textContent ?? '').trim())
            onEdit?.(e.currentTarget)
          }}
          onPaste={(e) => {
            // The app pastes words, never another page's markup.
            e.preventDefault()
            const text = e.clipboardData.getData('text/plain')
            if (text) document.execCommand('insertText', false, text)
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
          ) : (
            <>
              {segments.map((s, i) => (s.type === 'text' ? <span key={i}>{s.value}</span> : <Chip key={i} segment={s} index={i} />))}
              {inserted ? (
                <span className="bg-accent-soft">
                  {segments.length ? ' ' : ''}
                  {inserted}
                </span>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
})
