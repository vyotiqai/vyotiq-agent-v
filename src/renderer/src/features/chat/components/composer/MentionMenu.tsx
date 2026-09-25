import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { Icon, type IconName } from '@renderer/lib/icons'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import {
  cn,
  IconButton,
  MENU_LABEL,
  MENU_ROW,
  MENU_ROW_ACTIVE,
  MENU_ROW_IDLE,
  MENU_ROW_TEXT,
  MENU_SURFACE,
  MenuItemBody
} from '@renderer/lib/ui'
import { FileTypeBadge } from './FileTypeBadge'
import {
  COMPOSER_DROPDOWN_PAD_PX,
  COMPOSER_DROPDOWN_TREE_MIN_PX,
  clampComposerDropdownPanel
} from './composerDropdownLayout'
import {
  pathSegments,
  type MentionMenuItem,
  type MentionMenuView
} from './mentionModel'
import { buildMentionRootSections } from './mentionPresentation'

const MENTION_MAX_PX = 420
/** The list and the path tree beside it. */
const MENTION_TREE_MAX_PX = 600

function itemIcon(item: MentionMenuItem): IconName {
  switch (item.kind) {
    case 'branch':
      return 'branch'
    case 'browser':
      return 'browser'
    case 'lints':
      return item.diagnosticsKind === 'lint' ? 'warning' : 'warningCircle'
    case 'nav':
      if (item.view === 'files') return 'folder'
      if (item.view === 'docs') return 'book'
      if (item.view === 'rules') return 'rules'
      return 'tasks'
    case 'file':
    case 'docs':
      return 'file'
    case 'rule':
      return 'rules'
    case 'chat':
      return 'tasks'
    case 'show-more':
      return 'chevron'
    default: {
      const _exhaustive: never = item
      return _exhaustive
    }
  }
}

const VIEW_TITLE: Record<Exclude<MentionMenuView, 'root'>, string> = {
  files: 'Files and folders',
  chats: 'Past tasks',
  docs: 'Docs',
  rules: 'Rules'
}

function PathTree({ path }: { path: string }) {
  const parts = pathSegments(path)
  if (!parts.length) return null
  return (
    <div className="scroll-thin flex min-h-0 min-w-[140px] max-w-[180px] shrink-0 flex-col gap-0.5 overflow-y-auto border-l border-border px-2 py-1.5">
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
            <span className={cn('truncate', isLast && 'font-medium text-fg')} title={part}>
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
      return 'No past tasks match'
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
  const path = item.kind === 'file' || item.kind === 'docs' ? item.path : null
  return (
    <button
      type="button"
      id={optionId}
      role="option"
      aria-selected={selected}
      ref={optionRef}
      title={path ?? undefined}
      className={cn(MENU_ROW, selected ? MENU_ROW_ACTIVE : MENU_ROW_IDLE, MENU_ROW_TEXT)}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onActive}
      onClick={onPick}
    >
      <MenuItemBody
        {...(path ? { lead: <FileTypeIcon path={path} size={14} /> } : { icon: itemIcon(item) })}
        label={item.label}
        detail={'subtitle' in item ? item.subtitle : undefined}
        trailing={
          item.kind === 'nav' ? (
            <Icon name="chevronRight" size={12} className="shrink-0 text-tertiary" />
          ) : undefined
        }
      />
    </button>
  )
}

/**
 * The @ menu: what can be attached to the instruction (Context), recent or
 * matching files, and lists to browse into. A list opens in place with a way
 * back; files, docs and rules show where the row lives beside the list.
 */
export function MentionMenu({
  open,
  view,
  items,
  query = '',
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
  /** What follows the @ — the root names its file rows by it. */
  query?: string
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
    () => (view === 'root' ? buildMentionRootSections(items, query) : null),
    [view, items, query]
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
  const title = view === 'root' ? null : VIEW_TITLE[view]

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

  const row = (item: MentionMenuItem, index: number) => (
    <MentionRow
      key={item.id}
      item={item}
      selected={index === activeIndex}
      optionId={`${listId}-opt-${item.id}`}
      onActive={() => onActiveIndexChange(index)}
      onPick={() => onPick(item)}
      optionRef={(el) => {
        optionRefs.current[index] = el
      }}
    />
  )

  return createPortal(
    <div
      ref={panelRef}
      id={listId}
      role="listbox"
      aria-label="Mentions"
      aria-activedescendant={activeDescendant}
      tabIndex={0}
      className={cn(MENU_SURFACE, 'fixed flex origin-bottom text-sm')}
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
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
            {onBack ? (
              <IconButton
                icon="chevronLeft"
                label="Back"
                size="sm"
                tone="muted"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onBack()}
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-fg">{title}</span>
            {loading && items.length > 0 ? (
              <span className="shrink-0 px-1 text-xs text-tertiary">Searching…</span>
            ) : null}
          </div>
        ) : null}

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1">
          {loading && items.length === 0 ? (
            <p className="m-0 px-2 py-1.5 text-xs text-muted">Searching…</p>
          ) : items.length === 0 ? (
            <p className="m-0 px-2 py-1.5 text-xs text-muted">{emptyCopy(view)}</p>
          ) : rootSections ? (
            rootSections.map((section) => (
              <div key={section.id} role="group" aria-label={section.label}>
                <div className={MENU_LABEL} aria-hidden="true">
                  <span>{section.label}</span>
                  {section.id === 'files' && loading ? (
                    <span className="font-normal normal-case tracking-normal">Searching…</span>
                  ) : null}
                </div>
                {section.entries.map(({ item, flatIndex }) => row(item, flatIndex))}
              </div>
            ))
          ) : (
            items.map((item, index) => row(item, index))
          )}
        </div>
      </div>
      {showTree && activePath ? <PathTree path={activePath} /> : null}
    </div>,
    document.body
  )
}
