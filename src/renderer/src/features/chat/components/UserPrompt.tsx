import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { MarkdownContent, Tooltip, cn } from '@renderer/lib/ui'
import { slashChipFromContent } from '@shared/slashCommands'
import { TOOL_BODY_CLAMP_PX, USER_PROMPT_SURFACE } from '@renderer/lib/utils/layout'
import type { UserItem } from '../utils/transcriptRows'
import { SlashChip } from './SlashChip'

/** One hover-revealed prompt action (edit / revert). */
const PROMPT_ACTION =
  'inline-grid size-6 shrink-0 place-items-center rounded-md text-muted vy-transition hover:bg-surface hover:text-fg focus-visible:vy-focus-ring'

export function UserPrompt({
  item,
  onImageClick: _onImageClick,
  editing = false,
  editComposer,
  onBeginEdit,
  onRevert,
  canRevert = false
}: {
  item: UserItem
  onImageClick: (url: string, label: string) => void
  editing?: boolean
  editComposer?: ReactNode
  onBeginEdit?: () => void
  onRevert?: () => void
  canRevert?: boolean
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const promptRef = useRef<HTMLDivElement>(null)
  const wasEditingRef = useRef(editing)
  const [overflows, setOverflows] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const slashChip = useMemo(
    () => (item.content ? slashChipFromContent(item.content) : null),
    [item.content]
  )

  const content = useMemo(() => {
    if (!item.content) return ''
    if (slashChip) {
      return slashChip.userRequest ?? ''
    }
    return item.content
  }, [item.content, slashChip])

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = (): void => {
      setOverflows(el.scrollHeight > TOOL_BODY_CLAMP_PX + 8)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [content, slashChip])

  useLayoutEffect(() => {
    if (wasEditingRef.current && !editing) promptRef.current?.focus()
    wasEditingRef.current = editing
  }, [editing])

  if (editing && editComposer) {
    return (
      <div ref={promptRef} tabIndex={-1} className="w-full">
        {editComposer}
      </div>
    )
  }

  const clamped = overflows && !expanded
  const editable = Boolean(onBeginEdit)
  const revertable = Boolean(onRevert && canRevert)
  const hasActions = editable || revertable
  const hasBody = Boolean(content) || Boolean(slashChip)

  return (
    <div
      ref={promptRef}
      data-user-prompt
      className={cn(
        USER_PROMPT_SURFACE,
        'relative',
        hasActions && 'group/prompt',
        // Keep the bubble's border stable on hover. The actions fading in are
        // the edit affordance; the surface owns the theme-aware corner radius.
        editable &&
          'cursor-text vy-transition focus-visible:outline-none focus-visible:vy-focus-ring'
      )}
      role={editable ? 'button' : undefined}
      tabIndex={editable ? 0 : undefined}
      aria-label={editable ? 'Edit user message' : undefined}
      aria-keyshortcuts={editable ? 'Enter Space' : undefined}
      onClick={
        editable
          ? (e) => {
              const target = e.target as HTMLElement
              if (target.closest('button, a, input, textarea, [data-no-prompt-edit]')) return
              const selected = window.getSelection()?.toString()
              if (selected) return
              onBeginEdit?.()
            }
          : undefined
      }
      onKeyDown={
        editable
          ? (e: KeyboardEvent<HTMLDivElement>) => {
              const target = e.target as HTMLElement
              if (target.closest('button, a, input, textarea, [data-no-prompt-edit]')) return
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              onBeginEdit?.()
            }
          : undefined
      }
    >
      {hasBody ? (
        <div
          ref={bodyRef}
          className={cn('relative overflow-hidden', clamped && 'mask-fade-bottom')}
          style={clamped ? { maxHeight: TOOL_BODY_CLAMP_PX } : undefined}
        >
          {slashChip ? (
            <div className="flex flex-col gap-2">
              <SlashChip name={slashChip.name} kind={slashChip.kind} />
              {content ? (
                <MarkdownContent content={content} readOnlyTasks />
              ) : null}
            </div>
          ) : (
            <MarkdownContent content={content} readOnlyTasks />
          )}
        </div>
      ) : null}

      {hasActions ? (
        // Floats over the text rather than reserving a right gutter, so the
        // prompt's words run the full width of the column like every other
        // transcript row. Painted after the body so it covers what it overlaps;
        // the page-colored fade masks the line underneath while it is shown.
        <div
          className={cn(
            'absolute right-0 top-1 flex items-center gap-0.5 pl-8',
            'bg-gradient-to-l from-bg via-bg to-transparent',
            'opacity-0 vy-transition',
            '[@media(hover:none)]:opacity-100',
            'group-hover/prompt:opacity-100 group-focus-within/prompt:opacity-100',
            'focus-within:opacity-100'
          )}
          data-no-prompt-edit
        >
          {editable ? (
            <Tooltip content="Edit message">
              <button
                type="button"
                className={PROMPT_ACTION}
                aria-label="Edit message"
                onClick={(e) => {
                  e.stopPropagation()
                  onBeginEdit?.()
                }}
              >
                <Icon name="edit" size={14} />
              </button>
            </Tooltip>
          ) : null}
          {revertable ? (
            <Tooltip content="Restore files and chat as they were before this prompt">
              <button
                type="button"
                className={PROMPT_ACTION}
                aria-label="Revert to before this prompt"
                onClick={(e) => {
                  e.stopPropagation()
                  onRevert?.()
                }}
              >
                <Icon name="revert" size={14} />
              </button>
            </Tooltip>
          ) : null}
        </div>
      ) : null}

      {overflows ? (
        <button
          type="button"
          className="mt-1 text-xs font-medium text-tertiary vy-transition hover:text-fg"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}

    </div>
  )
}
