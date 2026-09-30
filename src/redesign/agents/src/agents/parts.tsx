import { forwardRef, useEffect, useState, type ReactNode, type RefObject } from 'react'
import { Icon, type IconName } from '@renderer/lib/icons'
import { ActionMenu, StatusGlyph, Tooltip, cn, type ActionMenuItem, type TaskState } from '@renderer/lib/ui'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import type { Check } from './data'

/*
  The grid. One 16px text edge in every pane; rows bleed their fill 8px past
  it so text never moves on hover. A 16px glyph column and a 10px gap line up
  list rows, checks and steps, so their text shares one left edge.
*/

export const GLYPH_COL = 'inline-grid size-4 shrink-0 place-items-center'

/** "src/middleware/" quiet, "rateLimit.ts" in ink: the name is what you scan for. */
export function Path({ path, strong = false, className }: { path: string; strong?: boolean; className?: string }) {
  const cut = path.lastIndexOf('/')
  const dir = cut >= 0 ? path.slice(0, cut + 1) : ''
  const base = cut >= 0 ? path.slice(cut + 1) : path
  return (
    <span className={cn('min-w-0 truncate', className)} title={path}>
      {dir ? <span className="text-tertiary">{dir}</span> : null}
      <span className={strong ? 'font-medium text-fg-strong' : 'text-fg'}>{base}</span>
    </span>
  )
}

/** A sentence of the record, with `code` set as code. `small` is the size a card's detail uses. */
export function Prose({ text, small = false, className }: { text: string; small?: boolean; className?: string }) {
  const parts = text.split(/(`[^`]+`)/g)
  return (
    <p className={cn(small ? 'text-xs leading-[18px] text-secondary' : 'text-sm leading-[22px] text-fg', className)}>
      {parts.map((p, i) =>
        p.startsWith('`') ? (
          <code key={i} className="rounded-sm bg-surface px-1 py-px font-mono text-xs text-fg-strong">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </p>
  )
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(SECTION_LABEL, className)}>{children}</div>
}

/** A done-when check: the glyph says met / not met / open; the words say which. */
export function CheckGlyph({ state }: { state: Check['state'] }) {
  if (state === 'met') return <Icon name="checkCircle" size={16} weight="fill" className="text-success" />
  if (state === 'unmet') return <Icon name="warningCircle" size={16} weight="fill" className="text-warning" />
  return (
    <span className={GLYPH_COL} aria-hidden>
      <span className="size-3 rounded-full border border-dashed border-border-strong" />
    </span>
  )
}

export function CheckRow({ c, dense = false, action }: { c: Check; dense?: boolean; action?: ReactNode }) {
  return (
    <li className={cn('flex items-start gap-2.5', dense ? 'py-0.5' : 'py-1')}>
      <span className="mt-0.5">
        <CheckGlyph state={c.state} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block text-xs', c.state === 'open' ? 'text-secondary' : 'text-fg')}>
          {c.text}
          <span className="sr-only">{c.state === 'met' ? ' — met' : c.state === 'unmet' ? ' — not met' : ' — not checked yet'}</span>
        </span>
        {c.evidence ? <span className="block truncate font-mono text-caption text-tertiary">{c.evidence}</span> : null}
      </span>
      {action}
    </li>
  )
}

/**
 * The plan as a hairline: one segment per step, flush to the bottom of a
 * 40px header, so progress costs no extra row. Done steps are quiet ink, the
 * live one breathes in the accent, a step that needs you is solid accent, a
 * failed one is the danger hue. A plan with nothing left to do draws nothing.
 */
export function PlanLine({ steps, className }: { steps: { title: string; state: TaskState }[]; className?: string }) {
  if (!steps.length || steps.every((s) => s.state === 'done' || s.state === 'review')) return null
  const live = steps.findIndex((s) => s.state === 'running' || s.state === 'needs')
  return (
    <div className={cn('flex h-[3px] gap-[3px]', className)} role="img" aria-label={live >= 0 ? `Step ${live + 1} of ${steps.length}` : `${steps.length} steps`}>
      {steps.map((s, i) => (
        <Tooltip key={i} content={`${i + 1}. ${s.title}`} describeChild={false}>
          <span
            className={cn(
              'h-full min-w-0 flex-1 rounded-full',
              s.state === 'done' || s.state === 'review'
                ? 'bg-muted'
                : s.state === 'running'
                  ? 'ag-seg-live bg-accent'
                  : s.state === 'needs'
                    ? 'bg-accent'
                    : s.state === 'failed'
                      ? 'bg-danger'
                      : s.state === 'stopped'
                        ? 'bg-border-strong'
                        : 'bg-border'
            )}
          />
        </Tooltip>
      ))}
    </div>
  )
}

/** A small step meter for list rows and Home: the same idea as PlanLine at 2px. */
export function StepMeter({ at, of, state, className }: { at: number; of: number; state: TaskState; className?: string }) {
  return (
    <span className={cn('flex h-[2px] gap-[2px]', className)} aria-hidden>
      {Array.from({ length: of }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-full flex-1 rounded-full',
            i < at - 1 ? 'bg-muted' : i === at - 1 ? (state === 'running' ? 'ag-seg-live bg-accent' : state === 'failed' ? 'bg-danger' : 'bg-accent') : 'bg-border'
          )}
        />
      ))}
    </span>
  )
}

export function Glyph({ state, size = 14 }: { state: TaskState; size?: number }) {
  return (
    <span className={GLYPH_COL} style={{ width: size + 2, height: size + 2 }}>
      <StatusGlyph state={state} size={size} />
    </span>
  )
}

/** A quiet control that opens a menu: mode, model, scope. Text first, caret last. */
export const Pill = forwardRef<
  HTMLButtonElement,
  {
    children: ReactNode
    icon?: IconName
    onClick?: () => void
    active?: boolean
    label?: string
    tone?: 'plain' | 'filled' | 'accent'
    caret?: boolean
    'aria-expanded'?: boolean
    'aria-controls'?: string
    'aria-haspopup'?: 'menu' | 'dialog'
  }
>(function Pill({ children, icon, onClick, active = false, label, tone = 'plain', caret = true, ...aria }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      onClick={onClick}
      {...aria}
      className={cn(
        'inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs vy-transition focus-visible:vy-focus-ring',
        active
          ? 'bg-surface-2 text-fg-strong'
          : tone === 'filled'
            ? 'bg-surface font-medium text-fg hover:bg-surface-2'
            : tone === 'accent'
              ? 'bg-accent-soft font-medium text-accent hover:bg-surface-2'
              : 'text-secondary hover:bg-surface hover:text-fg-strong'
      )}
    >
      {icon ? <Icon name={icon} size={14} className="shrink-0 text-tertiary" /> : null}
      <span className="min-w-0 truncate">{children}</span>
      {caret ? <Icon name="chevron" size={11} className="shrink-0 opacity-60" /> : null}
    </button>
  )
})

/** The app's ActionMenu with its open state held here, for one-line call sites. */
export function PopMenu({
  items,
  label,
  placement = 'down',
  align = 'start',
  trigger
}: {
  items: ActionMenuItem[]
  label: string
  placement?: 'up' | 'down'
  align?: 'start' | 'end'
  trigger: (t: Parameters<Parameters<typeof ActionMenu>[0]['trigger']>[0], open: boolean) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  return <ActionMenu open={open} onOpenChange={setOpen} placement={placement} align={align} aria-label={label} items={items} trigger={(t) => trigger(t, open)} />
}

/**
 * Close a popover on Escape or a press outside it. A press on its own
 * trigger (marked `data-popover-trigger`) is left to the trigger, so the
 * toggle doesn't close and reopen in one click.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (target.closest?.('[data-popover-trigger]')) return
      if (ref.current && !ref.current.contains(target)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const t = setTimeout(() => window.addEventListener('mousedown', onDown))
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [ref, open, onClose])
}

/** A pane with nothing in it yet: one glyph, one line, at most one action. */
export function Empty({ icon, title, body, action }: { icon: IconName; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <Icon name={icon} size={20} className="text-tertiary" />
      <div className="text-sm text-fg-strong">{title}</div>
      {body ? <div className="max-w-[300px] text-xs text-muted">{body}</div> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}

export function WindowControls() {
  return (
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
  )
}
