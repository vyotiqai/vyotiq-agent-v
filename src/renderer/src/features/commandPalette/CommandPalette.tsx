import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '@renderer/lib/icons'
import { FileTypeIcon } from '@renderer/lib/fileIcons'
import {
  Keys,
  MENU_LABEL,
  MENU_ROW,
  MENU_ROW_ACTIVE,
  MENU_ROW_IDLE,
  MENU_ROW_TEXT,
  MENU_SEPARATOR,
  MenuItemBody,
  StatusGlyph,
  cn
} from '@renderer/lib/ui'
import type { NavRow } from '@renderer/app/navigator/navigatorModel'

export type PaletteCommand = {
  id: string
  title: string
  icon?: IconName
  /** The chord, as keycaps. */
  keys?: readonly string[]
  /** Quiet trailing text ("restarts Agent V"). */
  hint?: string
  /** Muted text beside the title ("About" for a settings row). */
  detail?: string
}

export type PaletteFile = { workspacePath: string; path: string }

type Item =
  | { kind: 'task'; key: string; row: NavRow }
  | { kind: 'file'; key: string; file: PaletteFile }
  | { kind: 'command'; key: string; command: PaletteCommand }
  | { kind: 'newTask'; key: string; text: string; where: string }

const TASK_LIMIT = 6
const FILE_LIMIT = 6
const COMMAND_LIMIT = 8

/**
 * Search & commands (Ctrl K). One list, three groups — tasks, files, commands —
 * with the matched text highlighted. `>` narrows to commands. Ctrl ↵ turns
 * the query into a new task in the active workspace.
 */
export function CommandPalette({
  open,
  onClose,
  tasks,
  commands,
  settingsCommands,
  searchFiles,
  newTaskIn,
  onOpenTask,
  onOpenFile,
  onRunCommand,
  onNewTask
}: {
  open: boolean
  onClose: () => void
  /** Every task the navigator knows, in its order (needs you first). */
  tasks: readonly NavRow[]
  commands: readonly PaletteCommand[]
  /** Settings rows matching the query, as commands; listed after the others. */
  settingsCommands?: (needle: string) => PaletteCommand[]
  /** Paths in the active workspace matching a query; absent without a workspace. */
  searchFiles?: (query: string, limit: number) => Promise<PaletteFile[]>
  /** Where Ctrl ↵ starts a task, or null when no workspace is open. */
  newTaskIn: { name: string } | null
  onOpenTask: (row: NavRow, beside: boolean) => void
  onOpenFile: (file: PaletteFile) => void
  onRunCommand: (id: string) => void
  onNewTask: (text: string) => void
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [files, setFiles] = useState<PaletteFile[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    setFiles([])
    // Put focus back where it was, unless what was picked moved it on purpose.
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => {
      window.clearTimeout(t)
      window.setTimeout(() => {
        const current = document.activeElement
        if (previous?.isConnected && (current === null || current === document.body)) previous.focus()
      }, 0)
    }
  }, [open])

  const commandsOnly = query.startsWith('>')
  const needle = (commandsOnly ? query.slice(1) : query).trim()

  // Files come from main; the latest query wins.
  useEffect(() => {
    if (!open || commandsOnly || !needle || !searchFiles) {
      setFiles([])
      return
    }
    let cancelled = false
    const t = window.setTimeout(() => {
      void searchFiles(needle, FILE_LIMIT).then((found) => {
        if (!cancelled) setFiles(found)
      })
    }, 90)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [open, commandsOnly, needle, searchFiles])

  const groups = useMemo(() => {
    const lower = needle.toLowerCase()
    const matches = (text: string): boolean => !lower || text.toLowerCase().includes(lower)
    const taskItems: Item[] = commandsOnly
      ? []
      : tasks
          .filter((row) => matches(row.title))
          .slice(0, TASK_LIMIT)
          .map((row) => ({ kind: 'task' as const, key: `task:${row.workspacePath}:${row.runId}`, row }))
    const fileItems: Item[] = commandsOnly
      ? []
      : files.map((file) => ({ kind: 'file' as const, key: `file:${file.path}`, file }))
    const matched = [...commands.filter((c) => matches(c.title)), ...(needle ? (settingsCommands?.(needle) ?? []) : [])]
    const commandItems: Item[] = matched
      .slice(0, commandsOnly ? matched.length : COMMAND_LIMIT)
      .map((command) => ({ kind: 'command' as const, key: `cmd:${command.id}`, command }))
    const newTask: Item[] =
      !commandsOnly && needle && newTaskIn
        ? [{ kind: 'newTask', key: 'new-task', text: needle, where: newTaskIn.name }]
        : []
    return { taskItems, fileItems, commandItems, newTask }
  }, [needle, commandsOnly, tasks, files, commands, settingsCommands, newTaskIn])

  const flat = useMemo(
    () => [...groups.taskItems, ...groups.fileItems, ...groups.commandItems, ...groups.newTask],
    [groups]
  )
  const positionOf = useMemo(() => new Map(flat.map((item, i) => [item.key, i])), [flat])

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, flat.length - 1)))
  }, [flat.length])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${index}"]`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [index])

  if (!open) return null

  const activate = (item: Item | undefined, opts: { beside?: boolean } = {}): void => {
    if (!item) return
    onClose()
    if (item.kind === 'task') onOpenTask(item.row, opts.beside === true)
    else if (item.kind === 'file') onOpenFile(item.file)
    else if (item.kind === 'command') onRunCommand(item.command.id)
    else onNewTask(item.text)
  }

  const render = (item: Item): ReactNode => {
    const i = positionOf.get(item.key) ?? 0
    return (
      <PaletteRow key={item.key} item={item} index={i} active={i === index} needle={needle} onHover={() => setIndex(i)} onClick={() => activate(item)} />
    )
  }

  const overlay = (
    <div
      className="fixed inset-0 z-dropdown flex items-start justify-center bg-overlay pt-[88px] animate-fade-in"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        className="vy-menu flex max-h-[min(560px,calc(100vh-120px))] w-[min(640px,calc(100vw-2rem))] flex-col overflow-hidden animate-dialog-in"
      >
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <Icon name="search" size={16} className="text-muted" />
          <input
            ref={inputRef}
            aria-label="Search tasks, files and commands"
            aria-controls="palette-results"
            aria-activedescendant={flat[index] ? `palette-item-${index}` : undefined}
            placeholder="Search tasks, files and commands"
            className="min-w-0 flex-1 bg-transparent text-md text-fg-strong outline-none placeholder:text-tertiary"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                onClose()
                return
              }
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setIndex((i) => Math.min(flat.length - 1, i + 1))
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setIndex((i) => Math.max(0, i - 1))
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                if (event.ctrlKey || event.metaKey) {
                  if (needle && newTaskIn) {
                    activate({ kind: 'newTask', key: 'new-task', text: needle, where: newTaskIn.name })
                  }
                  return
                }
                activate(flat[index], { beside: event.shiftKey })
              }
            }}
          />
          <Keys keys={['Esc']} />
        </div>
        <div
          ref={listRef}
          id="palette-results"
          role="listbox"
          aria-label="Results"
          className="scroll-thin max-h-[440px] min-h-0 flex-1 overflow-y-auto p-1.5"
        >
          {flat.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-tertiary">
              {commandsOnly ? 'No matching commands.' : 'Nothing matches.'}
            </p>
          ) : null}
          {groups.taskItems.length > 0 ? (
            <div role="group" aria-label="Tasks">
              <div className={MENU_LABEL}>Tasks</div>
              {groups.taskItems.map(render)}
            </div>
          ) : null}
          {groups.fileItems.length > 0 ? (
            <div role="group" aria-label="Files">
              <div className={MENU_LABEL}>Files</div>
              {groups.fileItems.map(render)}
            </div>
          ) : null}
          {groups.commandItems.length > 0 ? (
            <div role="group" aria-label="Commands">
              <div className={MENU_LABEL}>Commands</div>
              {groups.commandItems.map(render)}
            </div>
          ) : null}
          {groups.newTask.length > 0 ? (
            <>
              <div role="separator" className={MENU_SEPARATOR} />
              {groups.newTask.map(render)}
            </>
          ) : null}
        </div>
        <div className="flex h-9 shrink-0 items-center gap-4 border-t border-border px-4 text-caption text-tertiary">
          <span className="flex items-center gap-1.5">
            <Keys keys={['↑', '↓']} /> move
          </span>
          <span className="flex items-center gap-1.5">
            <Keys keys={['↵']} /> open
          </span>
          <span className="flex items-center gap-1.5">
            <Keys keys={['Shift', '↵']} /> open beside
          </span>
          <span className="flex-1" />
          <span>Type &gt; for commands only</span>
        </div>
      </div>
    </div>
  )

  return createPortal(overlay, document.body)
}

function PaletteRow({
  item,
  index,
  active,
  needle,
  onHover,
  onClick
}: {
  item: Item
  index: number
  active: boolean
  needle: string
  onHover: () => void
  onClick: () => void
}) {
  const common = {
    id: `palette-item-${index}`,
    'data-palette-index': index,
    role: 'option' as const,
    'aria-selected': active,
    className: cn(MENU_ROW, active ? MENU_ROW_ACTIVE : MENU_ROW_IDLE, MENU_ROW_TEXT),
    onMouseEnter: onHover,
    onMouseDown: (e: MouseEvent) => e.preventDefault(),
    onClick
  }
  if (item.kind === 'task') {
    const row = item.row
    return (
      <div {...common}>
        <MenuItemBody
          lead={
            <span title={row.stateLabel} className="inline-flex shrink-0">
              <StatusGlyph state={row.state} size={14} />
            </span>
          }
          label={highlight(row.title, needle)}
          detail={[row.workspaceName, taskDetail(row)].filter(Boolean).join(' · ')}
          hint={active ? '↵ open' : undefined}
        />
      </div>
    )
  }
  if (item.kind === 'file') {
    return (
      <div {...common}>
        <MenuItemBody lead={<FileTypeIcon path={item.file.path} size={14} />} label={highlight(item.file.path, needle)} />
      </div>
    )
  }
  if (item.kind === 'command') {
    const c = item.command
    return (
      <div {...common}>
        <MenuItemBody icon={c.icon ?? 'command'} label={highlight(c.title, needle)} detail={c.detail} hint={c.hint} keys={c.keys} />
      </div>
    )
  }
  return (
    <div {...common}>
      <MenuItemBody icon="plus" label={`New task: “${item.text}”`} detail={`in ${item.where}`} keys={['Ctrl', '↵']} />
    </div>
  )
}

function taskDetail(row: NavRow): string {
  const meta = row.meta
  if (meta.kind === 'steps') return `step ${meta.current} of ${meta.total}`
  if (meta.kind === 'diff') return `${meta.files} ${meta.files === 1 ? 'file' : 'files'} to review`
  if (meta.kind === 'files') return `${meta.files} ${meta.files === 1 ? 'file' : 'files'} to review`
  return meta.accent ? `${row.stateLabel} · ${meta.text}` : meta.text
}

/** The first case-insensitive occurrence of `needle`, marked. */
export function highlight(text: string, needle: string): ReactNode {
  if (!needle) return text
  const at = text.toLowerCase().indexOf(needle.toLowerCase())
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-accent-soft px-px text-fg-strong">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  )
}
