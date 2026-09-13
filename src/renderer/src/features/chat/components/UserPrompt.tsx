import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { parseOpenableAttachmentPath } from '@shared/utils/linkableWorkspacePath'
import { FileChip, ImageChip, MarkdownContent, Tooltip, cn } from '@renderer/lib/ui'
import { useRunSession } from '../RunSessionContext'
import { slashChipFromContent } from '@shared/slashCommands'
import { TOOL_BODY_CLAMP_PX, USER_PROMPT_SURFACE } from '@renderer/lib/utils/layout'
import type { UserItem } from '../utils/transcriptRows'
import { SlashChip } from './SlashChip'

export function UserPrompt({
  item,
  onImageClick,
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
  const { onOpenWorkspaceFile: openWorkspaceFile } = useRunSession()
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
  const hasBody = Boolean(content) || Boolean(slashChip)

  return (
    <div
      ref={promptRef}
      data-user-prompt
      className={cn(
        USER_PROMPT_SURFACE,
        'relative',
        (editable || revertable) &&
          cn(
            'group/prompt vy-transition',
            editable &&
              'cursor-text hover:border-border-strong hover:bg-surface/30 focus-visible:outline-none focus-visible:vy-focus-ring'
          )
      )}
      role={editable ? 'button' : undefined}
      tabIndex={editable ? 0 : undefined}
      aria-label={editable ? 'Edit user message' : undefined}
      aria-keyshortcuts={editable ? 'Enter Space' : undefined}
      title={editable ? 'Click or press Enter to edit' : undefined}
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
      {editable ? (
        <Tooltip content="Edit message">
          <button
            type="button"
            className={cn(
              'absolute top-1 z-sticky inline-grid size-6 place-items-center rounded-md',
              revertable ? 'right-8' : 'right-1',
              'text-muted hover:bg-surface hover:text-fg',
              'opacity-0 vy-transition',
              '[@media(hover:none)]:opacity-100',
              'group-hover/prompt:opacity-100 group-focus-within/prompt:opacity-100',
              'focus-visible:opacity-100 focus-visible:vy-focus-ring'
            )}
            aria-label="Edit message"
            data-no-prompt-edit
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
            className={cn(
              'absolute right-1 top-1 z-sticky inline-grid size-6 place-items-center rounded-md',
              'text-muted hover:bg-surface hover:text-fg',
              'opacity-0 vy-transition',
              '[@media(hover:none)]:opacity-100',
              'group-hover/prompt:opacity-100 group-focus-within/prompt:opacity-100',
              'focus-visible:opacity-100 focus-visible:vy-focus-ring'
            )}
            aria-label="Revert to before this prompt"
            data-no-prompt-edit
            onClick={(e) => {
              e.stopPropagation()
              onRevert?.()
            }}
          >
            <Icon name="revert" size={14} />
          </button>
        </Tooltip>
      ) : null}

      {hasBody ? (
        <div
          ref={bodyRef}
          className={cn(
            'relative overflow-hidden',
            editable && (revertable ? 'pr-14' : 'pr-8'),
            revertable && !editable && 'pr-8',
            clamped && 'mask-fade-bottom'
          )}
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

      {item.images?.length || item.attachments?.length ? (
        <div
          className={cn('flex flex-wrap items-center gap-1.5', hasBody ? 'mt-2' : null)}
          data-no-prompt-edit
        >
          {item.images?.map((url, imageIndex) => (
            <ImageChip
              key={`${item.id}-${imageIndex}`}
              url={url}
              label={`Image ${imageIndex + 1}`}
              onClick={() => onImageClick(url, `Image ${imageIndex + 1}`)}
            />
          ))}
          {item.attachments?.map((file, fileIndex) => {
            const parsed = openWorkspaceFile
              ? parseOpenableAttachmentPath(file.name)
              : null
            return (
              <FileChip
                key={`${item.id}-file-${fileIndex}`}
                name={file.name}
                chars={file.chars}
                onOpen={
                  parsed && openWorkspaceFile
                    ? () =>
                        openWorkspaceFile(
                          parsed.path,
                          parsed.line ? { line: parsed.line } : undefined
                        )
                    : undefined
                }
              />
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
