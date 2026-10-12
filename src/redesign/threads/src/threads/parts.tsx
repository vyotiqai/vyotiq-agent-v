import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { Button, DiffStat, IconButton, Pie, Segmented, StatusGlyph, Tooltip, cn } from '@renderer/lib/ui'
import { QUESTION_GATE_BODY, QUESTION_GATE_FOOTER, QUESTION_GATE_HEADER, QUESTION_GATE_SURFACE, ROW_HOVER } from '@renderer/lib/utils/layout'
import { Markdown, plainMarkdown } from './markdown'
import { EFFORT, MODEL, type Check, type DiffLine, type FileChange, type Step, type Turn, type Work } from './data'

/*
  Pieces every direction shares, so the three differ in structure — where
  things live and what leads — and never in how a diff or a command looks.
  Terminal output and diffs stay in bordered cards in every direction: that
  border is hierarchy, not decoration.
*/

export function fmtSecs(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`
  const m = Math.floor(secs / 60)
  const s = Math.round(secs % 60)
  return s ? `${m}m ${s}s` : `${m}m`
}

export function fmtCost(usd: number): string {
  return `$${usd.toFixed(2)}`
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** "src/middleware/" quiet, "rateLimit.ts" in ink: the name is what you scan for. */
export function Path({ path, className }: { path: string; className?: string }) {
  const cut = path.lastIndexOf('/')
  return (
    <span className={cn('min-w-0 truncate', className)} title={path}>
      {cut >= 0 ? <span className="text-tertiary">{path.slice(0, cut + 1)}</span> : null}
      <span className="text-fg">{path.slice(cut + 1)}</span>
    </span>
  )
}

/* ─── Markdown ─────────────────────────────────────────────────────────── */

/** Plain words of an answer, for one-line previews. */
export const plainText = plainMarkdown

/** The agent's words, through the one renderer every direction shares. */
export function Md({ text, className }: { text: string; className?: string }) {
  return <Markdown text={text} className={className} />
}

/* ─── Cards: commands and diffs keep their border ───────────────────────── */

const CARD = 'overflow-hidden rounded-lg border border-border bg-bg'
const CARD_HEAD = 'flex h-8 min-w-0 items-center gap-2 px-3 text-xs'

export function CommandCard({ w, defaultOpen }: { w: Extract<Work, { kind: 'command' }>; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? (w.live || (w.exit ?? 0) !== 0))
  const lines = w.live ? w.out.slice(0, w.shown ?? w.out.length) : w.out
  const tail = w.live ? lines.slice(-8) : lines
  const failed = !w.live && w.exit != null && w.exit !== 0
  const scroller = useRef<HTMLPreElement>(null)
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }, [lines.length])
  return (
    <div className={CARD} data-card="command">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn(CARD_HEAD, 'w-full text-left focus-visible:vy-focus-ring-inset', ROW_HOVER)}
      >
        <span className="shrink-0 font-mono text-tertiary">$</span>
        <span className="min-w-0 flex-1 truncate font-mono text-fg">{w.cmd}</span>
        {w.live ? (
          <span className="vy-text-live shrink-0">Running</span>
        ) : failed ? (
          <span className="shrink-0 text-danger">exit {w.exit}</span>
        ) : w.exit == null ? (
          <span className="shrink-0 text-tertiary">Stopped</span>
        ) : null}
        {w.secs != null && !w.live ? <span className="shrink-0 font-mono tnum text-caption text-tertiary">{fmtSecs(w.secs)}</span> : null}
        <Icon name="chevron" size={11} className={cn('shrink-0 text-tertiary transition-transform', open ? 'rotate-180' : '')} />
      </button>
      {open && tail.length > 0 ? (
        <pre ref={scroller} className="max-h-[168px] overflow-auto border-t border-border/60 bg-sunken px-3 py-2 font-mono text-caption leading-[18px] text-secondary">
          {tail.map((l, i) => (
            <div key={i} className={cn(/✘|Error|failed/.test(l) ? 'text-danger' : /✓|passed/.test(l) ? 'text-fg' : '')}>
              {l || ' '}
            </div>
          ))}
          {w.live ? <span className="inline-block h-3 w-1.5 translate-y-0.5 bg-muted th-caret" /> : null}
        </pre>
      ) : null}
    </div>
  )
}

function DiffBody({ hunk, created }: { hunk: DiffLine[]; created?: boolean }) {
  return (
    <div className="overflow-x-auto border-t border-border/60 py-1 font-mono text-caption leading-[18px]">
      {hunk.map((l, i) => (
        <div
          key={i}
          className={cn('flex min-w-max pr-3', l.t === '+' && !created ? 'diff-row-add' : l.t === '-' ? 'diff-row-del' : '')}
        >
          <span className={cn('w-6 shrink-0 select-none text-center', l.t === '+' ? 'text-success' : l.t === '-' ? 'text-danger' : 'text-tertiary')}>
            {l.t === ' ' ? '' : l.t === '-' ? '−' : '+'}
          </span>
          <span className="whitespace-pre text-fg">{l.s || ' '}</span>
        </div>
      ))}
    </div>
  )
}

export function DiffCard({ w, defaultOpen = false }: { w: Extract<Work, { kind: 'edit' }>; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen && w.hunk.length > 0)
  return (
    <div className={CARD} data-card="diff" data-path={w.path}>
      <button
        type="button"
        onClick={() => w.hunk.length && setOpen(!open)}
        aria-expanded={w.hunk.length ? open : undefined}
        className={cn(CARD_HEAD, 'w-full text-left focus-visible:vy-focus-ring-inset', w.hunk.length ? ROW_HOVER : 'cursor-default')}
      >
        <Path path={w.path} className="flex-1 font-mono" />
        {w.created ? <span className="shrink-0 text-caption text-tertiary">New</span> : null}
        <DiffStat add={w.add} del={w.del} className="shrink-0" />
        {w.hunk.length ? <Icon name="chevron" size={11} className={cn('shrink-0 text-tertiary transition-transform', open ? 'rotate-180' : '')} /> : <span className="w-[11px]" />}
      </button>
      {open ? <DiffBody hunk={w.hunk} created={w.created} /> : null}
    </div>
  )
}

/* ─── Work, as verb-first lines ─────────────────────────────────────────── */

/** One line for a lookup or a thought; commands and edits become cards. */
export function WorkItem({ w, onAnswer, cardsOpen }: { w: Work; onAnswer?: (c: 'once' | 'always' | 'deny') => void; cardsOpen?: boolean }) {
  switch (w.kind) {
    case 'read':
      return (
        <WorkText verb="Read">
          {w.paths.length === 1 ? <Path path={w.paths[0]} /> : <span className="text-muted">{w.paths.map((p) => p.split('/').pop()).join(', ')}</span>}
        </WorkText>
      )
    case 'search':
      return (
        <WorkText verb="Searched">
          <code className="font-mono text-caption text-fg">{w.query}</code>
          <span className="text-tertiary"> · {plural(w.hits, 'match', 'matches')}</span>
        </WorkText>
      )
    case 'thought':
      return <p className="max-w-[72ch] text-xs leading-[18px] text-tertiary">{w.text.replace(/`/g, '')}</p>
    case 'command':
      return <CommandCard w={w} defaultOpen={cardsOpen} />
    case 'edit':
      return <DiffCard w={w} defaultOpen={cardsOpen} />
    case 'steer':
      return (
        <WorkText verb="You">
          <span className="text-fg">{w.text}</span>
        </WorkText>
      )
    case 'approval':
      return w.answer ? (
        <WorkText verb={w.answer === 'deny' ? 'Denied' : w.answer === 'always' ? 'Always allowed' : 'Allowed once'}>
          <code className="font-mono text-caption text-muted">{w.cmd}</code>
        </WorkText>
      ) : (
        <Approval w={w} onAnswer={onAnswer} />
      )
  }
}

function WorkText({ verb, children }: { verb: string; children: ReactNode }) {
  return (
    <div className="flex h-6 min-w-0 items-center gap-1.5 text-xs">
      <span className="shrink-0 text-secondary">{verb}</span>
      <span className="flex min-w-0 items-center truncate">{children}</span>
    </div>
  )
}

/** How a step's work reads when folded: "3 reads · 1 search · 2 edits". */
export function workCounts(work: Work[]): string {
  const n = { read: 0, search: 0, command: 0, edit: 0 }
  for (const w of work) {
    if (w.kind === 'read') n.read += w.paths.length
    else if (w.kind in n) n[w.kind as keyof typeof n] += 1
  }
  return [
    n.read && plural(n.read, 'file read', 'files read'),
    n.search && plural(n.search, 'search', 'searches'),
    n.command && plural(n.command, 'command'),
    n.edit && plural(n.edit, 'edit')
  ]
    .filter(Boolean)
    .join(' · ')
}

export function turnCounts(turn: Turn): string {
  return workCounts(turn.steps.flatMap((s) => s.work))
}

/* ─── Needs you ──────────────────────────────────────────────────────────── */

export function Approval({
  w,
  onAnswer,
  takeFocus = true
}: {
  w: Extract<Work, { kind: 'approval' }>
  onAnswer?: (c: 'once' | 'always' | 'deny') => void
  /** Take focus when it appears (never while you are typing elsewhere). */
  takeFocus?: boolean
}) {
  const allow = useRef<HTMLButtonElement>(null)
  // Take focus when it appears, unless you are typing: a space meant for the
  // message box must never press Allow.
  useEffect(() => {
    if (!takeFocus) return
    const el = document.activeElement
    const typing = el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type !== 'button') || (el as HTMLElement | null)?.isContentEditable
    if (!typing) allow.current?.focus({ preventScroll: true })
  }, [takeFocus])
  return (
    <section className={QUESTION_GATE_SURFACE} data-needs-you aria-label="Allow this command?">
      <div className={QUESTION_GATE_HEADER}>
        <Icon name="hand" size={13} className="text-accent" />
        <span className="font-medium text-fg-strong">Allow this command?</span>
      </div>
      <div className={cn(QUESTION_GATE_BODY, 'space-y-1.5')}>
        <div className="rounded-md bg-sunken px-2.5 py-1.5 font-mono text-xs text-fg-strong">
          <span className="text-tertiary">$ </span>
          {w.cmd}
        </div>
        <p className="text-xs text-secondary">{w.why}</p>
      </div>
      <div className={QUESTION_GATE_FOOTER}>
        <Button ref={allow} size="sm" variant="primary" onClick={() => onAnswer?.('once')}>
          Allow once
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onAnswer?.('always')}>
          Always allow
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => onAnswer?.('deny')}>
          Deny
        </Button>
      </div>
    </section>
  )
}

/* ─── Results ────────────────────────────────────────────────────────────── */

export function FileRows({ files, max = 6, onOpen }: { files: FileChange[]; max?: number; onOpen?: (path?: string) => void }) {
  const shown = files.slice(0, max)
  const more = files.length - shown.length
  return (
    <ul aria-label="Files changed">
      {shown.map((f) => (
        <li key={f.path}>
          <button
            type="button"
            onClick={() => onOpen?.(f.path)}
            className={cn('group -mx-2 flex h-7 w-[calc(100%+16px)] min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs focus-visible:vy-focus-ring', ROW_HOVER)}
          >
            <Icon name={f.created ? 'fileNew' : 'file'} size={14} className="shrink-0 text-tertiary" />
            <Path path={f.path} className="flex-1" />
            {f.created ? <span className="shrink-0 text-caption text-tertiary">New</span> : null}
            <DiffStat add={f.add} del={f.del} className="shrink-0" />
            <Icon name="chevronRight" size={11} className="shrink-0 text-tertiary opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
          </button>
        </li>
      ))}
      {more > 0 ? (
        <li>
          <button type="button" onClick={() => onOpen?.()} className={cn('-mx-2 flex h-7 w-[calc(100%+16px)] items-center rounded-md px-2 text-xs text-muted focus-visible:vy-focus-ring', ROW_HOVER)}>
            {more} more in Review
          </button>
        </li>
      ) : null}
    </ul>
  )
}

export function CheckGlyph({ state }: { state: Check['state'] }) {
  if (state === 'met') return <Icon name="checkCircle" size={14} weight="fill" className="shrink-0 text-success" />
  if (state === 'unmet') return <Icon name="warningCircle" size={14} weight="fill" className="shrink-0 text-warning" />
  return <span className="inline-grid size-3.5 shrink-0 place-items-center"><span className="size-3 rounded-full border border-dashed border-border-strong" /></span>
}

export function CheckRows({ checks, evidence = true }: { checks: Check[]; evidence?: boolean }) {
  return (
    <ul aria-label="Done when" className="space-y-1">
      {checks.map((c) => (
        <li key={c.text} className="flex items-start gap-2 text-xs">
          <span className="mt-0.5">
            <CheckGlyph state={c.state} />
          </span>
          <span className="min-w-0 flex-1">
            <span className={c.state === 'open' ? 'text-muted' : 'text-fg'}>{c.text}</span>
            <span className="sr-only">{c.state === 'met' ? ' — met' : c.state === 'unmet' ? ' — not met' : ' — not checked yet'}</span>
            {evidence && c.evidence ? <span className="block truncate font-mono text-caption text-tertiary">{c.evidence}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function ErrorBlock({ error, onRetry }: { error: NonNullable<Turn['error']>; onRetry: () => void }) {
  return (
    <section className="rounded-lg bg-danger-soft px-3 py-2.5" aria-label="What went wrong">
      <div className="flex items-start gap-2">
        <Icon name="warningCircle" size={15} weight="fill" className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="text-sm font-medium text-fg-strong">{error.title}</div>
          <p className="text-xs text-secondary">{error.detail}</p>
          <p className="font-mono text-caption text-tertiary">{error.where}</p>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5 pl-[23px]">
        <Button size="sm" variant="secondary" icon="retry" onClick={onRetry}>
          Retry
        </Button>
        <Button size="sm" variant="ghost" onClick={onRetry}>
          Ask it to mock Redis
        </Button>
      </div>
    </section>
  )
}

/* ─── Step glyph ────────────────────────────────────────────────────────── */

export function StepGlyph({ state }: { state: Step['state'] }) {
  if (state === 'queued') return <span className="inline-grid size-3.5 shrink-0 place-items-center"><span className="size-2.5 rounded-full border border-border-strong" /></span>
  if (state === 'done') return <Icon name="check" size={13} className="shrink-0 text-tertiary" />
  return <StatusGlyph state={state === 'stopped' ? 'stopped' : state} size={14} />
}

/* ─── Composer ───────────────────────────────────────────────────────────── */

export type ComposerProps = {
  live: boolean
  placeholder: string
  onSend: (text: string, mode: 'agent' | 'ask') => void
  /** Focus on mount: a new thread starts in the box. */
  focusOnMount?: boolean
  className?: string
  /** The box's minimum height in rows of text. */
  rows?: number
}

/**
 * One anatomy: the field, then one control row — mode, model · effort,
 * context, attach, and the labelled action. Stop is not here: it lives in
 * the thread header, beside what it stops.
 */
export function Composer({ live, placeholder, onSend, focusOnMount, className, rows = 1 }: ComposerProps) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'agent' | 'ask'>('agent')
  const field = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])
  useEffect(() => {
    if (focusOnMount) field.current?.focus()
  }, [focusOnMount])
  const send = (): void => {
    if (!text.trim()) return
    onSend(text, mode)
    setText('')
  }
  return (
    <div
      className={cn('rounded-xl border border-border bg-bg transition-colors focus-within:border-border-strong', className)}
      data-composer
    >
      <textarea
        ref={field}
        value={text}
        rows={rows}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
          if (e.key === 'Tab' && e.shiftKey && !text) {
            e.preventDefault()
            setMode(mode === 'agent' ? 'ask' : 'agent')
          }
        }}
        placeholder={placeholder}
        aria-label="Message"
        className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm leading-[20px] text-fg-strong outline-none placeholder:text-tertiary"
      />
      <div className="flex items-center gap-1 px-2 pb-2 pt-1">
        <Segmented
          size="xs"
          label="Mode"
          value={mode}
          onChange={setMode}
          items={[
            { id: 'agent', label: 'Agent', title: 'Agent — reads and changes the code (Shift Tab)' },
            { id: 'ask', label: 'Ask', title: 'Ask — reads, changes nothing (Shift Tab)' }
          ]}
        />
        <button type="button" className="ml-1 inline-flex h-6 min-w-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-caption text-secondary hover:bg-surface hover:text-fg-strong focus-visible:vy-focus-ring">
          {MODEL} <span className="text-tertiary">· {EFFORT}</span>
          <Icon name="chevron" size={10} className="opacity-60" />
        </button>
        <span className="flex-1" />
        <Tooltip content="18% of the context window used">
          <button type="button" className="inline-grid size-6 place-items-center rounded-md hover:bg-surface focus-visible:vy-focus-ring" aria-label="Context 18% used">
            <Pie value={0.18} size={14} />
          </button>
        </Tooltip>
        <IconButton icon="paperclip" label="Attach files" size="sm" tone="muted" />
        <Button size="xs" variant={text.trim() ? 'primary' : 'secondary'} disabled={!text.trim()} onClick={send} className="ml-1">
          {live ? 'Queue' : 'Send'} <span className="opacity-70">↵</span>
        </Button>
      </div>
    </div>
  )
}

/** The placeholder says what typing here will do, given where the thread is. */
export function composerPlaceholder(turn: Turn | null): string {
  if (!turn) return 'Describe a task, or ask about the code…'
  if (turn.state === 'running') return 'Steer it, or queue what comes next…'
  if (turn.state === 'needs') return 'Say what to change before it carries on…'
  if (turn.state === 'failed' || turn.state === 'stopped') return 'Tell it what to do differently…'
  return 'Ask for a change, or a follow-up…'
}

/* ─── Window chrome ──────────────────────────────────────────────────────── */

export function TitleBar({ children }: { children?: ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-border bg-chrome pl-3" data-titlebar>
      <span className="grid size-5 place-items-center rounded-sm bg-fg-strong font-mono text-2xs font-bold text-bg">V</span>
      <span className="ml-2.5 text-xs text-secondary">{children}</span>
      <span className="flex-1" />
      <div className="flex h-full" aria-hidden>
        {(['min', 'max', 'close'] as const).map((k) => (
          <span key={k} className="grid h-full w-[46px] place-items-center text-secondary">
            <svg width="10" height="10" viewBox="0 0 10 10">
              {k === 'min' ? <path d="M0 5h10" stroke="currentColor" strokeWidth="1" /> : null}
              {k === 'max' ? <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" /> : null}
              {k === 'close' ? <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" /> : null}
            </svg>
          </span>
        ))}
      </div>
    </div>
  )
}

/** A quiet header action: icon + word, xs, the pane-row size. */
export function HeaderAction({ icon, children, onClick }: { icon: IconName; children: ReactNode; onClick?: () => void }) {
  return (
    <Button size="xs" variant="ghost" icon={icon} onClick={onClick}>
      {children}
    </Button>
  )
}

/** Keep a scroller pinned to its end while new content arrives, unless the reader scrolled up. */
export function useFollow(dep: unknown): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const on = (): void => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', on, { passive: true })
    return () => el.removeEventListener('scroll', on)
  }, [])
  useLayoutEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}

/* ─── Steps: the plan, each step folding its own work ───────────────────── */

export function StepList({
  steps,
  onAnswer,
  numbered = false,
  hideNeeds = false
}: {
  steps: Step[]
  onAnswer?: (c: 'once' | 'always' | 'deny') => void
  /** Show step numbers ("1.") — when the plan itself is the subject. */
  numbered?: boolean
  /** The approval is drawn elsewhere (beside the answer), so leave it out here. */
  hideNeeds?: boolean
}) {
  return (
    <ol className="space-y-0.5" aria-label="Steps">
      {steps.map((s, i) => (
        <StepRow key={s.title} step={s} n={numbered ? i + 1 : undefined} onAnswer={onAnswer} hideNeeds={hideNeeds} />
      ))}
    </ol>
  )
}

function StepRow({ step, n, onAnswer, hideNeeds }: { step: Step; n?: number; onAnswer?: (c: 'once' | 'always' | 'deny') => void; hideNeeds: boolean }) {
  const live = step.state === 'running' || step.state === 'needs' || step.state === 'failed'
  const [open, setOpen] = useState(live)
  const [wasLive, setWasLive] = useState(live)
  // A step folds itself once it settles, and opens when it goes live.
  if (live !== wasLive) {
    setWasLive(live)
    setOpen(live)
  }
  const work = hideNeeds ? step.work.filter((w) => w.kind !== 'approval' || w.answer) : step.work
  const can = work.length > 0
  return (
    <li data-step={step.state}>
      <button
        type="button"
        onClick={() => can && setOpen(!open)}
        aria-expanded={can ? open : undefined}
        className={cn('group -mx-2 flex h-7 w-[calc(100%+16px)] min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs focus-visible:vy-focus-ring', can ? ROW_HOVER : 'cursor-default')}
      >
        <span className="grid w-4 shrink-0 place-items-center">
          <StepGlyph state={step.state} />
        </span>
        {n != null ? <span className="shrink-0 font-mono tnum text-caption text-tertiary">{n}.</span> : null}
        <span
          className={cn(
            'min-w-0 truncate',
            step.state === 'queued' ? 'text-tertiary' : step.state === 'done' ? 'text-secondary' : step.state === 'running' ? 'text-fg-strong' : 'text-fg'
          )}
        >
          {step.title}
        </span>
        {step.state === 'needs' ? <span className="shrink-0 text-caption text-accent">Waiting for you</span> : null}
        {step.state === 'failed' ? <span className="shrink-0 text-caption text-danger">Failed</span> : null}
        {step.state === 'stopped' ? <span className="shrink-0 text-caption text-tertiary">Stopped</span> : null}
        <span className="flex-1" />
        {!open && can ? <span className="min-w-0 truncate text-caption text-tertiary">{workCounts(work)}</span> : null}
        {step.secs != null ? <span className="shrink-0 font-mono tnum text-caption text-tertiary">{fmtSecs(step.secs)}</span> : null}
        {can ? <Icon name="chevron" size={11} className={cn('shrink-0 text-tertiary transition-transform', open ? 'rotate-180' : '')} /> : <span className="w-[11px] shrink-0" />}
      </button>
      {open && can ? (
        <div className="space-y-1.5 pb-2 pl-6 pt-1">
          {work.map((w, i) => (
            <WorkItem key={i} w={w} onAnswer={onAnswer} />
          ))}
        </div>
      ) : null}
    </li>
  )
}

/* ─── Review: the turn's edits, file by file ────────────────────────────── */

export function editsOf(turns: Turn[]): Extract<Work, { kind: 'edit' }>[] {
  const byPath = new Map<string, Extract<Work, { kind: 'edit' }>>()
  for (const t of turns) for (const s of t.steps) for (const w of s.work) if (w.kind === 'edit') {
    const had = byPath.get(w.path)
    byPath.set(w.path, had ? { ...w, add: had.add + w.add, del: had.del + w.del, hunk: [...had.hunk, ...w.hunk], created: had.created || w.created } : w)
  }
  return [...byPath.values()]
}

export function ReviewList({
  turns,
  focus,
  settled,
  onSettle
}: {
  turns: Turn[]
  focus?: string | null
  settled?: 'kept' | 'undone'
  /** Keep or undo every edit; absent while the thread still works. */
  onSettle?: (how: 'kept' | 'undone') => void
}) {
  const edits = editsOf(turns)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focus) return
    list.current?.querySelector(`[data-path="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [focus])
  const add = edits.reduce((n, e) => n + e.add, 0)
  const del = edits.reduce((n, e) => n + e.del, 0)
  if (!edits.length) {
    return <div className="grid h-full place-items-center px-8 text-center text-xs text-muted">Nothing changed in this thread.</div>
  }
  return (
    <div ref={list} className="space-y-2 p-4">
      <div className="flex items-center gap-2 pb-1 text-xs">
        <span className="text-fg-strong">{plural(edits.length, 'file')} changed</span>
        <DiffStat add={add} del={del} />
        <span className="flex-1" />
        {settled ? (
          <span className="inline-flex items-center gap-1.5 text-tertiary" data-settled={settled}>
            <Icon name={settled === 'kept' ? 'check' : 'undo'} size={13} />
            {settled === 'kept' ? 'Kept' : 'Undone'}
          </span>
        ) : onSettle ? (
          <>
            <Button size="xs" variant="ghost" icon="undo" onClick={() => onSettle('undone')}>
              Undo all
            </Button>
            <Button size="xs" variant="secondary" icon="check" onClick={() => onSettle('kept')}>
              Keep all
            </Button>
          </>
        ) : null}
      </div>
      {edits.map((e) => (
        <DiffCard key={e.path + (focus === e.path ? ':f' : '')} w={e} defaultOpen={focus ? focus === e.path : edits.length <= 3} />
      ))}
    </div>
  )
}
