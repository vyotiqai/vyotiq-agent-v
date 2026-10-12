import { useId, useRef, useState, type ReactNode } from 'react'
import type { AgentInteractionMode } from '@shared/ipc'
import { SERVICE_TIER_DESCRIPTIONS, SERVICE_TIER_LABELS } from '@shared/domain/serviceTier'
import { DICTATION_LOCAL_CATALOG } from '@shared/dictation'
import { Icon } from '@renderer/lib/icons'
import {
  Alert,
  Badge,
  Button,
  IconButton,
  type IconButtonTone,
  Keys,
  MENU_ROW,
  MENU_ROW_ACTIVE,
  MENU_ROW_IDLE,
  MENU_ROW_SELECTED,
  MENU_ROW_TEXT,
  MENU_SEPARATOR,
  Pie,
  Segmented,
  Tooltip,
  cn
} from '@renderer/lib/ui'
import { BORDER_DIVIDER, DIVIDER_FILL, NUM, ROW_HOVER, SECTION_LABEL, SELECTED } from '@renderer/lib/utils/layout'
import { formatTokens } from '@renderer/lib/utils/formatTokens'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import { nextLowerThinkingEffort, shouldSuggestLowerThinkingEffort } from '@shared/utils/tokenCost'
import { MODES } from '../../../../renderer/src/features/chat/components/composer/ModePicker'
import { ProviderLogo } from '../../../../renderer/src/features/chat/components/composer/ProviderLogo'
import {
  EFFORT_FOOT,
  EFFORT_MODES,
  EFFORT_NOTES,
  MODEL_LABEL,
  MODEL_ROWS,
  PROVIDER,
  PROVIDERS,
  USAGE,
  formatPct,
  providerName,
  usagePct,
  usageRatio
} from './data'
import { Popover, useGlass } from './store'

/**
 * How loud a prompt tool is at rest. The app's row draws them `muted`; B's
 * pill carries only these tools, so they are its focal points, as the
 * reference's white glyphs are.
 */
type ToolTone = Extract<IconButtonTone, 'muted' | 'default'>

/**
 * Structure's glyph: a list with checks — what it makes, a brief with Done
 * when checks — rather than the app's sparkle, which already means skills,
 * tips and What's new, and sits beside a skill chip in the same field.
 */
export const STRUCTURE_ICON = 'listTodo'

/** Buttons never take focus from the field on press. */
export const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

// ── Mode ─────────────────────────────────────────────────────────────────

/** ModeSwitch: Agent | Ask, both words showing. */
export function ModeSwitch() {
  const { mode, setMode } = useGlass()
  const chord = shortcutLabel('cycleMode')
  return (
    <div className="flex shrink-0" data-mode-switch>
      <Segmented<AgentInteractionMode>
        label="Mode"
        value={mode}
        items={MODES.map((m) => ({ id: m.value, label: m.label, title: `${m.note} (${chord}, or ⇧Tab in an empty box, switches)` }))}
        onChange={setMode}
      />
    </div>
  )
}

// ── Model and effort ─────────────────────────────────────────────────────

/** ModelPicker's trigger and its "Model and effort" popover. */
export function ModelPicker({ className }: { className?: string }) {
  const { pop, toggle, effortAt, setEffortAt, scene } = useGlass()
  const ref = useRef<HTMLButtonElement>(null)
  const open = pop === 'model'
  const effort = EFFORT_MODES[effortAt]
  const [tier, setTier] = useState<'default' | 'priority'>('default')
  const [active, setActive] = useState(-1)
  const listId = useId()
  const note = EFFORT_NOTES[effortAt]
  // A long run at high effort is offered one step down, never moved there.
  const [dismissed, setDismissed] = useState<number | null>(null)
  const lowerEffort =
    effort?.enabled && effort.effort ? nextLowerThinkingEffort(effort.effort, ['low', 'medium', 'high', 'xhigh', 'max']) : null
  const lower =
    lowerEffort &&
    dismissed !== effortAt &&
    shouldSuggestLowerThinkingEffort({
      thinkingEnabled: Boolean(effort?.enabled),
      thinkingEffort: effort?.effort,
      steps: USAGE.steps,
      thinkingMode: 'adaptive'
    })
      ? (EFFORT_MODES.find((m) => m.enabled && m.effort === lowerEffort) ?? null)
      : null
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model: ${MODEL_LABEL}${effort ? `, ${effort.label} effort` : ''}`}
        title={`${providerName(PROVIDER)} · ${MODEL_LABEL} · thinks · sees images · uses tools`}
        data-model-picker
        onMouseDown={keepFocus}
        onClick={() => toggle('model')}
        className={cn(
          'inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2 text-xs vy-transition focus-visible:vy-focus-ring',
          open ? 'bg-surface text-fg' : 'text-secondary hover:bg-surface hover:text-fg',
          className
        )}
      >
        <span className="min-w-0 truncate">{MODEL_LABEL}</span>
        {effort ? <span className="shrink-0 text-tertiary">· {effort.short}</span> : null}
        <Icon name="chevron" size={10} className="shrink-0 text-tertiary" />
      </button>
      <Popover anchor={ref} open={open} align="start" width={520} label="Model and effort">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2">
          <Icon name="search" size={14} className="shrink-0 text-muted" />
          <input
            role="combobox"
            aria-label="Search models"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            placeholder="Search every provider"
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-tertiary"
          />
          <IconButton icon="retry" label="Refresh the catalog" size="xs" tone="muted" />
        </div>
        <div className="flex h-[300px] min-h-0 shrink">
          <div className="scroll-thin w-40 shrink-0 space-y-px overflow-y-auto border-r border-border p-1.5">
            {PROVIDERS.map((p) => {
              const on = p.id === PROVIDER
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm vy-transition focus-visible:vy-focus-ring',
                    on ? SELECTED : cn('text-secondary', ROW_HOVER)
                  )}
                >
                  <ProviderLogo id={p.id} size="sm" className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{providerName(p.id)}</span>
                  {p.note ? <span className="shrink-0 text-caption text-tertiary">{p.note}</span> : null}
                </button>
              )
            })}
            <button
              type="button"
              className="flex h-8 w-full items-center rounded-md px-2 text-left text-xs text-muted vy-transition hover:bg-surface hover:text-fg focus-visible:vy-focus-ring"
            >
              Add a provider…
            </button>
          </div>
          <div className="scroll-thin min-w-0 flex-1 overflow-y-auto p-1.5">
            <div className="flex h-7 items-center gap-2 px-2 text-caption text-tertiary" aria-hidden="true">
              <span className="flex-1">Model</span>
              <span className="w-10 text-right">Context</span>
              <span className="w-12 text-right">$/M in</span>
            </div>
            <div id={listId} role="listbox" aria-label="Models">
              {MODEL_ROWS.map((row, i) => {
                const selected = i === 0
                return (
                  <div
                    key={row.id}
                    role="option"
                    aria-selected={selected}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(i)}
                    className={cn(MENU_ROW, 'group', i === active ? MENU_ROW_ACTIVE : MENU_ROW_IDLE, selected ? MENU_ROW_SELECTED : MENU_ROW_TEXT)}
                  >
                    <span
                      className={cn('min-w-0 flex-1 truncate font-mono text-xs', selected ? 'text-fg-strong' : 'text-fg')}
                      title={[`${row.label} · ${row.id}`, ...row.can].join(' · ')}
                    >
                      {row.id}
                    </span>
                    {selected ? <Icon name="check" size={12} className="shrink-0 text-fg-strong" /> : null}
                    <button
                      type="button"
                      aria-label={row.favorite ? `Remove ${row.id} from favourites` : `Add ${row.id} to favourites`}
                      aria-pressed={row.favorite}
                      className={cn(
                        'inline-grid size-5 shrink-0 place-items-center rounded text-muted vy-transition hover:text-fg focus-visible:vy-focus-ring',
                        row.favorite ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                      )}
                    >
                      <Icon name="star" size={12} weight={row.favorite ? 'fill' : 'regular'} />
                    </button>
                    <span className="w-10 shrink-0 text-right font-mono text-caption text-muted tnum">{formatTokens(row.contextWindow)}</span>
                    <span className="w-12 shrink-0 text-right font-mono text-caption text-muted tnum">{row.price}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-3 py-2.5">
          <span className="inline-flex items-center gap-2">
            <span className="text-xs text-muted">Effort</span>
            <Segmented
              label="Effort"
              value={String(effortAt)}
              items={EFFORT_MODES.map((m, i) => {
                const n = EFFORT_NOTES[i]
                return { id: String(i), label: m.short, title: n ? `${m.label}: ${n}` : m.label }
              })}
              onChange={(id) => setEffortAt(Number(id))}
            />
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="text-xs text-muted">Speed</span>
            <Segmented
              label="Speed"
              value={tier}
              items={(['default', 'priority'] as const).map((t) => ({ id: t, label: SERVICE_TIER_LABELS[t], title: SERVICE_TIER_DESCRIPTIONS[t] }))}
              onChange={setTier}
            />
          </span>
          {effort ? (
            <p className="m-0 w-full text-caption text-tertiary" data-effort-note>
              {note ? `${effort.label}: ${note}.` : null}
              {note && effort.enabled ? ' ' : null}
              {effort.enabled ? EFFORT_FOOT : null}
            </p>
          ) : null}
        </div>
        {lower && effort ? (
          <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-caption text-muted" role="status">
            <span className="min-w-0 flex-1">
              {USAGE.steps} steps at {effort.label} — {lower.label} spends fewer reasoning tokens on each one.
            </span>
            <Button size="xs" variant="ghost" onClick={() => setEffortAt(EFFORT_MODES.indexOf(lower))}>
              Use {lower.short}
            </Button>
            <IconButton icon="close" label="Dismiss" size="xs" tone="muted" onClick={() => setDismissed(effortAt)} />
          </div>
        ) : null}
        {scene.running ? (
          <p className="m-0 shrink-0 border-t border-border px-3 py-2 text-caption text-tertiary">
            Changes apply from your next instruction — this run keeps its settings.
          </p>
        ) : null}
      </Popover>
    </>
  )
}

// ── Context ──────────────────────────────────────────────────────────────

const RING_STROKE = 2.5

function UsageRing({ ratio, size, children }: { ratio: number; size: number; children: ReactNode }) {
  const r = (size - RING_STROKE) / 2
  const c = 2 * Math.PI * r
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={RING_STROKE} className="text-border" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - ratio)}
          className="text-fg vy-transition"
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-caption font-semibold tnum leading-none">{children}</span>
    </span>
  )
}

/** ContextMeter with showPercent: a pie and the share, opening "Context details". */
export function ContextMeter({ className }: { className?: string }) {
  const { pop, toggle, scene } = useGlass()
  const ref = useRef<HTMLButtonElement>(null)
  const open = pop === 'context'
  const pct = usagePct(USAGE)
  const ratio = usageRatio(USAGE)
  const budget = USAGE.window
  const headroom = budget - USAGE.used
  const [mcpOpen, setMcpOpen] = useState(false)
  return (
    <div className={cn('relative flex h-7 shrink-0 items-center', className)}>
      <button
        ref={ref}
        type="button"
        data-context-meter
        className={cn(
          'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs vy-transition focus-visible:vy-focus-ring',
          open ? 'bg-surface text-fg' : 'text-muted hover:bg-surface hover:text-fg'
        )}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Context window ${pct}% full: ${formatTokens(USAGE.used)} of ${formatTokens(budget)}. 92% cached. Long-run tip available. Open details.`}
        title={`${formatTokens(USAGE.used)} / ${formatTokens(budget)} (${pct}%) · 92% cached`}
        onMouseDown={keepFocus}
        onClick={() => toggle('context')}
      >
        <Pie value={ratio} size={12} />
        <span aria-hidden="true" className="font-mono tnum">
          {pct}%
        </span>
      </button>
      <Popover anchor={ref} open={open} align="end" width={300} label="Context details">
        <div className="flex min-h-0 flex-1 flex-col">
          <header className="shrink-0 p-3">
            <div className="flex items-start gap-3">
              <UsageRing ratio={ratio} size={56}>
                <span className="text-fg">{pct}%</span>
              </UsageRing>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="m-0 text-sm font-medium text-fg">Context</p>
                <p className="m-0 mt-0.5 text-caption text-secondary">
                  Current step {USAGE.step}
                  <span className="text-tertiary"> · </span>
                  {formatTokens(USAGE.window)} model
                </p>
                <p className="m-0 mt-1.5 text-caption text-fg">
                  <span className={NUM}>{formatTokens(USAGE.used)}</span>
                  <span className="text-secondary"> used of </span>
                  <span className={NUM}>{formatTokens(budget)}</span>
                </p>
              </div>
            </div>
            <div className={cn('relative mt-3 h-2 overflow-hidden rounded-full', DIVIDER_FILL)}>
              <div className="absolute inset-y-0 left-0 rounded-full bg-fg vy-transition" style={{ width: `${pct}%` }} />
              <div
                className="absolute inset-y-0 w-px bg-warning"
                style={{ left: `${(USAGE.compactionTrigger / budget) * 100}%` }}
                title={`Auto-compact at ${formatTokens(USAGE.compactionTrigger)}`}
              />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-caption text-secondary">
              <span>Auto-compact at {formatTokens(USAGE.compactionTrigger)}</span>
              <span>{formatTokens(headroom)} headroom</span>
            </div>
          </header>
          <div className={cn('scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain border-t p-3', BORDER_DIVIDER)}>
            <Alert variant="info" className="mb-3">
              Long run — /clear between unrelated tasks
            </Alert>
            <div className="mb-3 flex flex-col gap-2">
              <p className={cn('m-0', SECTION_LABEL)}>Breakdown</p>
              {USAGE.breakdown.map((row) => {
                const body = (
                  <>
                    <span className={cn('size-1.5 shrink-0 rounded-full', row.color)} aria-hidden />
                    <span className={cn('w-24 shrink-0 truncate text-caption', row.muted ? 'text-tertiary' : 'text-secondary')} title={row.label}>
                      {row.label}
                    </span>
                    {row.muted ? (
                      <span className="min-w-0 flex-1" aria-hidden />
                    ) : (
                      <div className="min-w-0 flex-1">
                        <div className={cn('h-1 overflow-hidden rounded-full', DIVIDER_FILL)}>
                          <div className={cn('h-full rounded-full vy-transition', row.color)} style={{ width: `${(row.tokens / USAGE.window) * 100}%` }} />
                        </div>
                      </div>
                    )}
                    <span className={cn('w-10 shrink-0 text-right', NUM, row.muted ? 'text-tertiary' : 'text-fg')}>{formatTokens(row.tokens)}</span>
                    <span className={cn('w-9 shrink-0 text-right', NUM, row.muted ? 'text-tertiary' : 'text-secondary')}>
                      {row.muted ? '—' : formatPct(row.tokens, USAGE.window)}
                    </span>
                  </>
                )
                if (!row.expandable) {
                  return (
                    <div key={row.label} className="flex items-center gap-2">
                      {body}
                    </div>
                  )
                }
                return (
                  <div key={row.label}>
                    <button
                      type="button"
                      aria-expanded={row.label === 'MCP tools' ? mcpOpen : false}
                      onClick={() => row.label === 'MCP tools' && setMcpOpen((v) => !v)}
                      className={cn('flex w-full items-center gap-2 rounded-sm text-left vy-transition focus-visible:vy-focus-ring', ROW_HOVER)}
                    >
                      {body}
                    </button>
                    {row.label === 'MCP tools' && mcpOpen ? (
                      <div className="mt-2 flex items-center gap-2 pl-3.5">
                        <span className="w-1.5 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-caption text-tertiary">github</span>
                        <span className={cn('shrink-0 text-tertiary', NUM)}>6 tools</span>
                        <span className={cn('w-10 shrink-0 text-right text-secondary', NUM)}>{formatTokens(2_210)}</span>
                        <span className="w-9 shrink-0" aria-hidden />
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
            <div className="flex flex-col gap-1">
              <p className={cn('m-0', SECTION_LABEL)}>This run</p>
              <dl className="m-0 flex flex-col">
                {USAGE.run.map((s) => (
                  <div key={s.label} className="flex h-6 min-w-0 items-center justify-between gap-2" title={s.title}>
                    <dt className="truncate text-caption text-secondary">{s.label}</dt>
                    <dd className={cn('m-0 shrink-0 truncate', NUM, s.tone ?? 'text-fg')}>{s.value}</dd>
                  </div>
                ))}
              </dl>
              {USAGE.reasoningNote ? (
                <p className="m-0 text-caption text-secondary">Reasoning is a large share of output — lower Think effort for simpler work.</p>
              ) : null}
            </div>
          </div>
          <footer className={cn('shrink-0 border-t p-3', BORDER_DIVIDER)}>
            <Button
              size="sm"
              variant="secondary"
              icon="stack"
              className="w-full"
              disabled={scene.running}
              title={scene.running ? 'Unavailable while the agent is running' : 'Summarise older history'}
            >
              Compact history
            </Button>
          </footer>
        </div>
      </Popover>
    </div>
  )
}

// ── Structure ────────────────────────────────────────────────────────────

/** The sparkles: write the draft up as a brief. */
export function StructureButton({ ready, tone = 'muted' }: { ready: boolean; tone?: ToolTone }) {
  return (
    <IconButton
      icon={STRUCTURE_ICON}
      label="Structure into a brief (Ctrl+Shift+Enter)"
      size="md"
      tone={tone}
      disabled={!ready}
      data-composer-structure
      aria-keyshortcuts="Control+Shift+Enter"
      onMouseDown={keepFocus}
    />
  )
}

// ── Attach ───────────────────────────────────────────────────────────────

/** AttachMenu: the paperclip and its four rows. */
export function AttachMenu({
  withScreenshot,
  disabled = false,
  align = 'end',
  tone = 'muted',
  glyph = 'paperclip'
}: {
  withScreenshot: boolean
  disabled?: boolean
  tone?: ToolTone
  /** The app's paperclip, or B's `+` (the reference's, and the common "add"). */
  glyph?: 'paperclip' | 'plus'
  /** The app's paperclip is at the row's right end, so its menu end-aligns; B's is on the left cap. */
  align?: 'start' | 'end'
}) {
  const { pop, toggle } = useGlass()
  const ref = useRef<HTMLButtonElement>(null)
  const open = pop === 'attach'
  const [active, setActive] = useState(0)
  const rows: { id: string; label: string; icon: 'file' | 'image' | 'browser' | 'at'; keys?: string[]; separatorBefore?: boolean }[] = [
    { id: 'files', label: 'Files…', icon: 'file' },
    { id: 'image', label: 'Image…', icon: 'image' },
    ...(withScreenshot ? [{ id: 'screenshot', label: 'Screenshot of the Browser tab', icon: 'browser' as const }] : []),
    { id: 'mention', label: 'Mention a file', icon: 'at', keys: ['@'], separatorBefore: true }
  ]
  return (
    <>
      <IconButton
        ref={ref}
        icon={glyph}
        label="Attach files — or type @ for context"
        title={open ? '' : undefined}
        size="md"
        tone={tone}
        data-composer-attach
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => toggle('attach')}
      />
      {/* ActionMenu is content-sized: its width is the trigger's at least, its rows' at most. */}
      <AttachPopover anchor={ref} open={open} align={align}>
        <ul role="menu" aria-label="Attach" className="m-0 list-none p-1">
          {rows.map((row, i) => (
            <li key={row.id} role="none">
              {row.separatorBefore ? <div role="separator" className={MENU_SEPARATOR} /> : null}
              <button
                type="button"
                role="menuitem"
                className={cn(MENU_ROW, MENU_ROW_TEXT, i === active ? MENU_ROW_ACTIVE : MENU_ROW_IDLE)}
                onMouseEnter={() => setActive(i)}
              >
                <Icon name={row.icon} size={15} className="text-muted" />
                {row.label}
                {row.keys ? (
                  <span aria-hidden="true" className="ml-auto pl-4">
                    <Keys keys={row.keys} />
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      </AttachPopover>
    </>
  )
}

/** ActionMenu sizes to its rows; 252px is what these four measure. */
function AttachPopover({
  anchor,
  open,
  align,
  children
}: {
  anchor: React.RefObject<HTMLElement | null>
  open: boolean
  align: 'start' | 'end'
  children: ReactNode
}) {
  return (
    <Popover anchor={anchor} open={open} align={align} width={252} label="Attach" role="menu">
      {children}
    </Popover>
  )
}

// ── Mic ──────────────────────────────────────────────────────────────────

/** MicControl: idle, live (filled, pressed) or set up; "Dictate with" opens from it. */
export function MicControl({ tone = 'muted' }: { tone?: ToolTone }) {
  const { pop, toggle, scene } = useGlass()
  const ref = useRef<HTMLButtonElement>(null)
  const chord = shortcutLabel('dictation')
  const live = scene.take === 'listening'
  const open = pop === 'mic'
  const model = DICTATION_LOCAL_CATALOG.find((m) => m.id === 'whisper-small.en') ?? DICTATION_LOCAL_CATALOG[0]!
  return (
    <>
      {live ? (
        <IconButton ref={ref} icon="mic" weight="fill" label={`Insert (${chord})`} size="md" active data-take-mic="live" onMouseDown={keepFocus} />
      ) : scene.micReady ? (
        <IconButton
          ref={ref}
          icon="mic"
          label="Dictate"
          title={`Dictate (${chord})\nThis PC · ${model.label}`}
          size="md"
          tone={tone}
          data-take-mic="idle"
          onMouseDown={keepFocus}
        />
      ) : (
        <IconButton
          ref={ref}
          icon="mic"
          label="Set up dictation"
          title={`Set up dictation (${chord})`}
          size="md"
          tone={tone}
          aria-expanded={open}
          aria-haspopup="dialog"
          data-take-mic="setup"
          onMouseDown={keepFocus}
          onClick={() => toggle('mic')}
        />
      )}
      <Popover anchor={ref} open={open} align="end" width={380} label="Dictate with">
        <div className="p-1">
          <div className="px-2 pb-1.5 pt-2">
            <div className="text-sm font-medium text-fg-strong">Dictate with</div>
            <div className="mt-0.5 text-xs text-muted">Pick one to start. Settings → Voice changes it later.</div>
          </div>
          <Choice
            title="This PC"
            badge={<Badge tone="outline">Recommended</Badge>}
            detail={`${model.label} · ${model.approxDownloadLabel.replace('~', '')} · ${model.language} · audio never leaves this PC`}
            action={
              <Button size="xs" variant="secondary">
                Install
              </Button>
            }
          />
          <Choice
            title="OpenAI"
            detail="Uses your OpenAI key · any language"
            action={
              <Button size="xs" variant="secondary">
                Use
              </Button>
            }
          />
          <Choice
            title="OpenRouter"
            detail={<span className="text-tertiary">No OpenRouter key yet</span>}
            action={
              <Button size="xs" variant="ghost">
                Add key
              </Button>
            }
          />
        </div>
      </Popover>
    </>
  )
}

function Choice({ title, badge, detail, action }: { title: string; badge?: ReactNode; detail: ReactNode; action: ReactNode }) {
  return (
    <div className="rounded-md px-2 py-2 hover:bg-surface">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium text-fg-strong">
            {title}
            {badge}
          </div>
          <div className="mt-0.5 text-xs text-muted">{detail}</div>
        </div>
        <div className="shrink-0 pt-px">{action}</div>
      </div>
    </div>
  )
}

// ── Stop and the one action ──────────────────────────────────────────────

/** Line only, while a run is live: Stop beside the action. Esc does the same. */
export function StopButton() {
  return (
    <Tooltip content="Stop the run (Esc)">
      <Button size="xs" variant="ghost" icon="stop" onMouseDown={keepFocus}>
        Stop
      </Button>
    </Tooltip>
  )
}

/** The line's one action: Send, Queue while live, Send now when live with text. */
export function LineAction({ running, hasText, ready }: { running: boolean; hasText: boolean; ready: boolean }) {
  if (running && hasText && ready) {
    return (
      <Button
        size="sm"
        variant="secondary"
        kbd={['Shift', '↵']}
        aria-label="Send now"
        aria-keyshortcuts="Shift+Enter"
        title="Send it into the live run now, instead of when this turn ends"
        onMouseDown={keepFocus}
      >
        Send now
      </Button>
    )
  }
  const sendReady = ready && hasText
  return (
    <Button
      type="submit"
      size="sm"
      variant="secondary"
      kbd={['↵']}
      aria-label={running ? 'Queue' : 'Send'}
      aria-keyshortcuts="Enter"
      title={sendReady ? (running ? 'Queue it — it starts when this run ends' : 'Send') : 'Write an instruction or attach a file first.'}
      disabled={!sendReady}
      onMouseDown={keepFocus}
    >
      {running ? 'Queue' : 'Send'}
    </Button>
  )
}
