import { useMemo, useState, type RefObject } from 'react'
import type { SlashCommandDescriptor } from '@shared/ipc'
import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { Icon, type IconName } from '@renderer/lib/icons'
import { MENU_LABEL, MENU_ROW, MENU_ROW_ACTIVE, MENU_ROW_IDLE, MENU_ROW_TEXT, MenuItemBody, cn } from '@renderer/lib/ui'
import type { MentionMenuItem } from '../../../../renderer/src/features/chat/components/composer/mentionModel'
import { buildMentionRootSections } from '../../../../renderer/src/features/chat/components/composer/mentionPresentation'
import {
  buildSlashMenuBlocks,
  slashAcceptHint,
  slashFooterText,
  slashRowDetail,
  slashRowIcon,
  slashRowLabel
} from '../../../../renderer/src/features/chat/components/composer/slashCommandPresentation'
import { MENTION_ITEMS, SLASH_COMMANDS } from './data'
import { Popover, useGlass } from './store'

/*
  MentionMenu and SlashCommandMenu, replicated. Both anchor to the input wrap
  and track its width between 260 and 420px; a 40px header with the count,
  grouped rows, and a footer pinned outside the scroll that says what the row
  under the pointer is and what accepting it does.
*/

const MIN = 260
const MAX = 420

function mentionIcon(item: MentionMenuItem): IconName {
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

export function MentionMenu({ anchor }: { anchor: RefObject<HTMLElement | null> }) {
  const { pop } = useGlass()
  const items = MENTION_ITEMS
  const [active, setActive] = useState(0)
  const sections = useMemo(() => buildMentionRootSections(items, ''), [items])
  const current = items[active] ?? null
  const subject = current ? footerSubject(current) : null
  return (
    <Popover anchor={anchor} open={pop === 'mention'} align="start" minWidth={MIN} maxWidth={MAX} label="Mentions" role="listbox" className="@container text-sm">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium text-fg">Mentions</span>
        <span className="shrink-0 text-caption text-tertiary tnum">{`${items.length} rows`}</span>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1">
        {sections.map((section) => (
          <div key={section.id} role="group" aria-label={section.label}>
            <div className={MENU_LABEL}>{section.label}</div>
            {section.entries.map(({ item, flatIndex }) => {
              const path = item.kind === 'file' || item.kind === 'folder' || item.kind === 'docs' ? item.path : null
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={flatIndex === active}
                  className={cn(MENU_ROW, flatIndex === active ? MENU_ROW_ACTIVE : MENU_ROW_IDLE, MENU_ROW_TEXT)}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(flatIndex)}
                >
                  <MenuItemBody
                    {...(path
                      ? { lead: <FileTypeIcon path={path} kind={item.kind === 'folder' ? 'folder' : 'file'} size={14} /> }
                      : { icon: mentionIcon(item) })}
                    label={item.label}
                    detail={'subtitle' in item ? <span className="@max-[300px]:hidden">{item.subtitle}</span> : undefined}
                    trailing={item.kind === 'nav' ? <Icon name="chevronRight" size={12} className="shrink-0 text-tertiary" /> : undefined}
                  />
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t border-border p-1" data-mention-footer>
        {current && subject ? (
          <p className="m-0 flex items-center gap-1.5 px-2 py-1.5 text-xs" title={subject.text}>
            <span className={cn('min-w-0 flex-1 truncate', subject.mono ? 'font-mono text-muted' : 'text-muted')}>{subject.text}</span>
            <span className="shrink-0 text-tertiary">{acceptHint(current)}</span>
          </p>
        ) : (
          <p className="m-0 px-2 py-1.5 text-xs text-tertiary">Nothing selected</p>
        )}
      </div>
    </Popover>
  )
}

export function SlashMenu({ anchor }: { anchor: RefObject<HTMLElement | null> }) {
  const { pop } = useGlass()
  const commands: SlashCommandDescriptor[] = SLASH_COMMANDS
  const servers = useMemo(() => new Map(), [])
  const blocks = useMemo(() => buildSlashMenuBlocks(commands, servers), [commands, servers])
  const [active, setActive] = useState(0)
  const described = commands[active] ?? null
  const describedText = described ? slashFooterText(described) : null
  return (
    <Popover anchor={anchor} open={pop === 'slash'} align="start" minWidth={MIN} maxWidth={MAX} label="Slash commands" className="@container text-sm">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">Slash commands</span>
        <span className="shrink-0 text-caption text-tertiary tnum">{`${commands.length} commands`}</span>
      </div>
      <div role="listbox" aria-label="Slash commands" className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1">
        {blocks.map((block) => (
          <div key={`${block.key}:${block.startIndex}`} role="group" aria-label={block.label}>
            <div className={MENU_LABEL}>{block.label}</div>
            {block.items.map((cmd, offset) => {
              const index = block.startIndex + offset
              return (
                <button
                  key={cmd.id}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={cn(MENU_ROW, index === active ? MENU_ROW_ACTIVE : MENU_ROW_IDLE, MENU_ROW_TEXT)}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(e) => e.preventDefault()}
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
          <p className="m-0 px-2 py-1.5 text-xs text-tertiary">Nothing selected</p>
        )}
      </div>
    </Popover>
  )
}
