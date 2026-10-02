import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { Button, IconButton, Pie, Tooltip, cn, type TaskState } from '@renderer/lib/ui'
import { MENU_LABEL, MENU_ROW, MENU_ROW_ACTIVE, MENU_ROW_IDLE, MENU_ROW_SELECTED, MENU_ROW_TEXT, MENU_SURFACE } from '@renderer/lib/ui/menuStyles'
import { FILE_TREE, base, dir, type Task } from '../data'
import { SHEET_ICON, SHEET_NAME, useRail, type Sheet, type TrayItem } from './store'

/*
  The lens — the composer, rebuilt as an instrument rather than a text box.

  · Its top edge is the run itself: one segment per step. Type while the run
    works and a notch shows exactly where your words will land.
  · Context is a tray of real objects (files, folders, quoted lines, terminal
    output) pinned from anywhere in the app, not text you have to describe.
  · Model and effort are one control: drag, scroll or arrow the five bars and
    the estimate beside them moves with you.
  · Start a line with ? and it becomes a question: reads only, changes nothing.
*/

const EFFORT = ['Low', 'Med', 'High', 'XHigh', 'Max'] as const
const ESTIMATE = ['~2 min', '~4 min', '~7 min', '~11 min', '~16 min'] as const
const DEFAULT_EFFORT = 4
const MODELS = [
  { id: 'space-bunny-free', note: '1M · free' },
  { id: 'deepseek-v4-pro', note: '1M' },
  { id: 'glm-5.3', note: '1M · $1.40' },
  { id: 'grok-4.7', note: '500k' }
] as const

const FOLDERS = ['src/renderer/src/features/chat/components/composer', 'tests/renderer/composer'] as const

const SEG: Record<TaskState, string> = {
  done: 'bg-muted',
  review: 'bg-muted',
  running: 'bg-accent rail-live',
  needs: 'bg-accent',
  queued: 'bg-border-strong',
  failed: 'bg-danger',
  stopped: 'bg-border-strong',
  paused: 'bg-border-strong'
}

const TRAY_ICON: Record<TrayItem['kind'], IconName> = { file: 'file', folder: 'folder', quote: 'note', terminal: 'terminal' }

function shortStep(title: string): string {
  const t = title.replace(/^(Find|Redesign|Verify:|Report|Create|Update|Run|Read|Keep)\s+/i, '')
  return t.length > 26 ? t.slice(0, 25) + '…' : t
}

/** The run, drawn as the lens's top edge. */
function RunStrip({ task, landing, labels }: { task: Task; landing: 'steer' | 'queue' | null; labels: boolean }) {
  const steps = task.steps
  if (steps.length === 0) return <div className="h-px bg-border" />
  const live = steps.findIndex((st) => st.state === 'running' || st.state === 'needs')
  const boundary = landing === 'queue' || live < 0 ? steps.length : live + 1
  const pct = (boundary / steps.length) * 100
  const said = steps.map((st, i) => `${i + 1} ${st.title}: ${st.state}`).join('; ')
  return (
    <div className="relative">
      <div className="flex h-[3px] gap-[2px] overflow-hidden rounded-t-[var(--vy-radius-xl)]" role="img" aria-label={`Run: ${said}`}>
        {steps.map((st, i) => (
          <span key={i} className={cn('h-full flex-1', SEG[st.state])} />
        ))}
      </div>
      {labels ? (
        <div className="flex gap-[2px] px-0" aria-hidden>
          {steps.map((st, i) => (
            <span
              key={i}
              className={cn(
                'min-w-0 flex-1 truncate px-2 pt-1 font-mono text-caption',
                st.state === 'running' || st.state === 'needs' ? 'text-fg-strong' : 'text-tertiary'
              )}
            >
              {i + 1} {shortStep(st.title)}
            </span>
          ))}
        </div>
      ) : null}
      {landing ? (
        <span
          key={`${landing}-${boundary}`}
          className="rail-notch pointer-events-none absolute top-0 z-[1]"
          style={{ left: `${pct}%` }}
          aria-hidden
        >
          <span
            className={cn(
              'absolute top-[-1px] flex h-4 items-center rounded-b-sm bg-fg-strong px-1.5 font-mono text-2xs font-semibold text-bg',
              boundary === steps.length ? '-translate-x-full' : '-translate-x-1/2'
            )}
          >
            you
          </span>
        </span>
      ) : null}
    </div>
  )
}

function TrayChip({ item }: { item: TrayItem }) {
  const { d } = useRail()
  return (
    <span className="inline-flex h-7 max-w-[300px] items-center gap-1.5 rounded-md border border-border bg-card pl-2 pr-0.5 text-xs">
      <Icon name={TRAY_ICON[item.kind]} size={13} className="shrink-0 text-muted" />
      <span className="shrink-0 font-medium text-fg">{item.label}</span>
      {item.detail ? <span className="min-w-0 truncate font-mono text-caption text-tertiary">{item.detail}</span> : null}
      <IconButton icon="close" size="xs" tone="muted" label={`Remove ${item.label}`} onClick={() => d({ type: 'unpin', id: item.id })} />
    </span>
  )
}

/** Model and effort as one instrument. */
function ModelEffort({
  effort,
  setEffort,
  model,
  setModel,
  compact = false,
  tiny = false
}: {
  effort: number
  setEffort: (n: number) => void
  model: string
  setModel: (m: string) => void
  compact?: boolean
  tiny?: boolean
}) {
  const [menu, setMenu] = useState(false)
  const bars = useRef<HTMLSpanElement>(null)
  const dragging = useRef(false)
  const clamp = (n: number): number => Math.max(0, Math.min(4, n))
  const pickAt = (clientX: number): void => {
    const r = bars.current?.getBoundingClientRect()
    if (!r) return
    setEffort(clamp(Math.floor(((clientX - r.left) / r.width) * 5)))
  }
  const onDown = (e: PointerEvent<HTMLSpanElement>): void => {
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    pickAt(e.clientX)
  }
  const changed = effort !== DEFAULT_EFFORT
  return (
    <div className="relative flex items-center">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu(!menu)}
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-fg vy-transition hover:bg-surface focus-visible:vy-focus-ring"
      >
        <Icon name="model" size={13} className="text-muted" />
        {tiny ? <span className="sr-only">{model}</span> : <span className={compact ? 'max-w-[92px] truncate' : ''}>{model}</span>}
      </button>
      <Tooltip content="Effort: drag, scroll, or use ← →">
        <span
          ref={bars}
          role="slider"
          tabIndex={0}
          aria-label="Effort"
          aria-valuemin={0}
          aria-valuemax={4}
          aria-valuenow={effort}
          aria-valuetext={`${EFFORT[effort]}, about ${ESTIMATE[effort].slice(1)}`}
          onPointerDown={onDown}
          onPointerMove={(e) => (dragging.current ? pickAt(e.clientX) : undefined)}
          onPointerUp={() => (dragging.current = false)}
          onWheel={(e) => setEffort(clamp(effort + (e.deltaY < 0 ? 1 : -1)))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp') (e.preventDefault(), setEffort(clamp(effort + 1)))
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') (e.preventDefault(), setEffort(clamp(effort - 1)))
          }}
          className="flex h-7 w-[46px] cursor-ew-resize touch-none items-end justify-center gap-[3px] rounded-md pb-[8px] vy-transition hover:bg-surface focus-visible:vy-focus-ring"
        >
          {EFFORT.map((_, i) => (
            <span key={i} className={cn('w-[4px] rounded-[1px] vy-transition', i <= effort ? 'bg-fg-strong' : 'bg-border-strong')} style={{ height: 4 + i * 2.5 }} />
          ))}
        </span>
      </Tooltip>
      {compact ? null : (
        <span className={cn('w-[92px] pl-1 font-mono text-caption tnum', changed ? 'text-fg' : 'text-tertiary')}>
          {EFFORT[effort]} {ESTIMATE[effort]}
        </span>
      )}
      {menu ? (
        <div role="menu" aria-label="Model" className={cn(MENU_SURFACE, 'absolute bottom-full left-0 mb-2 w-[260px] p-1')}>
          <div className={MENU_LABEL}>OpenCode Go</div>
          {MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={m.id === model}
              onClick={() => (setModel(m.id), setMenu(false))}
              className={cn(MENU_ROW, MENU_ROW_IDLE, m.id === model ? MENU_ROW_SELECTED : MENU_ROW_TEXT)}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{m.id}</span>
              <span className="font-mono text-caption text-tertiary">{m.note}</span>
              {m.id === model ? <Icon name="check" size={13} /> : <span className="w-[13px]" />}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

type AtMatch = { start: number; query: string }

function useAtMatch(text: string, caret: number): AtMatch | null {
  return useMemo(() => {
    const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))
    return m ? { start: caret - m[2].length - 1, query: m[2].toLowerCase() } : null
  }, [text, caret])
}

const BRIEF_PREFILL =
  'Redesign both the / and @ menus in the composer. Files and folders can’t be picked from @ at all. Make them clean and organized, and make sure they fit the window at any size.'

const PLACEHOLDER: Partial<Record<Sheet['kind'], string>> = {
  terminal: 'Ask about this output, or start with $ to run a command',
  files: 'Ask about the project, or type @ to pick files',
  browser: 'Ask about this page, or what to check next',
  pr: 'Ask for a change to the pull request',
  plan: 'Change the plan before the next step'
}

export function Lens({
  task,
  variant = 'line',
  target,
  narrow = false,
  tiny = false
}: {
  task: Task
  variant?: 'line' | 'brief'
  target?: Sheet
  /** Under 700px: no hint, no context meter, no attach, a shorter model name. */
  narrow?: boolean
  /** Under 460px (a ⅓ sheet): effort bars only, no mic, one send button. */
  tiny?: boolean
}) {
  const { s, d } = useRail()
  const [text, setText] = useState(variant === 'brief' ? BRIEF_PREFILL : '')
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const [effort, setEffort] = useState(DEFAULT_EFFORT)
  const [model, setModel] = useState('space-bunny-free')
  const [queueHover, setQueueHover] = useState(false)
  const [menuIdx, setMenuIdx] = useState(0)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const ta = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (s.lensNonce > 0) ta.current?.focus()
  }, [s.lensNonce])

  const at = useAtMatch(text, caret)
  const items = useMemo(() => {
    if (!at) return []
    const q = at.query
    const folders = FOLDERS.filter((p) => p.toLowerCase().includes(q)).map((p) => ({ path: p, kind: 'folder' as const }))
    const files = FILE_TREE.filter((p) => p.toLowerCase().includes(q)).map((p) => ({ path: p, kind: 'file' as const }))
    return [...folders, ...files].slice(0, 7)
  }, [at])
  const menuOpen = Boolean(at && focused && items.length > 0 && dismissed !== at.start)

  const ask = text.trimStart().startsWith('?')
  const shell = target?.kind === 'terminal' && text.trimStart().startsWith('$')
  const running = task.state === 'running' || task.state === 'needs'
  const has = text.trim().length > 0 || s.tray.length > 0
  const landing = variant === 'line' && running && has && !ask && !shell ? (queueHover ? 'queue' : 'steer') : null
  const live = task.steps.findIndex((st) => st.state === 'running' || st.state === 'needs')

  const hint = shell
    ? 'Runs in the task’s shell, now'
    : ask
    ? 'Ask · reads only, changes nothing'
    : variant === 'brief'
      ? 'Type @ to add files · ? to ask instead'
      : !running
        ? 'Starts run 2 from this record'
        : !has
          ? `Step ${live + 1} of ${task.steps.length} · ${task.elapsed}`
          : landing === 'queue'
            ? 'Runs after the task'
            : task.state === 'needs'
              ? 'Lands with your answer'
              : `Lands after step ${live + 1}`

  const targetName = !target ? '' : target.kind === 'file' ? base(target.path ?? '') : target.kind === 'record' ? 'the record' : SHEET_NAME[target.kind]
  const placeholder =
    variant === 'brief'
      ? 'Describe the outcome. I plan it, do it, and show you proof.'
      : target?.kind === 'file'
        ? `Change or ask about ${targetName}`
        : target?.kind === 'changes'
          ? `Ask for a change to these ${task.files.length} files`
          : target && PLACEHOLDER[target.kind]
            ? (PLACEHOLDER[target.kind] as string)
            : running
              ? 'Steer the run, or start with ? to ask'
              : 'Follow up, or start with ? to ask'

  function pick(i: number): void {
    const it = items[i]
    if (!it || !at) return
    const next = text.slice(0, at.start) + text.slice(caret)
    setText(next)
    setCaret(at.start)
    d({ type: 'pin', item: { kind: it.kind, label: base(it.path) + (it.kind === 'folder' ? '/' : ''), detail: it.kind === 'folder' ? `${12 - i} entries` : dir(it.path).split('/').slice(-2).join('/') } })
    requestAnimationFrame(() => ta.current?.setSelectionRange(at.start, at.start))
  }

  function send(mode: 'steer' | 'queue'): void {
    if (!has) return
    if (shell) {
      d({ type: 'send', text: text.trim().replace(/^\$\s*/, ''), mode: 'run', target: 'Terminal' })
      setText('')
      setCaret(0)
      return
    }
    d({ type: 'send', text: text.replace(/^\s*\?\s*/, '').trim() || 'Look at these', mode: ask ? 'ask' : mode, target: target && target.kind !== 'record' ? targetName : undefined })
    setText('')
    setCaret(0)
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (menuOpen) {
      if (e.key === 'ArrowDown') return e.preventDefault(), setMenuIdx((menuIdx + 1) % items.length)
      if (e.key === 'ArrowUp') return e.preventDefault(), setMenuIdx((menuIdx - 1 + items.length) % items.length)
      if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), pick(menuIdx)
      if (e.key === 'Escape') return e.preventDefault(), setDismissed(at?.start ?? null)
    }
    if (e.key === 'Enter' && !e.shiftKey && variant === 'line') {
      e.preventDefault()
      send(e.ctrlKey || e.metaKey ? 'queue' : 'steer')
    }
    if (e.key === 'Escape') ta.current?.blur()
  }

  const track = (): void => setCaret(ta.current?.selectionStart ?? 0)

  const menu = menuOpen ? (
    <div role="listbox" aria-label="Files and folders" className={cn(MENU_SURFACE, 'absolute bottom-full left-2 z-dropdown mb-2 w-[440px] p-1')}>
      <div className={MENU_LABEL}>
        <span>Files and folders</span>
        <span className="font-mono font-normal normal-case tracking-normal">↑↓ ↵</span>
      </div>
      {items.map((it, i) => (
        <button
          key={it.path}
          type="button"
          role="option"
          aria-selected={i === menuIdx}
          onPointerEnter={() => setMenuIdx(i)}
          onPointerDown={(e) => (e.preventDefault(), pick(i))}
          className={cn(MENU_ROW, i === menuIdx ? MENU_ROW_ACTIVE : MENU_ROW_IDLE, MENU_ROW_TEXT)}
        >
          <Icon name={it.kind === 'folder' ? 'folder' : 'file'} size={14} className="shrink-0 text-muted" />
          <span className="shrink-0">{base(it.path)}{it.kind === 'folder' ? '/' : ''}</span>
          <span className="min-w-0 flex-1 truncate text-right font-mono text-caption text-tertiary" dir="rtl">
            {dir(it.path)}
          </span>
        </button>
      ))}
    </div>
  ) : null

  const field = (
    <textarea
      ref={ta}
      value={text}
      rows={variant === 'brief' ? 5 : focused || text.includes('\n') ? 3 : 1}
      placeholder={placeholder}
      aria-label={variant === 'brief' ? 'Brief' : 'Instruction'}
      onChange={(e) => (setText(e.target.value), setCaret(e.target.selectionStart), setMenuIdx(0))}
      onSelect={track}
      onKeyDown={onKey}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      className={cn(
        'block w-full resize-none bg-transparent text-fg-strong outline-none placeholder:text-tertiary',
        variant === 'brief' ? 'text-md' : 'text-sm'
      )}
    />
  )

  const controls = (
    <div className="flex h-10 items-center gap-1 px-2">
      <Tooltip content="Start a line with ? to ask without changes">
        <button
          type="button"
          aria-pressed={ask}
          onClick={() => {
            const next = ask ? text.replace(/^\s*\?\s*/, '') : `? ${text}`
            setText(next)
            ta.current?.focus()
          }}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium vy-transition focus-visible:vy-focus-ring',
            ask ? 'bg-accent-soft text-accent' : 'text-secondary hover:bg-surface'
          )}
        >
          <Icon name={ask ? 'question' : 'bot'} size={13} />
          {ask ? 'Ask' : 'Agent'}
        </button>
      </Tooltip>
      <ModelEffort effort={effort} setEffort={setEffort} model={model} setModel={setModel} compact={narrow} tiny={tiny} />
      <span className={cn('min-w-0 flex-1 truncate px-2 text-caption', landing || ask ? 'text-fg' : 'text-tertiary')} aria-live="polite">
        {narrow ? '' : hint}
      </span>
      {variant === 'line' && !narrow ? (
        <Tooltip content="Context: 212k of 891k">
          <span className="flex h-7 items-center gap-1.5 px-1.5 font-mono text-caption text-tertiary tnum">
            <Pie value={0.24} size={14} />
            24%
          </span>
        </Tooltip>
      ) : null}
      {narrow ? null : <IconButton icon="paperclip" label="Attach" size="md" tone="muted" />}
      {tiny ? null : <IconButton icon="mic" label="Dictate (Ctrl+M)" size="md" tone="muted" />}
      {variant === 'line' ? (
        running && !ask && !shell && !tiny ? (
          <span className="ml-1 flex items-center gap-1">
            <Tooltip content="Ctrl+Enter · runs after this task">
              <span onPointerEnter={() => setQueueHover(true)} onPointerLeave={() => setQueueHover(false)} onFocus={() => setQueueHover(true)} onBlur={() => setQueueHover(false)}>
                <Button variant="ghost" size="sm" disabled={!has} onClick={() => send('queue')}>
                  Queue
                </Button>
              </span>
            </Tooltip>
            <Tooltip content="Enter · lands between steps">
              <span>
                <Button variant={has ? 'primary' : 'secondary'} size="sm" icon="send" disabled={!has} onClick={() => send('steer')}>
                  Steer
                </Button>
              </span>
            </Tooltip>
          </span>
        ) : (
          <Button variant={has ? 'primary' : 'secondary'} size="sm" icon="send" disabled={!has} onClick={() => send('steer')} className="ml-1">
            {shell ? 'Run' : ask ? 'Ask' : running ? 'Steer' : 'Send'}
          </Button>
        )
      ) : null}
    </div>
  )

  const tray = s.tray.length > 0 ? (
    <div className="flex flex-wrap gap-1.5 px-3 pt-2.5" aria-label="Context">
      {s.tray.map((t) => (
        <TrayChip key={t.id} item={t} />
      ))}
    </div>
  ) : null

  if (variant === 'brief') {
    return (
      <div className="relative rounded-lg border border-border bg-bg vy-transition focus-within:border-border-strong">
        {menu}
        {tray}
        <div className="px-3 pb-1 pt-3">{field}</div>
        {controls}
      </div>
    )
  }

  return (
    <div className="vy-menu relative">
      {menu}
      <RunStrip task={task} landing={landing} labels={!narrow && (focused || has)} />
      {tray}
      <div className={cn('flex items-start gap-2 px-3', s.tray.length > 0 ? 'pt-2' : 'pt-3')}>
        {target ? (
          <Tooltip content={`Looking at ${target.kind === 'record' ? 'the record' : targetName} · Alt+← → moves it`}>
            <span className="mt-px flex h-5 shrink-0 items-center gap-1 rounded-sm bg-surface px-1.5 text-caption text-secondary">
              <Icon name={SHEET_ICON[target.kind]} size={12} className="text-muted" />
              <span className="max-w-[140px] truncate">{target.kind === 'record' ? 'Record' : targetName}</span>
            </span>
          </Tooltip>
        ) : null}
        <div className="min-w-0 flex-1">{field}</div>
      </div>
      {controls}
    </div>
  )
}
