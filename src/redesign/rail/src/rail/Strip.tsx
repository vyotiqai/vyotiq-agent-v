import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { IconButton, Segmented, StatusGlyph, Tooltip, cn } from '@renderer/lib/ui'
import { base, type Task } from '../data'
import { Lens } from './Lens'
import { ExtensionsSheetBody, HomeSheetBody, BriefSheetBody, SettingsSheetBody, UsageSheetBody } from './places'
import { RecordBody } from './RecordSheet'
import { BrowserSheetBody, ChangesSheetBody, FileSheetBody, FileSheetMeta, FilesSheetBody, PlanSheetBody, PrSheetBody, TerminalSheetBody } from './sheets'
import { PLACE_KINDS, SHEET_ICON, SHEET_NAME, SHELF, SNAPS, SNAP_LABEL, frameScale, taskById, useRail, type Sheet, type SheetKind } from './store'

/*
  The rail. Sheets stand side by side at a fraction of the work area's
  width. Nothing ever scrolls off: a sheet that doesn't fit folds into a
  spine at the edge — a narrow column with its name running up it — and one
  click on the spine brings it back. The lit sheet is the one you are in;
  the lens slides along under it.

  At the right edge, the shelf opens the sheets a task can have (the old
  inspector's tabs). Drag the edge between two sheets and it snaps to
  ⅓ · ½ · ⅔ · full, with guides while you drag.
*/

const SPINE = 36
const SHELF_W = 44
const SNAP_PX = 28
const MIN_SHEET = 320

type Slot = { sheet: Sheet; kind: 'sheet' | 'spine'; left: number; width: number; last: boolean }

/** Which sheets stand open around the lit one; the rest fold into spines. */
function layout(sheets: Sheet[], focus: string, W: number): Slot[] {
  const n = sheets.length
  const fi = Math.max(0, sheets.findIndex((x) => x.id === focus))
  const want = (sh: Sheet): number => Math.max(MIN_SHEET, sh.frac * W)
  const fits = (a: number, b: number): boolean => {
    let open = 0
    for (let i = a; i <= b; i++) open += want(sheets[i])
    return open + SPINE * (n - (b - a + 1)) <= W + 1
  }
  let a = fi
  let b = fi
  for (;;) {
    if (b + 1 < n && fits(a, b + 1)) b++
    else if (a - 1 >= 0 && fits(a - 1, b)) a--
    else break
  }
  const room = W - (n - (b - a + 1)) * SPINE
  const slots: Slot[] = []
  let x = 0
  let used = 0
  for (let i = 0; i < n; i++) {
    const sh = sheets[i]
    if (i < a || i > b) {
      slots.push({ sheet: sh, kind: 'spine', left: x, width: SPINE, last: false })
      x += SPINE
      continue
    }
    // Sheets keep their fraction; the last open one takes what is left.
    const w = Math.min(room - used, i === b ? room - used : Math.round(want(sh)))
    used += w
    slots.push({ sheet: sh, kind: 'sheet', left: x, width: w, last: i === b })
    x += w
  }
  return slots
}

function Gauge({ frac }: { frac: number }) {
  return (
    <svg width="16" height="11" viewBox="0 0 16 11" aria-hidden>
      <rect x="0.5" y="0.5" width="15" height="10" rx="1.5" fill="none" stroke="currentColor" />
      <rect x="2" y="2" width={Math.max(1.5, 12 * frac)} height="7" rx="0.5" fill="currentColor" />
    </svg>
  )
}

function WidthGauge({ sheet }: { sheet: Sheet }) {
  const { d } = useRail()
  return (
    <div role="radiogroup" aria-label="Sheet width" className="flex items-center gap-px">
      {SNAPS.map((f, i) => {
        const on = Math.abs(sheet.frac - f) < 0.01
        return (
          <Tooltip key={f} content={`${SNAP_LABEL[i]} width · Alt+[ ]`}>
            <button
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`${SNAP_LABEL[i]} width`}
              onClick={() => d({ type: 'width', id: sheet.id, frac: f })}
              className={cn(
                'grid size-6 place-items-center rounded-md vy-transition focus-visible:vy-focus-ring',
                on ? 'bg-surface-2 text-fg-strong' : 'text-tertiary hover:bg-surface hover:text-secondary'
              )}
            >
              <Gauge frac={f} />
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}

type Ctx = { task: Task; width: number; range: '7' | '30'; setRange: (r: '7' | '30') => void }
type Described = { lead: ReactNode; title: string; meta?: ReactNode; actions?: ReactNode; body: ReactNode; live: boolean }

function describe(sheet: Sheet, { task, width, range, setRange }: Ctx): Described {
  const icon = <Icon name={SHEET_ICON[sheet.kind]} size={14} className="shrink-0 text-muted" />
  const plain = (body: ReactNode, meta?: ReactNode, live = false): Described => ({ lead: icon, title: SHEET_NAME[sheet.kind], meta, body, live })
  const count = (n: number): ReactNode => <span className="font-mono text-caption text-tertiary tnum">{n}</span>
  switch (sheet.kind) {
    case 'record':
      return {
        lead: <StatusGlyph state={task.state} size={14} label />,
        title: task.title,
        meta: (
          <span className="flex shrink-[4] items-center gap-2 truncate font-mono text-caption text-tertiary">
            <span>main</span>
            {task.elapsed ? <span className="tnum">{task.elapsed}</span> : null}
          </span>
        ),
        body: <RecordBody key={task.id} task={task} />,
        live: task.state === 'running'
      }
    case 'brief':
      return plain(
        <BriefSheetBody />,
        <span className="min-w-0 shrink-[4] truncate text-caption text-tertiary">
          in VYOTIQ – AGENT V · on <span className="font-mono">main</span> · this folder
        </span>
      )
    case 'changes':
      return plain(<ChangesSheetBody key={task.id} task={task} />, count(task.files.length))
    case 'files':
      return plain(<FilesSheetBody task={task} />)
    case 'terminal':
      return plain(<TerminalSheetBody task={task} />, task.state === 'running' ? <span className="vy-text-live text-caption">eslint</span> : null, task.state === 'running')
    case 'browser':
      return plain(<BrowserSheetBody />, <span className="truncate font-mono text-caption text-tertiary">localhost:5173</span>)
    case 'pr':
      return plain(<PrSheetBody key={task.id} task={task} />, task.id === 'composer' ? <span className="font-mono text-caption text-tertiary">draft · 3/5</span> : null)
    case 'plan':
      return plain(<PlanSheetBody task={task} />)
    case 'file':
      return { lead: icon, title: base(sheet.path ?? ''), meta: <FileSheetMeta path={sheet.path ?? ''} />, body: <FileSheetBody path={sheet.path ?? ''} />, live: false }
    case 'home':
      return plain(<HomeSheetBody />, <span className="text-caption text-tertiary">Wednesday 30 September</span>)
    case 'usage':
      return {
        ...plain(<UsageSheetBody range={range} />, <span className="text-caption text-tertiary">All workspaces</span>),
        actions: <Segmented label="Range" value={range} onChange={setRange} items={[{ id: '7', label: '7 days' }, { id: '30', label: '30 days' }]} />
      }
    case 'extensions':
      return plain(<ExtensionsSheetBody />, count(5))
    case 'settings':
      return plain(<SettingsSheetBody narrow={width < 560} />)
  }
}

/** A folded sheet: its name runs up a narrow column. */
function Spine({ slot, ctx }: { slot: Slot; ctx: Ctx }) {
  const { d } = useRail()
  const x = describe(slot.sheet, ctx)
  return (
    <Tooltip content={`${x.title} · Alt+← →`}>
      <button
        type="button"
        onClick={() => d({ type: 'focus', id: slot.sheet.id })}
        aria-label={`Open ${x.title}`}
        className="rail-slot group absolute inset-y-0 flex flex-col items-center gap-3 border-l border-border bg-chrome pt-3 hover:bg-surface focus-visible:vy-focus-ring"
        style={{ left: slot.left, width: slot.width }}
      >
        <Icon name={SHEET_ICON[slot.sheet.kind]} size={14} className="shrink-0 text-muted group-hover:text-fg-strong" />
        {x.live ? <span className="size-1.5 shrink-0 rounded-full bg-accent rail-live" aria-label="live" /> : null}
        <span className="min-h-0 truncate text-xs font-medium text-secondary [writing-mode:vertical-rl] group-hover:text-fg-strong">{x.title}</span>
      </button>
    </Tooltip>
  )
}

function SheetFrame({ slot, pad, ctx, onResize }: { slot: Slot; pad: number; ctx: Ctx; onResize: (e: PointerEvent<HTMLSpanElement>, slot: Slot) => void }) {
  const { s, d } = useRail()
  const sheet = slot.sheet
  const lit = s.focus === sheet.id
  const x = describe(sheet, { ...ctx, width: slot.width })
  const closable = s.sheets.length > 1 && sheet.kind !== 'record'
  return (
    <section
      data-sheet={sheet.id}
      aria-label={x.title}
      aria-current={lit || undefined}
      onPointerDownCapture={() => d({ type: 'focus', id: sheet.id })}
      onFocusCapture={() => d({ type: 'focus', id: sheet.id })}
      className={cn('rail-slot absolute inset-y-0 flex flex-col border-l border-border', lit ? 'bg-bg' : 'sheet-recessed')}
      style={{ left: slot.left, width: slot.width }}
    >
      <span aria-hidden className={cn('pointer-events-none absolute inset-x-0 top-0 z-[2] h-0.5 vy-transition', lit ? 'bg-accent' : 'bg-transparent')} />
      <header
        className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2"
        onDoubleClick={() => d({ type: 'width', id: sheet.id, frac: sheet.frac > 0.99 ? 2 / 3 : 1 })}
      >
        {x.lead}
        <span className={cn('truncate text-sm font-medium', sheet.kind === 'record' ? 'min-w-0 shrink' : 'shrink-0', lit ? 'text-fg-strong' : 'text-secondary')}>{x.title}</span>
        {x.meta}
        <span className="min-w-2 flex-1" />
        {x.actions}
        {lit && s.sheets.length > 1 && slot.width > 460 ? <WidthGauge sheet={sheet} /> : null}
        {closable ? <IconButton icon="close" size="sm" tone="muted" label="Close sheet (Alt+W)" onClick={() => d({ type: 'close', id: sheet.id })} /> : null}
      </header>
      <div className="rail-pad flex min-h-0 flex-1 flex-col" style={{ paddingBottom: pad }}>
        {x.body}
      </div>
      {slot.last ? null : (
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${x.title}`}
          onPointerDown={(e) => onResize(e, slot)}
          className="group absolute -right-[5px] top-0 z-[3] flex h-full w-[9px] cursor-col-resize justify-center"
        >
          <span className="h-full w-0.5 bg-transparent vy-transition group-hover:bg-border-strong" />
        </span>
      )}
    </section>
  )
}

/** The old inspector's tabs as a column of doors at the rail's right edge. */
function Shelf({ task }: { task: Task }) {
  const { s, d } = useRail()
  const note: Partial<Record<SheetKind, string>> = {
    changes: task.files.length ? String(task.files.length) : undefined,
    terminal: task.state === 'running' ? 'live' : undefined,
    pr: task.id === 'composer' ? '3/5' : undefined
  }
  const item = (kind: SheetKind): ReactNode => {
    const open = s.sheets.find((x) => x.kind === kind)
    const lit = open?.id === s.focus
    return (
      <Tooltip key={kind} content={SHEET_NAME[kind]}>
        <button
          type="button"
          aria-label={`${SHEET_NAME[kind]}${note[kind] ? `, ${note[kind]}` : ''}`}
          aria-pressed={Boolean(open)}
          onClick={() => d({ type: 'open', kind })}
          className={cn(
            'relative grid size-8 place-items-center rounded-md vy-transition focus-visible:vy-focus-ring',
            lit ? 'bg-surface-2 text-fg-strong' : open ? 'text-fg hover:bg-surface' : 'text-muted hover:bg-surface hover:text-fg'
          )}
        >
          <Icon name={SHEET_ICON[kind]} size={16} />
          {kind === 'terminal' && task.state === 'running' ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-accent rail-live" /> : null}
          {open ? <span className={cn('absolute -left-[6px] top-2 h-4 w-0.5 rounded-full', lit ? 'bg-accent' : 'bg-border-strong')} aria-hidden /> : null}
        </button>
      </Tooltip>
    )
  }
  return (
    <nav aria-label="Open a sheet" className="flex shrink-0 flex-col items-center gap-1 border-l border-border bg-chrome pt-1.5" style={{ width: SHELF_W }}>
      {SHELF.map(item)}
    </nav>
  )
}

export function Strip() {
  const { s, d, root } = useRail()
  const ref = useRef<HTMLDivElement>(null)
  const plate = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(1132)
  const [plateH, setPlateH] = useState(0)
  const [guide, setGuide] = useState<{ left: number; at: number } | null>(null)
  const [range, setRange] = useState<'7' | '30'>('7')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(id)
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])


  const task = taskById(s.taskId)
  const ctx: Ctx = { task, width: 0, range, setRange }
  const slots = layout(s.sheets, s.focus, W)
  const lit = slots.find((x) => x.sheet.id === s.focus && x.kind === 'sheet')
  const showLens = Boolean(lit && !PLACE_KINDS.includes(lit.sheet.kind) && s.place === 'task')
  const plateW = lit ? Math.min(lit.width - 24, 780) : 0
  const plateLeft = lit ? lit.left + (lit.width - plateW) / 2 : 0

  useLayoutEffect(() => {
    const el = plate.current
    if (!el) return setPlateH(0)
    const ro = new ResizeObserver(() => setPlateH(el.offsetHeight))
    ro.observe(el)
    setPlateH(el.offsetHeight)
    return () => ro.disconnect()
  }, [showLens, s.focus])

  function onResize(e: PointerEvent<HTMLSpanElement>, slot: Slot): void {
    e.preventDefault()
    e.stopPropagation()
    const frame = root()
    const k = frame ? frameScale(frame) : 1
    const x0 = e.clientX
    const f0 = slot.width / W
    let frac = f0
    const move = (ev: globalThis.PointerEvent): void => {
      frac = Math.max(MIN_SHEET / W, Math.min(1, f0 + (ev.clientX - x0) / k / W))
      d({ type: 'width', id: slot.sheet.id, frac })
      setGuide({ left: slot.left, at: frac * W })
    }
    const up = (): void => {
      const hit = SNAPS.find((f) => Math.abs(f * W - frac * W) <= SNAP_PX)
      if (hit) d({ type: 'width', id: slot.sheet.id, frac: hit })
      setGuide(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    setGuide({ left: slot.left, at: f0 * W })
  }

  return (
    <div className="flex min-w-0 flex-1">
      <div ref={ref} className={cn('relative min-w-0 flex-1 overflow-hidden', ready ? 'rail-ready' : '', guide ? 'rail-dragging' : '')}>
        {slots.map((slot) =>
          slot.kind === 'spine' ? (
            <Spine key={slot.sheet.id} slot={slot} ctx={ctx} />
          ) : (
            <SheetFrame key={slot.sheet.id} slot={slot} ctx={ctx} pad={slot.sheet.id === s.focus && showLens ? plateH + 20 : 0} onResize={onResize} />
          )
        )}

        {showLens && lit ? (
          <div ref={plate} className="rail-plate absolute bottom-3 z-[5]" style={{ left: plateLeft, width: plateW }} role="region" aria-label={`Lens, on ${SHEET_NAME[lit.sheet.kind]}`}>
            <Lens task={task} target={lit.sheet} narrow={plateW < 700} tiny={plateW < 460} />
          </div>
        ) : null}

        {guide ? (
          <div className="pointer-events-none absolute inset-y-0 z-[6]" style={{ left: guide.left, width: W - guide.left }} aria-hidden>
            {SNAPS.map((f, i) => {
              const near = Math.abs(f * W - guide.at) <= SNAP_PX
              if (guide.left + f * W > W) return null
              return (
                <div key={f} className="absolute inset-y-0" style={{ left: f * W - 1 }}>
                  <div className={cn('h-full w-px', near ? 'bg-accent' : 'bg-border-strong')} />
                  <span
                    className={cn(
                      'absolute top-12 -translate-x-1/2 rounded-sm px-1.5 py-0.5 font-mono text-xs',
                      near ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-secondary'
                    )}
                  >
                    {SNAP_LABEL[i]}
                  </span>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
      {s.place === 'task' ? <Shelf task={task} /> : null}
    </div>
  )
}
