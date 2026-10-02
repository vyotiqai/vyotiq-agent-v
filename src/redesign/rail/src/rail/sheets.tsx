import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Button, DiffStat, IconButton, Segmented, StatusGlyph, StepMarker, cn } from '@renderer/lib/ui'
import { MENU_LABEL, MENU_ROW, MENU_ROW_ACTIVE, MENU_ROW_IDLE, MENU_ROW_TEXT } from '@renderer/lib/ui/menuStyles'
import { SELECTED } from '@renderer/lib/utils/layout'
import { FILE_TREE, PLAN, PR, SOURCE, base, dir, type DiffLine, type Task } from '../data'
import { DiffLines } from './RecordSheet'
import { Empty, GUTTER, ROW, SCROLL, Section } from './parts'
import { useRail } from './store'

/*
  The sheets that stand beside a task's record — the old inspector's tabs,
  each now a sheet of its own on the rail. They share one grid (parts.tsx):
  a 16px gutter, 32px rows, sections under caps labels, and bordered cards
  for anything that is output (diffs, terminal, a page).
*/

/* ─── Changes ─────────────────────────────────────────────────────────────── */

function diffFor(task: Task, path: string): DiffLine[] {
  for (const st of task.steps) {
    for (const w of st.work) if (w.kind === 'diff' && w.file === path) return w.lines
  }
  return [
    { n: 1, sign: '+', text: `// ${base(path)}` },
    { n: 2, sign: '+', text: '// the whole diff is in the real app' }
  ]
}

const COMMIT_MSG: Record<string, string> = {
  composer: 'Redesign the / and @ composer menus',
  diffs: 'Number diff lines from the file itself'
}

export function ChangesSheetBody({ task }: { task: Task }) {
  const { d } = useRail()
  const [sel, setSel] = useState(task.files[0]?.path ?? '')
  const [msg, setMsg] = useState(COMMIT_MSG[task.id] ?? '')
  const [done, setDone] = useState<'none' | 'kept' | 'committed'>('none')
  const add = task.files.reduce((n, f) => n + f.add, 0)
  const del = task.files.reduce((n, f) => n + f.del, 0)
  const running = task.state === 'running' || task.state === 'needs'

  if (task.files.length === 0) {
    return (
      <Empty icon="diff" title="No changes yet">
        Files the agent edits show up here while it works.
      </Empty>
    )
  }
  return (
    <>
      <div className={SCROLL}>
        <div className={cn(GUTTER, 'pb-4')}>
          <div className="flex h-10 items-center gap-2 text-caption text-tertiary">
            <span className="font-mono tnum">{task.files.length} files</span>
            <DiffStat add={add} del={del} />
            <span className="flex-1" />
            <span className={done === 'none' ? 'text-tertiary' : 'text-fg'}>{done === 'committed' ? 'Committed as e40b2a1' : done === 'kept' ? 'Kept, not committed' : 'Not committed'}</span>
          </div>
          <ul className="m-0 list-none p-0">
            {task.files.map((f) => {
              const on = f.path === sel
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    aria-current={on || undefined}
                    onClick={() => setSel(f.path)}
                    onDoubleClick={() => d({ type: 'open', kind: 'file', path: f.path })}
                    className={cn(ROW, 'w-[calc(100%+16px)] text-left vy-transition focus-visible:vy-focus-ring', on ? SELECTED : 'hover:bg-surface')}
                  >
                    <span className={cn('w-3 shrink-0 font-mono text-caption', f.status === 'A' ? 'text-success' : 'text-warning')}>{f.status}</span>
                    <span className="shrink-0 text-sm text-fg">{base(f.path)}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-caption text-tertiary">{dir(f.path).replace('src/renderer/src/', '')}</span>
                    <DiffStat add={f.add} del={f.del} />
                  </button>
                </li>
              )
            })}
          </ul>
          {sel ? (
            <div className="mt-3 overflow-hidden rounded-lg border border-border bg-bg">
              <div className="flex h-8 items-center gap-2 border-b border-border pl-3 pr-1">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{base(sel)}</span>
                <IconButton icon="external" size="sm" tone="muted" label="Open the file as a sheet" onClick={() => d({ type: 'open', kind: 'file', path: sel })} />
                <IconButton icon="undo" size="sm" tone="muted" label="Undo this file" />
              </div>
              <div className="overflow-x-auto" data-ask-source={base(sel)}>
                <DiffLines lines={diffFor(task, sel)} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 border-t border-border px-4 py-3">
        <label htmlFor={`msg-${task.id}`} className="sr-only">
          Commit message
        </label>
        <input
          id={`msg-${task.id}`}
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          placeholder="Commit message"
          className="h-8 w-full rounded-md border border-border bg-bg px-2.5 text-sm text-fg outline-none vy-transition placeholder:text-tertiary hover:border-border-strong focus-visible:vy-focus-ring"
        />
        <div className="mt-2 flex items-center gap-1.5">
          <Button variant="ghost" size="sm" icon="undo">
            Undo all
          </Button>
          <span className="flex-1" />
          <Button variant="secondary" size="sm" onClick={() => setDone('kept')} disabled={done !== 'none'}>
            Keep all
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon="gitCommit"
            disabled={done === 'committed' || running || !msg.trim()}
            title={running ? 'Commit when the run finishes' : !msg.trim() ? 'Write a commit message' : undefined}
            onClick={() => setDone('committed')}
          >
            {done === 'committed' ? 'Committed' : 'Commit'}
          </Button>
        </div>
      </div>
    </>
  )
}

/* ─── Files ───────────────────────────────────────────────────────────────── */

type Node = { name: string; path: string; dir: boolean; children: Node[] }

const EXTRA = [
  'src/renderer/src/features/chat/components/composer/mentionModel.ts',
  'src/renderer/src/features/chat/components/composer/slashCommandPresentation.ts',
  'src/main/ipc/agent.ts',
  'tests/main/unit/workspaceMentionIpc.test.ts',
  'CLAUDE.md',
  'README.md',
  'package.json'
]

function buildTree(paths: string[]): Node {
  const root: Node = { name: '', path: '', dir: true, children: [] }
  for (const p of paths) {
    let at = root
    p.split('/').forEach((part, i, all) => {
      const path = all.slice(0, i + 1).join('/')
      let next = at.children.find((c) => c.name === part)
      if (!next) {
        next = { name: part, path, dir: i < all.length - 1, children: [] }
        at.children.push(next)
      }
      at = next
    })
  }
  // Fold single-child folders into one row, the way editors do.
  const compact = (n: Node): Node => {
    let cur = n
    while (cur.dir && cur.children.length === 1 && cur.children[0].dir && cur !== root) {
      const c = cur.children[0]
      cur = { ...c, name: `${cur.name}/${c.name}` }
    }
    const kids = cur.children.map(compact).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    return { ...cur, children: kids }
  }
  return compact(root)
}

export function FilesSheetBody({ task }: { task: Task }) {
  const { d } = useRail()
  const [q, setQ] = useState('')
  const changed = useMemo(() => new Map(task.files.map((f) => [f.path, f.status])), [task])
  const all = useMemo(() => [...new Set([...FILE_TREE, ...EXTRA, ...task.files.map((f) => f.path)])], [task])
  const tree = useMemo(() => buildTree(all.filter((p) => p.toLowerCase().includes(q.toLowerCase()))), [all, q])
  const [shut, setShut] = useState<Set<string>>(new Set())

  const rows: Array<{ node: Node; depth: number }> = []
  const walk = (n: Node, depth: number): void => {
    for (const c of n.children) {
      rows.push({ node: c, depth })
      if (c.dir && !shut.has(c.path)) walk(c, depth + 1)
    }
  }
  walk(tree, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn(GUTTER, 'pt-3')}>
        <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-bg px-2.5 vy-transition hover:border-border-strong focus-within:border-border-strong">
          <Icon name="search" size={13} className="text-tertiary" />
          <span className="sr-only">Filter files</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter files" className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-tertiary" />
          <span className="font-mono text-caption text-tertiary tnum">{all.length}</span>
        </label>
      </div>
      <div className={cn(SCROLL, 'pb-4 pt-2')}>
        <ul className={cn('m-0 list-none p-0', GUTTER)}>
          {rows.map(({ node, depth }) => {
            const st = changed.get(node.path)
            const open = !shut.has(node.path)
            return (
              <li key={node.path}>
                <button
                  type="button"
                  aria-expanded={node.dir ? open : undefined}
                  onClick={() => {
                    if (!node.dir) return d({ type: 'open', kind: 'file', path: node.path })
                    const n = new Set(shut)
                    if (open) n.add(node.path)
                    else n.delete(node.path)
                    setShut(n)
                  }}
                  className={cn(ROW, 'h-7 w-[calc(100%+16px)] text-left vy-transition hover:bg-surface focus-visible:vy-focus-ring')}
                  style={{ paddingLeft: 8 + depth * 14 }}
                >
                  <span className="w-3 shrink-0 text-tertiary">{node.dir ? <Icon name={open ? 'chevron' : 'chevronRight'} size={11} /> : null}</span>
                  <Icon name={node.dir ? (open ? 'folderOpen' : 'folder') : 'file'} size={14} className="shrink-0 text-muted" />
                  <span className={cn('min-w-0 flex-1 truncate text-sm', st ? 'text-fg-strong' : node.dir ? 'text-secondary' : 'text-fg')}>{node.name}</span>
                  {st ? <span className={cn('w-3 shrink-0 font-mono text-caption', st === 'A' ? 'text-success' : 'text-warning')}>{st}</span> : null}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

/* ─── File ────────────────────────────────────────────────────────────────── */

function Highlight({ line }: { line: string }) {
  const t = line.trimStart()
  const comment = t.startsWith('/*') || t.startsWith('*') ? line.length - t.length : line.indexOf('//')
  const code = comment >= 0 ? line.slice(0, comment) : line
  const parts: Array<{ t: string; c?: string }> = []
  const re = /('[^']*'|"[^"]*"|`[^`]*`)|\b(import|from|export|function|const|let|return|if|type|await|async|new)\b|(\b[A-Z][A-Za-z]+\b)/g
  let last = 0
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m.index > last) parts.push({ t: code.slice(last, m.index) })
    parts.push({ t: m[0], c: m[1] ? 'text-[var(--vy-syntax-string)]' : m[2] ? 'text-[var(--vy-syntax-keyword)]' : 'text-[var(--vy-syntax-type)]' })
    last = m.index + m[0].length
  }
  if (last < code.length) parts.push({ t: code.slice(last) })
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className={p.c}>
          {p.t}
        </span>
      ))}
      {comment >= 0 ? <span className="text-[var(--vy-syntax-comment)]">{line.slice(comment)}</span> : null}
    </>
  )
}

export function FileSheetBody({ path }: { path: string }) {
  const src = SOURCE[path]
  const scroller = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = scroller.current?.querySelector('[data-line="38"]')
    if (el && scroller.current) scroller.current.scrollTop = (el as HTMLElement).offsetTop - 12
  }, [path])
  if (!src) {
    return (
      <Empty icon="file" title={base(path)}>
        This mockup carries the source of MentionMenu.tsx only.
      </Empty>
    )
  }
  return (
    <div ref={scroller} className="scroll-thin min-h-0 flex-1 overflow-auto" data-ask-source={base(path)}>
      <div className="py-2 font-mono text-xs leading-mono">
        {src.lines.map((l, i) => {
          const n = i + 1
          const edited = src.edited.includes(n)
          return (
            <div key={n} data-line={n} className={cn('flex whitespace-pre pr-4', edited ? 'diff-row-add' : '')}>
              <span className="w-12 shrink-0 select-none pr-3 text-right text-tertiary tnum">{n}</span>
              <span className={cn('w-4 shrink-0 select-none', edited ? 'text-success' : 'text-transparent')}>{edited ? '+' : ' '}</span>
              <span className="text-fg">
                <Highlight line={l} />
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function FileSheetMeta({ path }: { path: string }) {
  const src = SOURCE[path]
  return (
    <span className="min-w-0 shrink-[4] truncate font-mono text-caption text-tertiary">
      {dir(path).replace('src/renderer/src/', '')}
      {src ? ` · ${src.edited.length} lines edited` : ''}
    </span>
  )
}

/* ─── Terminal ────────────────────────────────────────────────────────────── */

export function TerminalSheetBody({ task }: { task: Task }) {
  const { s } = useRail()
  const runs = task.steps.flatMap((st) => st.work.filter((w) => w.kind === 'terminal'))
  const typed = (s.steers[task.id] ?? []).filter((x) => x.mode === 'run').map((x) => x.text)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [typed.length])
  if (runs.length === 0 && typed.length === 0) {
    return (
      <Empty icon="terminal" title="No commands yet">
        Commands the agent runs stream here. Start a line in the lens with $ to run one yourself.
      </Empty>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-sunken">
      <div className={cn(SCROLL, GUTTER, 'overflow-x-auto py-3 font-mono text-xs leading-mono')} data-ask-source="Terminal">
        {runs.map((r, i) => (
          <Fragment key={i}>
            <div className="whitespace-pre text-fg">
              <span className="select-none text-tertiary">$ </span>
              {r.command}
            </div>
            {r.lines.map((l, k) => (
              <div key={k} className="min-h-[1lh] whitespace-pre text-secondary">
                {l}
              </div>
            ))}
            {r.exit === null ? (
              <div className="whitespace-pre text-secondary">
                <span className="inline-block h-[1.1em] w-[0.6em] translate-y-[2px] bg-fg animate-live" aria-label="running" />
              </div>
            ) : (
              <div className={cn('mb-3 text-caption', r.exit === 0 ? 'text-tertiary' : 'text-danger')}>exit {r.exit}</div>
            )}
          </Fragment>
        ))}
        {typed.map((t, i) => (
          <div key={`t${i}`} className="mt-3 animate-fade-in whitespace-pre text-fg">
            <span className="select-none text-tertiary">$ </span>
            {t}
            <div className="text-tertiary">(this mockup has no shell behind it)</div>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  )
}

/* ─── Browser ─────────────────────────────────────────────────────────────── */

/** The page the task is checking, at the viewport the check names. */
export function BrowserSheetBody() {
  const [vw, setVw] = useState<'800' | '1600'>('800')
  const stage = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState({ w: 400, h: 300 })
  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => setRoom({ w: el.clientWidth - 32, h: el.clientHeight - 56 }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const W = Number(vw)
  const H = 560
  const k = Math.max(0.1, Math.min(1, room.w / W, room.h / H))
  const menuW = Math.min(440, W - 16)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <IconButton icon="arrowLeft" label="Back" size="sm" tone="muted" />
        <IconButton icon="arrowRight" label="Forward" size="sm" tone="muted" />
        <IconButton icon="refresh" label="Reload" size="sm" tone="muted" />
        <div className="mx-1 flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md bg-surface px-2">
          <Icon name="lock" size={12} className="shrink-0 text-tertiary" />
          <span className="min-w-0 truncate font-mono text-xs text-fg">localhost:5173/?mock=composer&amp;open=mention</span>
        </div>
        <Segmented label="Viewport" value={vw} onChange={setVw} items={[{ id: '800', label: '800' }, { id: '1600', label: '1600' }]} />
      </div>
      <div ref={stage} className="relative min-h-0 flex-1 overflow-hidden bg-sunken">
        <div className="absolute left-4 top-4 origin-top-left" style={{ width: W, height: H, transform: `scale(${k})` }}>
          <div className="relative h-full w-full overflow-hidden rounded-lg border border-border bg-bg shadow-menu">
            <div className="flex h-9 items-center border-b border-border px-4 text-xs text-tertiary">Agent V · composer at {vw}px</div>
            <div className="space-y-2.5 px-4 pt-5" aria-hidden>
              <div className="h-2.5 w-2/3 rounded-full bg-surface-2" />
              <div className="h-2 w-5/6 rounded-full bg-surface" />
              <div className="h-2 w-3/4 rounded-full bg-surface" />
              <div className="h-2 w-1/2 rounded-full bg-surface" />
            </div>
            <div className="absolute inset-x-4 bottom-4 rounded-lg border border-border bg-bg">
              <div className="px-3 py-2.5 text-sm text-fg-strong">
                Check <span className="rounded-sm bg-accent-soft px-1 text-accent">@menu</span>
              </div>
              <div className="flex h-9 items-center gap-2 border-t border-border/60 px-3 text-xs text-tertiary">Agent · space-bunny-free</div>
            </div>
            <div className="absolute bottom-[92px] left-6 vy-menu p-1" style={{ width: menuW }}>
              <div className={MENU_LABEL}>Files and folders</div>
              {['composer/', 'MentionMenu.tsx', 'SlashCommandMenu.tsx', 'composerMenuViewport.test.tsx'].map((r, i) => (
                <div key={r} className={cn(MENU_ROW, i === 1 ? MENU_ROW_ACTIVE : MENU_ROW_IDLE, MENU_ROW_TEXT)}>
                  <Icon name={r.endsWith('/') ? 'folder' : 'file'} size={14} className="text-muted" />
                  {r}
                  {r.endsWith('/') ? <span className="ml-auto font-mono text-caption text-tertiary">12</span> : null}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="absolute left-4 flex items-center gap-2 font-mono text-caption text-tertiary" style={{ top: 16 + H * k + 10, width: W * k }}>
          <StatusGlyph state="done" size={12} label />
          {W} × {H} · the menu stays inside the window
          <span className="flex-1" />
          <span className="tnum">{Math.round(k * 100)}%</span>
        </div>
      </div>
    </div>
  )
}

/* ─── Pull request ────────────────────────────────────────────────────────── */

export function PrSheetBody({ task }: { task: Task }) {
  const [made, setMade] = useState(task.id === 'composer')
  const canOpen = task.id === 'diffs'
  if (!made) {
    return (
      <Empty icon="pullRequest" title="No pull request yet">
        {canOpen ? (
          <>
            <span>The changes are on main, not committed. Open a draft from a new branch and I’ll watch its checks.</span>
            <div className="mt-3">
              <Button variant="secondary" size="sm" icon="pullRequest" onClick={() => setMade(true)}>
                Open a draft pull request
              </Button>
            </div>
          </>
        ) : (
          'Commit the changes first.'
        )}
      </Empty>
    )
  }
  const checks = task.id === 'composer' ? PR.checks : PR.checks.map((c) => ({ ...c, state: 'queued' as const, time: '' }))
  const passed = checks.filter((c) => c.state === 'done').length
  return (
    <div className={SCROLL}>
      <div className={cn(GUTTER, 'pb-6')}>
        <div className="pt-4 text-heading font-medium text-fg-strong">{task.id === 'composer' ? PR.title : task.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-tertiary">
          <span className="rounded-sm border border-border px-1.5 text-secondary">Draft</span>
          <span className="font-mono">{task.id === 'composer' ? PR.branch : 'claude/diff-line-numbers'}</span>
          <Icon name="arrowRight" size={11} />
          <span className="font-mono">{PR.base}</span>
          <span>· {task.id === 'composer' ? 'opened 12m ago' : 'just now'}</span>
        </div>
        <Section label="Checks" count={`${passed}/${checks.length}`}>
          <ul className="m-0 list-none p-0">
            {checks.map((c) => (
              <li key={c.name} className={ROW}>
                <StatusGlyph state={c.state} size={14} label />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{c.name}</span>
                <span className="font-mono text-caption text-tertiary tnum">{c.time || 'waiting'}</span>
              </li>
            ))}
          </ul>
        </Section>
        <div className="mt-5 flex items-center gap-1.5">
          <Button variant="secondary" size="sm" disabled={passed < checks.length} title={passed < checks.length ? 'When every check has passed' : undefined}>
            Ready for review
          </Button>
          <Button variant="ghost" size="sm" trailingIcon="external">
            View on GitHub
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ─── Plan ────────────────────────────────────────────────────────────────── */

function Bullets({ items }: { items: readonly string[] }) {
  return (
    <ul className="m-0 list-none space-y-1 p-0">
      {items.map((x) => (
        <li key={x} className="flex gap-3 text-sm text-fg">
          <span className="w-[18px] shrink-0 text-center text-tertiary">–</span>
          <span className="min-w-0">{x}</span>
        </li>
      ))}
    </ul>
  )
}

export function PlanSheetBody({ task }: { task: Task }) {
  if (task.id !== 'composer') {
    return (
      <Empty icon="plan" title="No plan for this task">
        Short tasks run without one. A plan appears here when the agent writes it.
      </Empty>
    )
  }
  return (
    <div className={SCROLL} data-ask-source="Plan">
      <div className={cn(GUTTER, 'max-w-[760px] pb-8')}>
        <div className="pt-4 text-heading font-medium text-fg-strong">{PLAN.title}</div>
        <Section label="Goal">
          <p className="m-0 max-w-[68ch] text-sm text-fg">{PLAN.goal}</p>
        </Section>
        <Section label="In scope">
          <Bullets items={PLAN.scopeIn} />
        </Section>
        <Section label="Out of scope">
          <Bullets items={PLAN.scopeOut} />
        </Section>
        <Section label="Steps" count={task.steps.length}>
          <ol className="m-0 list-none p-0">
            {task.steps.map((st, i) => (
              <li key={st.title} className="flex min-h-8 items-center gap-3 text-sm">
                <StepMarker state={st.state} n={i + 1} />
                <span className={cn('min-w-0 flex-1', st.state === 'queued' ? 'text-tertiary' : 'text-fg')}>{st.title}</span>
                <span className="font-mono text-caption text-tertiary tnum">{st.time}</span>
              </li>
            ))}
          </ol>
        </Section>
        <Section label="Risks">
          <Bullets items={PLAN.risks} />
        </Section>
      </div>
    </div>
  )
}
