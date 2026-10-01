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
import { clampComposerDropdownPanel } from './composerDropdownLayout'
import type { MentionMenuItem, MentionMenuView } from './mentionModel'
import { buildMentionRootSections } from './mentionPresentation'

/**
 * Width bounds. The anchor is the composer's input wrap, so the panel tracks
 * the composer's own width between these and stops there, so a full-width pane
 * does not stretch the rows. Viewport clamping is the layout helper's job.
 */
const MENTION_PANEL_MIN_PX = 260
const MENTION_PANEL_MAX_PX = 420

/** One of the four non-results states the panel can be in. */
type MentionPanelState = 'results' | 'loading' | 'error' | 'empty'

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
    case 'folder':
      return 'folder'
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

function emptyHint(view: MentionMenuView): string {
  if (view === 'root') return 'Keep typing to filter, or open a list to browse it.'
  return 'Keep typing to filter this list.'
}

/** The row's full path, for the footer: where the mention points. */
function footerSubject(item: MentionMenuItem): { text: string; mono: boolean } | null {
  switch (item.kind) {
    case 'file':
    case 'folder':
    case 'docs':
    case 'rule':
      return { text: item.path, mono: true }
    case 'branch':
    case 'browser':
    case 'lints':
    case 'chat':
      return { text: item.subtitle, mono: false }
    case 'nav':
      return { text: item.label, mono: false }
    case 'show-more':
      return { text: `${item.remaining} more waiting`, mono: false }
    default: {
      const _exhaustive: never = item
      return _exhaustive
    }
  }
}

/** What accepting the row under the pointer or keyboard does. */
function acceptHint(item: MentionMenuItem): string {
  if (item.kind === 'nav') return 'Enter to open'
  if (item.kind === 'show-more') return 'Enter to load more'
  return 'Enter to attach'
}

/** Accessible name: the row's own text runs the label into its detail. */
function rowName(item: MentionMenuItem): string {
  const detail = 'subtitle' in item ? item.subtitle : undefined
  return detail ? `${item.label} · ${detail}` : item.label
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
  const path =
    item.kind === 'file' || item.kind === 'folder' || item.kind === 'docs'
      ? item.path
      : null
  // A folder row is a target, not a list: it draws the folder icon and picks
  // straight into the draft, same as a file row.
  const kind = item.kind === 'folder' ? 'folder' : 'file'
  return (
    <button
      type="button"
      id={optionId}
      role="option"
      aria-selected={selected}
      aria-label={rowName(item)}
      ref={optionRef}
      className={cn(MENU_ROW, selected ? MENU_ROW_ACTIVE : MENU_ROW_IDLE, MENU_ROW_TEXT)}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onActive}
      onClick={onPick}
    >
      <MenuItemBody
        {...(path
          ? {
              lead: (
                <FileTypeIcon path={path} kind={kind} size={14} />
              )
            }
          : { icon: itemIcon(item) })}
        label={item.label}
        // Narrow panel: the label is the row's name, and the parent directory
        // is the first thing to give way. Measured against the panel's own
        // width, not the viewport's.
        detail={
          'subtitle' in item ? (
            <span className="@max-[300px]:hidden">{item.subtitle}</span>
          ) : undefined
        }
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
 * The @ menu: what can be attached to the instruction (Context), the recent or
 * matching files, and the lists to browse into, under quiet group labels and a
 * quiet header. A list opens in place with a way back. The row under the
 * pointer or keyboard has its full path pinned in the footer, so the list never
 * has to give up width to a side panel. Loading, a failed workspace search and
 * no match each get their own glyph, so none of them reads as an empty list.
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
  error,
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
  /** The workspace search failed. Distinct from "nothing matched". */
  error?: string | null
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

  // Responsive: the anchor is the composer's input wrap, so the menu tracks the
  // composer's own width between these bounds instead of one fixed size.
  // `position.minWidth` is the measured anchor width (floored), and it is
  // already re-measured on resize and scroll — no second layout read here.
  const { left, width, maxHeight } = clampComposerDropdownPanel({
    position,
    maxWidthPx: Math.min(
      MENTION_PANEL_MAX_PX,
      Math.max(MENTION_PANEL_MIN_PX, Math.round(position.minWidth))
    ),
    minHeightPx: 180
  })

  const state: MentionPanelState =
    items.length > 0
      ? 'results'
      : error
        ? 'error'
        : loading
          ? 'loading'
          : 'empty'

  const active = items[activeIndex] ?? null
  const subject = active ? footerSubject(active) : null
  const activeDescendant =
    activeIndex >= 0 && items[activeIndex]
      ? `${listId}-opt-${items[activeIndex]!.id}`
      : undefined
  const title = view === 'root' ? 'Mentions' : VIEW_TITLE[view]

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
      aria-busy={state === 'loading' ? true : undefined}
      tabIndex={0}
      data-mention-state={state}
      className={cn(MENU_SURFACE, '@container fixed flex origin-bottom flex-col text-sm')}
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
      {/* Quiet header: what this list is, and how much of it there is. */}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        {view !== 'root' && onBack ? (
          <IconButton
            icon="chevronLeft"
            label="Back"
            size="xs"
            tone="muted"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onBack()}
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-fg">
          {title}
        </span>
        {state === 'results' ? (
          <span className="shrink-0 text-caption text-tertiary tnum">
            {items.length === 1 ? '1 row' : `${items.length} rows`}
          </span>
        ) : null}
        {loading && items.length > 0 ? (
          <Icon
            name="loader"
            size={13}
            className="shrink-0 motion-safe:animate-spin text-muted"
          />
        ) : null}
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1">
        {state === 'loading' ? (
          <div
            className="flex items-center gap-2 px-2 py-2 text-xs text-muted"
            role="status"
          >
            <Icon name="loader" size={13} className="motion-safe:animate-spin" />
            <span>{view === 'root' ? 'Searching the workspace…' : 'Loading…'}</span>
          </div>
        ) : null}

        {state === 'error' ? (
          <div
            className="flex items-start gap-2 px-2 py-2 text-xs text-danger"
            role="alert"
          >
            <Icon name="warningCircle" size={13} className="mt-px" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{error}</span>
          </div>
        ) : null}

        {state === 'empty' ? (
          <div className="px-2 py-2">
            <p className="m-0 flex items-center gap-2 text-xs text-fg">
              <Icon name="search" size={13} className="text-muted" />
              <span>{emptyCopy(view)}</span>
            </p>
            <p className="m-0 pl-[21px] pt-1 text-caption text-tertiary">
              {emptyHint(view)}
            </p>
          </div>
        ) : null}

        {rootSections?.map((section, sectionIndex) => {
          const labelId = `${listId}-group-${sectionIndex}`
          return (
            <div key={section.id} role="group" aria-labelledby={labelId}>
              <div id={labelId} className={MENU_LABEL}>
                {section.label}
              </div>
              {section.entries.map(({ item, flatIndex }) => row(item, flatIndex))}
            </div>
          )
        })}

        {rootSections
          ? null
          : items.map((item, index) => row(item, index))}
      </div>

      {/* Pinned outside the scroll region: the footer never covers a row. */}
      <div className="shrink-0 border-t border-border p-1" data-mention-footer>
        {active && subject ? (
          <p
            className="m-0 flex items-center gap-1.5 px-2 py-1.5 text-xs"
            title={subject.text}
          >
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                subject.mono ? 'font-mono text-muted' : 'text-muted'
              )}
            >
              {subject.text}
            </span>
            <span className="shrink-0 text-tertiary">{acceptHint(active)}</span>
          </p>
        ) : (
          <p className="m-0 px-2 py-1.5 text-xs text-tertiary">
            {state === 'results' || state === 'loading'
              ? 'Nothing selected'
              : 'Nothing to select'}
          </p>
        )}
      </div>
    </div>,
    document.body
  )
}
