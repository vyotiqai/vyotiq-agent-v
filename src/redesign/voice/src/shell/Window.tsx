import type { ReactNode } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { VyotiqMark } from '@renderer/lib/brand/VyotiqMark'
import { DiffStat, IconButton, Keys, StatusGlyph, Tabs, cn, type TaskState } from '@renderer/lib/ui'
import { SECTION_LABEL, SIDEBAR_WIDTH_PX, DOCK_WIDTH_DEFAULT_PX } from '@renderer/lib/utils/layout'

/*
  The window around the voice surfaces: a static copy of the shipped shell
  (TitleBar, Navigator, a work pane, the inspector) with the same classes, so
  the voice changes are judged in their real surroundings. Nothing here is
  part of the proposal — the voice work lives in `../voice/`.
*/

export function Window({ navigator, children }: { navigator?: ReactNode; children: ReactNode }) {
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-chrome font-sans text-fg">
      <TitleBar />
      <div className="flex min-h-0 flex-1 border-t border-border">
        {navigator}
        <div className="flex min-w-0 flex-1">{children}</div>
      </div>
    </div>
  )
}

function TitleBar() {
  return (
    <header className="relative flex h-9 shrink-0 items-center bg-chrome" aria-label="Window title bar">
      <div className="flex h-full shrink-0 items-center gap-1 whitespace-nowrap pl-3" style={{ width: SIDEBAR_WIDTH_PX }}>
        <VyotiqMark size={15} className="text-fg-strong" decorative />
        <span className="ml-1.5 text-xs font-semibold tracking-[var(--vy-tracking-tight)] text-fg-strong">Agent V</span>
        <span className="flex-1" />
        <IconButton icon="sidebar" label="Hide navigator" size="sm" tone="muted" className="mr-2" />
      </div>
      <div className="absolute left-1/2 top-1/2 flex h-6 w-[min(380px,34vw)] -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-md bg-surface px-2 text-xs text-tertiary">
        <Icon name="search" size={14} />
        <span className="min-w-0 flex-1 truncate text-left">Search tasks, files and commands</span>
        <Keys keys={['Ctrl', 'K']} />
      </div>
      <div className="ml-auto flex h-full">
        {(['min', 'max', 'close'] as const).map((k) => (
          <span key={k} className="grid h-full w-[46px] place-items-center text-secondary" aria-hidden>
            <svg width="10" height="10" viewBox="0 0 10 10">
              {k === 'min' ? <path d="M0 5h10" stroke="currentColor" strokeWidth="1" /> : null}
              {k === 'max' ? <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" /> : null}
              {k === 'close' ? <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" /> : null}
            </svg>
          </span>
        ))}
      </div>
    </header>
  )
}

type NavRow = { title: string; state: TaskState; meta?: ReactNode; selected?: boolean }

const NAV: Array<{ key: string; label: string; rows: NavRow[] }> = [
  {
    key: 'needs',
    label: 'Needs you',
    rows: [{ title: 'Rotate the staging API keys', state: 'needs', meta: <span className="font-mono text-caption text-accent tnum">2m</span> }]
  },
  {
    key: 'running',
    label: 'Running',
    rows: [
      { title: 'Retry uploads on flaky networks', state: 'running', meta: <span className="font-mono text-caption text-tertiary tnum">3/5</span>, selected: true },
      { title: 'Index the docs folder', state: 'running', meta: <span className="font-mono text-caption text-tertiary tnum">1/3</span> }
    ]
  },
  {
    key: 'review',
    label: 'Ready for review',
    rows: [
      { title: 'Paginate the audit log API', state: 'review', meta: <DiffStat add={214} del={38} /> },
      { title: 'Fix the flaky login e2e', state: 'review', meta: <DiffStat add={12} del={9} /> }
    ]
  },
  {
    key: 'done',
    label: 'Done',
    rows: [
      { title: 'Bump Electron to 44', state: 'done', meta: <span className="text-caption text-tertiary">Tue</span> },
      { title: 'Write the v1.2 changelog', state: 'done', meta: <span className="text-caption text-tertiary">Mon</span> }
    ]
  }
]

function PlaceRow({ icon, label, active = false }: { icon: IconName; label: string; active?: boolean }) {
  return (
    <div
      className={cn(
        'flex h-7 w-full items-center gap-2.5 rounded-md px-2 text-sm',
        active ? 'bg-surface-2 font-medium text-fg-strong' : 'text-secondary'
      )}
    >
      <Icon name={icon} size={16} className={active ? 'text-fg-strong' : 'text-muted'} />
      {label}
    </div>
  )
}

/** The navigator: tasks grouped by what each wants from you. */
export function Navigator({ selectNone = false }: { selectNone?: boolean }) {
  return (
    <nav aria-label="Tasks" className="flex h-full shrink-0 flex-col bg-chrome" style={{ width: SIDEBAR_WIDTH_PX }}>
      <div className="flex items-center gap-1 px-2 pb-2 pt-1">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-sm font-medium text-fg-strong">
          <Icon name="workspace" size={15} className="text-muted" />
          <span className="min-w-0 truncate">uploader-service</span>
          <Icon name="chevron" size={11} className="shrink-0 text-tertiary" />
        </div>
        <IconButton icon="plus" label="New task (Ctrl+N)" size="md" />
      </div>
      <div className="space-y-px px-2">
        <PlaceRow icon="home" label="Home" />
        <PlaceRow icon="extensions" label="Extensions" />
        <PlaceRow icon="chart" label="Usage" />
      </div>
      <div className="mt-2 min-h-0 flex-1 overflow-hidden px-2 pb-2">
        {NAV.map((s) => (
          <section key={s.key} className="mt-3 first:mt-1">
            <h3 className={cn('flex h-6 items-center gap-1.5 px-2', SECTION_LABEL)}>
              {s.label}
              <span className="font-mono font-normal tnum">{s.rows.length}</span>
            </h3>
            <ul className="m-0 list-none space-y-px p-0">
              {s.rows.map((r) => {
                const on = Boolean(r.selected) && !selectNone
                return (
                  <li key={r.title}>
                    <div className={cn('flex h-7 w-full items-center gap-2 rounded-md pl-2 pr-2', on && 'bg-surface-2')}>
                      <StatusGlyph state={r.state} size={14} />
                      <span className={cn('min-w-0 flex-1 truncate text-sm', on ? 'text-fg-strong' : 'text-fg')}>{r.title}</span>
                      {r.meta}
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
      <div className="flex h-10 shrink-0 items-center gap-0.5 px-2">
        <IconButton icon="gear" label="Settings" size="md" tone="muted" />
        <IconButton icon="bell" label="Notifications" size="md" tone="muted" />
        <span className="flex-1" />
      </div>
    </nav>
  )
}

/** One work surface: the pane background and a single left hairline. */
export function Panel({ children, className, width }: { children: ReactNode; className?: string; width?: number }) {
  return (
    <section
      className={cn('vy-panel flex min-w-0 flex-col overflow-hidden', width ? 'shrink-0' : 'flex-1', className)}
      style={width ? { width } : undefined}
    >
      {children}
    </section>
  )
}

const CHANGES = [
  { path: 'src/upload/retry.ts', add: 88, del: 12 },
  { path: 'src/upload/client.ts', add: 21, del: 9 },
  { path: 'tests/upload/retry.test.ts', add: 64, del: 0 }
]

/** The inspector, on its Changes tab — context for the task screens only. */
export function Inspector() {
  return (
    <Panel width={DOCK_WIDTH_DEFAULT_PX}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
        <Tabs
          size="md"
          value="changes"
          label="Inspector"
          items={[
            { id: 'changes', label: 'Changes', count: 3 },
            { id: 'files', label: 'Files' },
            { id: 'terminal', label: 'Terminal', live: true },
            { id: 'browser', label: 'Browser' }
          ]}
        />
        <span className="flex-1" />
        <IconButton icon="expand" label="Expand" size="sm" tone="muted" />
      </div>
      <ul className="m-0 list-none p-2">
        {CHANGES.map((c) => (
          <li key={c.path} className="flex h-7 items-center gap-2 rounded-md px-2 text-sm">
            <Icon name="file" size={14} className="text-muted" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{c.path}</span>
            <DiffStat add={c.add} del={c.del} />
          </li>
        ))}
      </ul>
    </Panel>
  )
}
