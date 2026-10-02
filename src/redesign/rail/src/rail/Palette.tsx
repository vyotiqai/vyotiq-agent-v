import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { Keys, StatusGlyph, cn } from '@renderer/lib/ui'
import { MENU_LABEL, MENU_ROW, MENU_ROW_ACTIVE, MENU_ROW_IDLE, MENU_ROW_TEXT, MENU_SURFACE } from '@renderer/lib/ui/menuStyles'
import { FILE_TREE, TASKS, base, dir } from '../data'
import { SHEET_ICON, SHEET_NAME, SHELF, useRail } from './store'

/*
  Ctrl K — one search for tasks, sheets, places, commands and files.
  Start with > for commands only. It opens sheets on the rail like any other
  door, so the palette is a keyboard route to everything the mouse can reach.
*/

type Item = { id: string; group: string; lead: ReactNode; label: string; detail?: string; keys?: string[]; run: () => void }

const icon = (name: IconName): ReactNode => <Icon name={name} size={14} className="text-muted" />

export function Palette() {
  const { s, d, wideNav } = useRail()
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (s.paletteOpen) {
      setQ('')
      setAt(0)
      requestAnimationFrame(() => input.current?.focus())
    }
  }, [s.paletteOpen])

  const items = useMemo<Item[]>(() => {
    const close = (): void => d({ type: 'palette', open: false })
    const tasks: Item[] = TASKS.map((t) => ({
      id: `task-${t.id}`,
      group: 'Tasks',
      lead: <StatusGlyph state={t.state} size={14} />,
      label: t.title,
      detail: t.group === 'needs' ? 'needs you' : t.elapsed || t.meta,
      run: () => d({ type: 'selectTask', id: t.id })
    }))
    const sheets: Item[] = (s.place === 'task' ? SHELF : []).concat('settings').map((k) => ({
      id: `sheet-${k}`,
      group: 'Open beside',
      lead: icon(SHEET_ICON[k]),
      label: SHEET_NAME[k],
      detail: s.sheets.some((x) => x.kind === k) ? 'open' : undefined,
      run: () => d({ type: 'open', kind: k })
    }))
    const places: Item[] = [
      { id: 'go-new', group: 'Go to', lead: icon('plus'), label: 'New task', run: () => d({ type: 'place', place: 'new' }) },
      { id: 'go-home', group: 'Go to', lead: icon('home'), label: 'Home', run: () => d({ type: 'place', place: 'home' }) },
      { id: 'go-usage', group: 'Go to', lead: icon('chart'), label: 'Usage', run: () => d({ type: 'place', place: 'usage' }) },
      { id: 'go-ext', group: 'Go to', lead: icon('extensions'), label: 'Extensions', run: () => d({ type: 'place', place: 'extensions' }) }
    ]
    const commands: Item[] = [
      { id: 'c-fit', group: 'Commands', lead: icon('columns'), label: 'Fit every sheet', run: () => (d({ type: 'fit' }), close()) },
      { id: 'c-lens', group: 'Commands', lead: icon('enter'), label: 'Focus the lens', keys: ['Ctrl', 'L'], run: () => (d({ type: 'lens' }), close()) },
      { id: 'c-nav', group: 'Commands', lead: icon('sidebar'), label: wideNav ? 'Compact navigator' : 'Full navigator', keys: ['Ctrl', 'B'], run: () => (d({ type: 'nav', wide: wideNav }), close()) },
      {
        id: 'c-theme',
        group: 'Commands',
        lead: icon(s.theme === 'dark' ? 'sun' : 'moon'),
        label: s.theme === 'dark' ? 'Light theme' : 'Dark theme',
        run: () => (d({ type: 'appearance', theme: s.theme === 'dark' ? 'light' : 'dark' }), close())
      },
      { id: 'c-keys', group: 'Commands', lead: icon('keyboard'), label: 'Keys', run: () => d({ type: 'keys', open: true }) }
    ]
    const files: Item[] = FILE_TREE.map((p) => ({
      id: `file-${p}`,
      group: 'Files',
      lead: icon('file'),
      label: base(p),
      detail: dir(p).replace('src/renderer/src/', ''),
      run: () => d({ type: 'open', kind: 'file', path: p })
    }))

    const commandsOnly = q.startsWith('>')
    const needle = (commandsOnly ? q.slice(1) : q).trim().toLowerCase()
    const hit = (x: Item): boolean => !needle || `${x.label} ${x.detail ?? ''}`.toLowerCase().includes(needle)
    if (commandsOnly) return commands.filter(hit)
    const pool = needle ? [...tasks, ...sheets, ...places, ...commands, ...files] : [...tasks.slice(0, 4), ...sheets, ...places, ...commands]
    return pool.filter(hit).slice(0, 40)
  }, [q, s.place, s.sheets, s.theme, wideNav, d])

  useEffect(() => {
    list.current?.querySelector(`[data-i="${at}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [at])

  if (!s.paletteOpen) return null

  const run = (i: number): void => items[i]?.run()
  let lastGroup = ''

  return (
    <div className="absolute inset-0 z-dropdown bg-overlay animate-fade-in" onPointerDown={() => d({ type: 'palette', open: false })}>
      <div
        role="dialog"
        aria-label="Search tasks, sheets and commands"
        onPointerDown={(e) => e.stopPropagation()}
        className={cn(MENU_SURFACE, 'absolute left-1/2 top-14 flex max-h-[min(560px,calc(100%-96px))] w-[min(640px,calc(100%-32px))] -translate-x-1/2 flex-col')}
      >
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <Icon name="search" size={16} className="text-muted" />
          <input
            ref={input}
            value={q}
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
            aria-activedescendant={items[at] ? `pal-${items[at].id}` : undefined}
            onChange={(e) => (setQ(e.target.value), setAt(0))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') return e.preventDefault(), setAt(Math.min(items.length - 1, at + 1))
              if (e.key === 'ArrowUp') return e.preventDefault(), setAt(Math.max(0, at - 1))
              if (e.key === 'Enter') return e.preventDefault(), run(at)
              if (e.key === 'Escape') return e.preventDefault(), d({ type: 'palette', open: false })
            }}
            placeholder="Search tasks, sheets, commands and files"
            aria-label="Search"
            className="min-w-0 flex-1 bg-transparent text-md text-fg-strong outline-none placeholder:text-tertiary"
          />
          <Keys keys={['Esc']} />
        </div>
        <div ref={list} id="palette-list" role="listbox" className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1">
          {items.length === 0 ? <div className="px-3 py-6 text-center text-sm text-tertiary">Nothing matches “{q}”</div> : null}
          {items.map((x, i) => {
            const head = x.group !== lastGroup ? x.group : null
            lastGroup = x.group
            return (
              <div key={x.id}>
                {head ? <div className={MENU_LABEL}>{head}</div> : null}
                <button
                  id={`pal-${x.id}`}
                  data-i={i}
                  type="button"
                  role="option"
                  aria-selected={i === at}
                  onPointerEnter={() => setAt(i)}
                  onClick={() => run(i)}
                  className={cn(MENU_ROW, i === at ? MENU_ROW_ACTIVE : MENU_ROW_IDLE, MENU_ROW_TEXT)}
                >
                  <span className="grid w-4 shrink-0 place-items-center">{x.lead}</span>
                  <span className="shrink-0 truncate">{x.label}</span>
                  <span className="min-w-0 flex-1 truncate text-caption text-tertiary">{x.detail}</span>
                  {x.keys ? <Keys keys={x.keys} /> : null}
                </button>
              </div>
            )
          })}
        </div>
        <div className="flex h-8 shrink-0 items-center gap-3 border-t border-border px-3 text-caption text-tertiary">
          <span className="flex items-center gap-1">
            <Keys keys={['↑', '↓']} /> move
          </span>
          <span className="flex items-center gap-1">
            <Keys keys={['↵']} /> open
          </span>
          <span className="flex-1" />
          <span>Type &gt; for commands only</span>
        </div>
      </div>
    </div>
  )
}
