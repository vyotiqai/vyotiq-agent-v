import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { Icon, type IconName } from '@renderer/lib/icons'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { cn } from '@renderer/lib/ui/cn'
import { FileTypeBadge } from './FileTypeBadge'
import {
  COMPOSER_DROPDOWN_PAD_PX,
  COMPOSER_DROPDOWN_TREE_MIN_PX,
  clampComposerDropdownPanel,
  composerDropdownRow,
  composerDropdownSectionHeader
} from './composerDropdownLayout'
import {
  pathSegments,
  type MentionMenuItem,
  type MentionMenuView
} from './mentionModel'
import { buildMentionRootSections } from './mentionPresentation'

const MENTION_MAX_PX = 340
const MENTION_TREE_MAX_PX = 480

const stickySectionHeader = cn(
  composerDropdownSectionHeader,
  'sticky top-0 z-sticky bg-card'
)

function itemIcon(item: MentionMenuItem): IconName {
  switch (item.kind) {
    case 'branch':
      return 'branch'
    case 'browser':
      return 'globe'
    case 'lints':
      return 'warning'
    case 'nav':
      if (item.view === 'files') return 'folder'
      if (item.view === 'docs') return 'doc'
      if (item.view === 'rules') return 'listTodo'
      return 'doc'
    case 'file':
    case 'docs':
      return 'file'
    case 'rule':
      return 'listTodo'
    case 'chat':
      return 'doc'
    case 'show-more':
      return 'chevron'
    default: {
      const _exhaustive: never = item
      return _exhaustive
    }
  }
}

function PathTree({ path }: { path: string }) {
  const parts = pathSegments(path)
  if (!parts.length) return null
  return (
    <div className="sidebar-scroll flex min-h-0 min-w-[140px] max-w-[180px] shrink-0 flex-col gap-0.5 overflow-y-auto border-l border-border/40 px-2 py-1.5">
      {parts.map((part, i) => {
        const isLast = i === parts.length - 1
        return (
          <div
            key={`${i}:${part}`}
            className="flex items-center gap-1.5 text-caption text-secondary"
            style={{ paddingLeft: i * 8 }}
          >
            {isLast ? (
              <FileTypeBadge path={path} />
            ) : (
              <FileTypeIcon path={part} kind="folder" size={14} />
            )}
            <span
              className={cn('truncate', isLast && 'font-medium text-fg')}
              title={part}
            >
              {part}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function emptyCopy(view: MentionMenuView): string {
  switch (view) {
    case 'files':
      return 'No files match'
    case 'chats':
      return 'No past chats match'
    case 'docs':
      return 'No docs match'
    case 'rules':
      return 'No rules match'
    default:
      return 'No matches'
  }
}

function MentionRow({
  item,
  selected,
  optionId,
  onActive,
  onPick,
  optionRef
}: {
  item: MentionMenuItem
  selected: boolean
  optionId: string
  onActive: () => void
  onPick: () => void
  optionRef: (el: HTMLElement | null) => void
}) {
  return (
    <button
      type="button"
      id={optionId}
      role="option"
      aria-selected={selected}
      ref={optionRef}
      className={cn(composerDropdownRow, selected && 'bg-surface-2 text-fg')}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onActive}
      onClick={onPick}
    >
      {item.kind === 'file' || item.kind === 'docs' ? (
        <FileTypeBadge path={item.path} size="md" />
      ) : (
        <Icon name={itemIcon(item)} size={16} className="shrink-0 text-muted" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium leading-snug" title={item.label}>
          {item.label}
        </span>
        {'subtitle' in item && item.subtitle ? (
          <span className="block truncate text-caption text-secondary" title={item.subtitle}>
            {item.subtitle}
          </span>
        ) : null}
      </span>
      {item.kind === 'nav' || item.kind === 'show-more' ? (
        <Icon name="chevronRight" size={14} className="shrink-0 text-muted" />
      ) : null}
    </button>
  )
}

export function MentionMenu({
  open,
  view,
  items,
  activeIndex,
  onActiveIndexChange,
  onPick,
  onDismiss,
  onBack,
  anchorRef,
  loading,
  listId = 'composer-mention-menu'
}: {
  open: boolean
  view: MentionMenuView
  items: MentionMenuItem[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onPick: (item: MentionMenuItem) => void
  onDismiss?: () => void
  onBack?: () => boolean
  anchorRef: RefObject<HTMLElement | null>
  loading?: boolean
  listId?: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLElement | null>>([])

  const { position } = useDropdownMenu({
    open,
    onOpenChange: (next) => {
      if (!next) {
        if (view !== 'root' && onBack?.()) return
        onDismiss?.()
      }
    },
    triggerRef: anchorRef,
    panelRef,
    placement: 'up',
    align: 'start',
    disabled: !open,
    trapFocus: true
  })

  const rootSections = useMemo(
    () => (view === 'root' ? buildMentionRootSections(items) : null),
    [view, items]
  )

  useEffect(() => {
    if (!open || activeIndex < 0) return
    optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  if (!open || !position) return null

  const active = items[activeIndex] ?? null
  const activePath =
    active?.kind === 'file' || active?.kind === 'docs' || active?.kind === 'rule'
      ? active.path
      : null
  const treeDesired =
    (view === 'files' || view === 'docs' || view === 'rules') && Boolean(activePath)
  const title =
    view === 'files'
      ? 'Files & Folders'
      : view === 'chats'
        ? 'Past Chats'
        : view === 'docs'
          ? 'Docs'
          : view === 'rules'
            ? 'Rules'
            : null

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024
  const { left, width, maxHeight } = clampComposerDropdownPanel({
    position,
    maxWidthPx:
      treeDesired && vw >= COMPOSER_DROPDOWN_TREE_MIN_PX + COMPOSER_DROPDOWN_PAD_PX * 2
        ? MENTION_TREE_MAX_PX
        : MENTION_MAX_PX
  })
  const showTree = treeDesired && width >= COMPOSER_DROPDOWN_TREE_MIN_PX

  const activeDescendant =
    activeIndex >= 0 && items[activeIndex]
      ? `${listId}-opt-${items[activeIndex]!.id}`
      : undefined

  return createPortal(
    <div
      ref={panelRef}
      id={listId}
      role="listbox"
      aria-label="Mentions"
      aria-activedescendant={activeDescendant}
      tabIndex={0}
      className="fixed z-dropdown flex overflow-hidden rounded-xl border border-border bg-card shadow-menu animate-menu-in origin-bottom"
      style={{
        top: position.placement === 'up' ? undefined : position.top,
        bottom:
          position.placement === 'up' ? window.innerHeight - position.top : undefined,
        left,
        width,
        maxWidth: width,
        maxHeight
      }}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {title ? (
          <div className="flex shrink-0 items-center gap-1 border-b border-border/40 px-2 py-1.5">
            {onBack ? (
              <button
                type="button"
                className="rounded p-0.5 text-secondary hover:bg-surface hover:text-fg"
                aria-label="Back"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onBack()}
              >
                <Icon name="chevron" size={14} className="rotate-90" />
              </button>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">{title}</span>
            {loading && items.length > 0 ? (
              <span className="shrink-0 text-2xs text-secondary">Searching…</span>
            ) : null}
          </div>
        ) : loading && items.length > 0 ? (
          <div className="shrink-0 border-b border-border/40 px-2.5 py-1 text-2xs text-secondary">
            Searching…
          </div>
        ) : null}

        <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-1">
          {loading && items.length === 0 ? (
            <p className="m-0 px-2.5 py-2 text-xs text-secondary">Searching…</p>
          ) : items.length === 0 ? (
            <p className="m-0 px-2.5 py-2 text-xs text-secondary">{emptyCopy(view)}</p>
          ) : rootSections ? (
            rootSections.map((section) => (
              <div key={section.id} role="group" aria-label={section.label}>
                <p className={stickySectionHeader}>{section.label}</p>
                <ul className="m-0 list-none p-0">
                  {section.entries.map(({ item, flatIndex }) => (
                    <li key={item.id} className="m-0">
                      <MentionRow
                        item={item}
                        selected={flatIndex === activeIndex}
                        optionId={`${listId}-opt-${item.id}`}
                        onActive={() => onActiveIndexChange(flatIndex)}
                        onPick={() => onPick(item)}
                        optionRef={(el) => {
                          optionRefs.current[flatIndex] = el
                        }}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <ul className="m-0 list-none p-0">
              {items.map((item, index) => (
                <li key={item.id} className="m-0">
                  <MentionRow
                    item={item}
                    selected={index === activeIndex}
                    optionId={`${listId}-opt-${item.id}`}
                    onActive={() => onActiveIndexChange(index)}
                    onPick={() => onPick(item)}
                    optionRef={(el) => {
                      optionRefs.current[index] = el
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {showTree && activePath ? <PathTree path={activePath} /> : null}
    </div>,
    document.body
  )
}
