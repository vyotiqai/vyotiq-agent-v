import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import type { SlashCommandDescriptor } from '@shared/ipc'
import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { Icon, type IconName } from '@renderer/lib/icons'
import { IconButton, MENU_LABEL, MENU_ROW, MENU_ROW_ACTIVE, MENU_ROW_IDLE, MENU_ROW_TEXT, MenuItemBody, cn } from '@renderer/lib/ui'
import type { MentionMenuItem, MentionMenuView } from '../../../../renderer/src/features/chat/components/composer/mentionModel'
import { buildMentionRootSections, type MentionMenuSection } from '../../../../renderer/src/features/chat/components/composer/mentionPresentation'
import {
  buildSlashMenuBlocks,
  slashAcceptHint,
  slashFooterText,
  slashRowDetail,
  slashRowIcon,
  slashRowLabel
} from '../../../../renderer/src/features/chat/components/composer/slashCommandPresentation'
import { mentionItems, slashCommands } from './data'
import { Popover, useGlass } from './store'

/*
  MentionMenu and SlashCommandMenu, replicated. Both anchor to the input wrap
  and track its width between 260 and 420px; a 40px header with the count,
  grouped rows, and a footer pinned outside the scroll that says what the row
  under the pointer is and what accepting it does.

  Both follow the words: the rows are filtered by what is typed after the @
  or /, the arrows (in the field) move the highlight, Enter or Tab or a click
  takes the row. A Browse row in the @ menu opens its list in place, with a
  way back (the chevron, or Esc).
*/

const MIN = 260
const MAX = 420

export function mentionIcon(item: MentionMenuItem): IconName {
  switch (item.kind) {
    case 'branch':
      return 'branch'
    case 'browser':
      return 'browser'
    case 'lints':
      return item.diagnosticsKind === 'lint' ? 'warning' : 'warningCircle'
    case 'changes':
      return 'diff'
    case 'terminal':
      return 'terminal'
    case 'url':
      return 'globe'
    case 'issue':
      return 'pullRequest'
    case 'symbol':
      return 'code'
    case 'commit':
      return 'gitCommit'
    case 'nav':
      if (item.view === 'files') return 'folder'
      if (item.view === 'docs') return 'book'
      if (item.view === 'rules') return 'rules'
      if (item.view === 'commits') return 'gitCommit'
      return 'tasks'
    case 'folder':
      return 'folder'
    case 'rule':
      return 'rules'
    case 'chat':
      return 'tasks'
    case 'show-more':
      return 'chevron'
    default:
      return 'file'
  }
}

function footerSubject(item: MentionMenuItem): { text: string; mono: boolean } {
  switch (item.kind) {
    case 'file':
    case 'folder':
    case 'docs':
    case 'rule':
      return { text: item.path, mono: true }
    case 'url':
      return { text: item.url, mono: true }
    case 'nav':
      return { text: item.label, mono: false }
    case 'show-more':
      return { text: `${item.remaining} more waiting`, mono: false }
    default:
      return { text: item.subtitle, mono: false }
  }
}

function acceptHint(item: MentionMenuItem): string {
  if (item.kind === 'nav') return 'Enter to open'
  if (item.kind === 'show-more') return 'Enter to load more'
  return 'Enter to attach'
}

const VIEW_TITLE: Record<Exclude<MentionMenuView, 'root'>, string> = {
  files: 'Files and folders',
  chats: 'Past tasks',
  docs: 'Docs',
  rules: 'Rules',
  commits: 'Commits'
}

const EMPTY_COPY: Record<MentionMenuView, string> = {
  root: 'No matches',
  files: 'No files match',
  chats: 'No past tasks match',
  docs: 'No docs match',
  rules: 'No rules match',
  commits: 'No commits match'
}

export type MentionRows = {
  view: MentionMenuView
  items: MentionMenuItem[]
  /** The root list's groups; null in a list it browsed into. */
  sections: MentionMenuSection[] | null
  /** Item indices in the order they show: the arrows walk this, not the builder's order. */
  order: number[]
}

/** The @ menu's rows for what is typed after the @. */
export function useMentionRows(query: string): MentionRows {
  const { mentionView: view, mentionMore: more } = useGlass()
  return useMemo(() => {
    const items = mentionItems(view, query, more)
    if (view !== 'root') return { view, items, sections: null, order: items.map((_, i) => i) }
    const sections = buildMentionRootSections(items, query)
    return { view, items, sections, order: sections.flatMap((s) => s.entries.map((e) => e.flatIndex)) }
  }, [view, query, more])
}

/** The / menu's rows for what is typed after the /. */
export function useSlashRows(query: string): { commands: SlashCommandDescriptor[] } {
  return useMemo(() => ({ commands: slashCommands(query) }), [query])
}

/** Keep the highlighted row in sight as the arrows move it. */
function useScrollActive(open: boolean, active: number): (i: number) => (el: HTMLElement | null) => void {
  const rows = useRef<(HTMLElement | null)[]>([])
  useEffect(() => {
    if (open) rows.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [open, active])
  return useCallback((i: number) => (el: HTMLElement | null) => void (rows.current[i] = el), [])
}

function Empty({ text, hint }: { text: string; hint: string }) {
  return (
    <div className="px-2 py-2">
      <p className="m-0 flex items-center gap-2 text-xs text-fg">
        <Icon name="search" size={13} className="text-muted" />
        <span>{text}</span>
      </p>
      <p className="m-0 pl-[21px] pt-1 text-caption text-tertiary">{hint}</p>
    </div>
  )
}

export function MentionMenu({ anchor, onPick }: { anchor: RefObject<HTMLElement | null>; onPick: (item: MentionMenuItem) => void }) {
  const { pop, trigger, menuActive, setMenuActive, setMentionView } = useGlass()
  const open = pop === 'mention'
  const { view, items, sections, order } = useMentionRows(trigger?.kind === 'mention' ? trigger.query : '')
  const current = items[order[menuActive] ?? -1] ?? null
  const subject = current ? footerSubject(current) : null
  const rowRef = useScrollActive(open, menuActive)
  // Esc in a list it browsed into goes back to the root; at the root it closes the menu.
  const back = useCallback((): boolean => {
    if (view === 'root') return false
    setMentionView('root')
    return true
  }, [view, setMentionView])
  const row = (item: MentionMenuItem) => {
    const at = order.indexOf(items.indexOf(item))
    const path = item.kind === 'file' || item.kind === 'folder' || item.kind === 'docs' ? item.path : null
    return (
      <button
        key={item.id}
        ref={rowRef(at)}
        type="button"
        role="option"
        aria-selected={at === menuActive}
        tabIndex={-1}
        className={cn(MENU_ROW, at === menuActive ? MENU_ROW_ACTIVE : MENU_ROW_IDLE, MENU_ROW_TEXT)}
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() => setMenuActive(at)}
        onClick={() => onPick(item)}
      >
        <MenuItemBody
          {...(path
            ? { lead: <FileTypeIcon path={path} kind={item.kind === 'folder' ? 'folder' : 'file'} size={14} /> }
            : { icon: mentionIcon(item) })}
          label={item.label}
          detail={'subtitle' in item && item.subtitle ? <span className="@max-[300px]:hidden">{item.subtitle}</span> : undefined}
          trailing={item.kind === 'nav' ? <Icon name="chevronRight" size={12} className="shrink-0 text-tertiary" /> : undefined}
        />
      </button>
    )
  }
  return (
    <Popover
      anchor={anchor}
      open={open}
      align="start"
      minWidth={MIN}
      maxWidth={MAX}
      label="Mentions"
      role="listbox"
      className="@container text-sm"
      onEscape={back}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        {view !== 'root' ? (
          <IconButton icon="chevronLeft" label="Back" size="xs" tone="muted" onMouseDown={(e) => e.preventDefault()} onClick={back} />
        ) : null}
        <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-fg">{view === 'root' ? 'Mentions' : VIEW_TITLE[view]}</span>
        {items.length ? <span className="shrink-0 text-caption text-tertiary tnum">{items.length === 1 ? '1 row' : `${items.length} rows`}</span> : null}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1">
        {!items.length ? (
          <Empty
            text={EMPTY_COPY[view]}
            hint={view === 'root' ? 'Keep typing to filter, or open a list to browse it.' : 'Keep typing to filter this list.'}
          />
        ) : sections ? (
          sections.map((section) => (
            <div key={section.id} role="group" aria-label={section.label}>
              <div className={MENU_LABEL}>{section.label}</div>
              {section.entries.map(({ item }) => row(item))}
            </div>
          ))
        ) : (
          items.map(row)
        )}
      </div>
      <div className="shrink-0 border-t border-border p-1" data-mention-footer>
        {current && subject ? (
          <p className="m-0 flex items-center gap-1.5 px-2 py-1.5 text-xs" title={subject.text}>
            <span className={cn('min-w-0 flex-1 truncate', subject.mono ? 'font-mono text-muted' : 'text-muted')}>{subject.text}</span>
            <span className="shrink-0 text-tertiary">{acceptHint(current)}</span>
          </p>
        ) : (
          <p className="m-0 px-2 py-1.5 text-xs text-tertiary">{items.length ? 'Nothing selected' : 'Nothing to select'}</p>
        )}
      </div>
    </Popover>
  )
}

export function SlashMenu({ anchor, onPick }: { anchor: RefObject<HTMLElement | null>; onPick: (cmd: SlashCommandDescriptor) => void }) {
  const { pop, trigger, menuActive, setMenuActive } = useGlass()
  const open = pop === 'slash'
  const { commands } = useSlashRows(trigger?.kind === 'slash' ? trigger.query : '')
  const servers = useMemo(() => new Map(), [])
  const blocks = useMemo(() => buildSlashMenuBlocks(commands, servers), [commands, servers])
  const rowRef = useScrollActive(open, menuActive)
  const described = commands[menuActive] ?? null
  const describedText = described ? slashFooterText(described) : null
  return (
    <Popover anchor={anchor} open={open} align="start" minWidth={MIN} maxWidth={MAX} label="Slash commands" className="@container text-sm">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">Slash commands</span>
        {commands.length ? (
          <span className="shrink-0 text-caption text-tertiary tnum">{commands.length === 1 ? '1 command' : `${commands.length} commands`}</span>
        ) : null}
      </div>
      <div role="listbox" aria-label="Slash commands" className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1">
        {!commands.length ? <Empty text="No matches" hint="Keep typing to filter commands." /> : null}
        {blocks.map((block) => (
          <div key={`${block.key}:${block.startIndex}`} role="group" aria-label={block.label}>
            <div className={MENU_LABEL}>{block.label}</div>
            {block.items.map((cmd, offset) => {
              const index = block.startIndex + offset
              return (
                <button
                  key={cmd.id}
                  ref={rowRef(index)}
                  type="button"
                  role="option"
                  aria-selected={index === menuActive}
                  tabIndex={-1}
                  className={cn(MENU_ROW, index === menuActive ? MENU_ROW_ACTIVE : MENU_ROW_IDLE, MENU_ROW_TEXT)}
                  onMouseEnter={() => setMenuActive(index)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(cmd)}
                >
                  <MenuItemBody
                    lead={<Icon name={slashRowIcon(cmd)} size={15} className="shrink-0 text-muted" />}
                    label={slashRowLabel(cmd)}
                    detail={<span className="@max-[300px]:hidden">{slashRowDetail(cmd, servers)}</span>}
                  />
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t border-border p-1" data-slash-footer>
        {described ? (
          <p className="m-0 line-clamp-2 px-2 py-1.5 text-xs text-muted" title={described.description}>
            <span className="font-medium text-fg">{slashRowLabel(described)}</span>
            {describedText ? ` — ${describedText}` : null} <span className="text-tertiary">{slashAcceptHint(described)}</span>
          </p>
        ) : (
          <p className="m-0 px-2 py-1.5 text-xs text-tertiary">{commands.length ? 'Nothing selected' : 'Nothing to select'}</p>
        )}
      </div>
    </Popover>
  )
}
