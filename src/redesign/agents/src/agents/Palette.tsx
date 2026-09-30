import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { Keys, StatusGlyph, cn, type TaskState } from '@renderer/lib/ui'
import { MENU_LABEL, MENU_ROW, MENU_ROW_ACTIVE, MENU_ROW_IDLE, MENU_ROW_TEXT, MENU_SURFACE_SCROLL } from '@renderer/lib/ui/menuStyles'
import { REPO_FILES } from './data'
import { diffsOf, isSettled, taskOf } from './runtime'
import { useAgents, type Action } from './store'

/* Ctrl K. Tasks first, then actions, then files; `>` narrows to actions. */

type Entry = { group: 'Tasks' | 'Actions' | 'Files'; label: string; meta?: string; keys?: string[]; icon?: IconName; state?: TaskState; run: Action[] }

const ACTIONS: Entry[] = [
  { group: 'Actions', label: 'New task', icon: 'plus', keys: ['Ctrl', 'N'], run: [{ type: 'view', view: 'new' }] },
  { group: 'Actions', label: 'Open Review', icon: 'diff', keys: ['Alt', '1'], run: [{ type: 'view', view: 'agent' }, { type: 'ws', tab: 'review' }] },
  { group: 'Actions', label: 'Open Files', icon: 'tree', keys: ['Alt', '2'], run: [{ type: 'view', view: 'agent' }, { type: 'ws', tab: 'files' }] },
  { group: 'Actions', label: 'Open Terminal', icon: 'terminal', keys: ['Alt', '3'], run: [{ type: 'view', view: 'agent' }, { type: 'ws', tab: 'terminal' }] },
  { group: 'Actions', label: 'Open Browser', icon: 'globe', keys: ['Alt', '4'], run: [{ type: 'view', view: 'agent' }, { type: 'ws', tab: 'browser' }] },
  { group: 'Actions', label: 'Open PR', icon: 'pullRequest', keys: ['Alt', '5'], run: [{ type: 'view', view: 'agent' }, { type: 'ws', tab: 'pr' }] },
  { group: 'Actions', label: 'Open Plan', icon: 'doc', keys: ['Alt', '6'], run: [{ type: 'view', view: 'agent' }, { type: 'ws', tab: 'plan' }] },
  { group: 'Actions', label: 'Side pane full width', icon: 'expand', keys: ['Ctrl', 'Shift', 'I'], run: [{ type: 'view', view: 'agent' }, { type: 'sideFull', on: true }] },
  { group: 'Actions', label: 'Show or hide the task list', icon: 'sidebar', keys: ['Ctrl', 'B'], run: [] },
  { group: 'Actions', label: 'All tasks', icon: 'home', run: [{ type: 'view', view: 'home' }] },
  { group: 'Actions', label: 'Inbox', icon: 'inbox', run: [{ type: 'inbox', open: true }] },
  { group: 'Actions', label: 'Usage', icon: 'chart', run: [{ type: 'view', view: 'usage' }] },
  { group: 'Actions', label: 'Extensions', icon: 'extensions', run: [{ type: 'view', view: 'extensions' }] },
  { group: 'Actions', label: 'Settings', icon: 'gear', keys: ['Ctrl', ','], run: [{ type: 'view', view: 'settings' }] }
]

export function Palette() {
  const { s, d } = useAgents()
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  const entries = useMemo(() => {
    const actionsOnly = q.startsWith('>')
    const term = (actionsOnly ? q.slice(1) : q).trim().toLowerCase()
    const tasks: Entry[] = s.tasks
      .filter((t) => !t.archived)
      .sort((a, b) => Number(isSettled(a)) - Number(isSettled(b)))
      .map((t) => ({
        group: 'Tasks',
        label: t.title,
        meta: t.state === 'running' ? t.line : `${t.workspace} · ${t.age}`,
        state: t.state,
        run: [{ type: 'open', agent: t.id }]
      }))
    const current = taskOf(s, s.agent)
    const paths = Array.from(new Set([...diffsOf(s, current.id).map((f) => f.path), ...(REPO_FILES[current.workspace] ?? [])]))
    const files: Entry[] = paths.map((p) => ({
      group: 'Files',
      label: p.split('/').pop() ?? p,
      meta: p.split('/').slice(0, -1).join('/'),
      icon: 'file',
      run: [{ type: 'view', view: 'agent' }, { type: 'file', path: p }]
    }))
    if (actionsOnly) return ACTIONS.filter((e) => e.label.toLowerCase().includes(term))
    if (!term) return [...tasks.slice(0, 5), ...ACTIONS.slice(0, 4), ...files.slice(0, 3)]
    return [...tasks, ...ACTIONS, ...files].filter((e) => `${e.label} ${e.meta ?? ''}`.toLowerCase().includes(term)).slice(0, 14)
  }, [q, s])

  useEffect(() => input.current?.focus(), [])
  useEffect(() => setAt(0), [q])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const go = (e: Entry | undefined): void => {
    if (!e) return
    d({ type: 'palette', open: false })
    if (e.label === 'Show or hide the task list') d({ type: 'listHidden', on: !s.listHidden })
    e.run.forEach(d)
  }

  return (
    <div className="absolute inset-0 z-drawer">
      <button type="button" tabIndex={-1} aria-label="Close" onClick={() => d({ type: 'palette', open: false })} className="absolute inset-0 cursor-default bg-overlay" />
      <div role="dialog" aria-label="Search tasks, files and commands" className={cn(MENU_SURFACE_SCROLL, 'absolute left-1/2 top-16 flex max-h-[min(540px,72%)] w-[620px] -translate-x-1/2 flex-col')}>
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
          <Icon name="search" size={16} className="text-tertiary" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setAt((x) => Math.min(entries.length - 1, x + 1)))
              if (e.key === 'ArrowUp') (e.preventDefault(), setAt((x) => Math.max(0, x - 1)))
              if (e.key === 'Enter') go(entries[at])
              if (e.key === 'Escape') d({ type: 'palette', open: false })
            }}
            placeholder="Search tasks, files and commands"
            aria-label="Search"
            aria-activedescendant={entries.length ? `pal-${at}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-md text-fg-strong outline-none placeholder:text-tertiary"
          />
          <Keys keys={['Esc']} />
        </div>
        <div ref={list} role="listbox" aria-label="Results" className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1">
          {entries.map((e, i) => (
            <div key={`${e.group}-${e.label}-${e.meta ?? ''}`}>
              {i === 0 || entries[i - 1].group !== e.group ? <div className={MENU_LABEL}>{e.group}</div> : null}
              <button
                id={`pal-${i}`}
                type="button"
                role="option"
                aria-selected={i === at}
                data-index={i}
                onMouseEnter={() => setAt(i)}
                onClick={() => go(e)}
                className={cn(MENU_ROW, 'h-8', i === at ? MENU_ROW_ACTIVE : MENU_ROW_IDLE, MENU_ROW_TEXT)}
              >
                <span className="inline-grid size-4 shrink-0 place-items-center text-tertiary">
                  {e.state ? <StatusGlyph state={e.state} size={14} /> : e.icon ? <Icon name={e.icon} size={15} /> : null}
                </span>
                <span className="shrink-0 truncate">{e.label}</span>
                <span className={cn('min-w-0 flex-1 truncate text-caption', e.state === 'running' ? 'vy-text-live' : 'text-tertiary')}>{e.meta}</span>
                {e.keys ? <Keys keys={e.keys} /> : null}
                {i === at ? <Icon name="enter" size={13} className="text-tertiary" /> : null}
              </button>
            </div>
          ))}
          {!entries.length ? <div className="px-3 py-6 text-center text-xs text-tertiary">Nothing matches “{q}”</div> : null}
        </div>
        <div className="flex h-8 shrink-0 items-center gap-3 border-t border-border px-4 text-caption text-tertiary">
          <span className="inline-flex items-center gap-1">
            <Keys keys={['↑', '↓']} /> move
          </span>
          <span className="inline-flex items-center gap-1">
            <Keys keys={['↵']} /> open
          </span>
          <span className="inline-flex items-center gap-1">
            <Keys keys={['>']} /> actions only
          </span>
        </div>
      </div>
    </div>
  )
}
