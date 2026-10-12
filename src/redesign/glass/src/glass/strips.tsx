import { useEffect, useState, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Alert, Button, FileChip, IconButton, ImageChip, cn } from '@renderer/lib/ui'
import { ERROR_TEXT, FOLLOW_UPS, SAMPLE_FILE, SAMPLE_IMAGE } from './data'
import { STRUCTURE_ICON, keepFocus } from './controls'

// ── Dictation take ───────────────────────────────────────────────────────

/** TakeStrip's formatTakeTime (m:ss). */
function formatTakeTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`
}

function Lead({ children, pill = false }: { children: ReactNode; pill?: boolean }) {
  return (
    <span className={pill ? PILL_LEAD : 'flex size-4 shrink-0 items-center'} aria-hidden="true">
      {children}
    </span>
  )
}

/**
 * B's rows, above or under the pill, on the pill's own edges: the glyph
 * centred on the left cap's centre (28px in, the `+`'s column), the words on
 * the text edge (50px), the last control on the action's right edge (14px).
 * The row starts 10px in; the 36px lead column centres on 28 and its -4px
 * margin cancels part of the row's 8px gap, so the words land on 50.
 */
export const PILL_ROW = 'pl-2.5 pr-3.5'
/** A row with no glyph: its words go straight to the text edge. */
export const PILL_ROW_BARE = 'pl-[50px] pr-3.5'
const PILL_LEAD = '-mr-1 flex w-9 shrink-0 items-center justify-center'

/** Where a row sits: the app's box, or B's pill. */
export type Edge = 'box' | 'pill'

function Act({ children, kbd, primary = false }: { children: ReactNode; kbd?: string[]; primary?: boolean }) {
  return (
    <Button size="xs" variant={primary ? 'secondary' : 'ghost'} kbd={kbd} onMouseDown={keepFocus}>
      {children}
    </Button>
  )
}

/** Levels moving the way a live mic's do: the newest on the right. */
function useLevels(live: boolean): number[] {
  const [levels, setLevels] = useState<number[]>(() => Array.from({ length: 36 }, (_, i) => 0.15 + 0.5 * Math.abs(Math.sin(i * 0.7))))
  useEffect(() => {
    if (!live) return undefined
    let t = 0
    const id = window.setInterval(() => {
      t += 1
      const speaking = Math.sin(t / 9) > -0.3
      const next = speaking ? 0.25 + 0.7 * Math.abs(Math.sin(t * 1.7) * Math.cos(t * 0.6)) : 0.04
      setLevels((prev) => [...prev.slice(1), next])
    }, 90)
    return () => window.clearInterval(id)
  }, [live])
  return levels
}

function useElapsed(live: boolean, startMs: number): number {
  const [ms, setMs] = useState(startMs)
  useEffect(() => {
    if (!live) return undefined
    const id = window.setInterval(() => setMs((v) => v + 1000), 1000)
    return () => window.clearInterval(id)
  }, [live])
  return ms
}

/**
 * TakeStrip while listening: rec dot · level meter · time · where the audio
 * goes · the ways out. Insert is primary when Enter inserts (the default).
 */
export function TakeListening({ sendLabel, className, edge = 'box' }: { sendLabel: string | null; className?: string; edge?: Edge }) {
  const levels = useLevels(true)
  const ms = useElapsed(true, 7000)
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Dictation"
      data-take="listening"
      data-take-open=""
      className={cn('flex h-8 min-w-0 items-center gap-2 text-xs', edge === 'pill' ? PILL_ROW : '', className)}
    >
      <Lead pill={edge === 'pill'}>
        <span className="size-2 rounded-full bg-accent animate-live" />
      </Lead>
      <span className="sr-only">Listening</span>
      <span aria-hidden="true" data-take-meter className="flex h-4 w-[110px] shrink-0 items-center justify-end gap-[2px] overflow-hidden text-accent">
        {levels.map((v, i) => (
          <span key={i} className="w-[2px] shrink-0 rounded-full bg-current" style={{ height: `${Math.max(2, Math.round(Math.min(1, v) * 16))}px` }} />
        ))}
      </span>
      <span aria-hidden="true" className="shrink-0 font-mono text-xs tnum text-secondary">
        {formatTakeTime(ms)}
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 text-caption text-tertiary" title="Audio stays on this PC">
        <Icon name="lock" size={12} />
        This PC
      </span>
      <span className="flex-1" />
      <Act kbd={['Esc']}>Discard</Act>
      {sendLabel ? <Act kbd={['Ctrl', '↵']}>{sendLabel}</Act> : null}
      <Act kbd={['↵']} primary>
        Insert
      </Act>
    </div>
  )
}

/** What a take leaves behind: a slim row above the controls, which stay. */
export function TakeInserted({ words, edge = 'box' }: { words: number; edge?: Edge }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Dictation"
      data-take="inserted"
      className={cn('flex h-8 min-w-0 items-center gap-2 text-xs', edge === 'pill' ? PILL_ROW : '')}
    >
      <Lead pill={edge === 'pill'}>
        <Icon name="check" size={14} className="text-success" />
      </Lead>
      <span className="text-secondary">
        <span className="font-mono tnum">{words}</span> {words === 1 ? 'word' : 'words'} inserted
      </span>
      <span className="flex-1" />
      <Act kbd={['Ctrl', 'Z']}>Undo</Act>
    </div>
  )
}

// ── Structure ────────────────────────────────────────────────────────────

/** StructureStrip's row: on the queue's edges over the line, the box's over the brief, the pill's in B. */
type Placement = 'line' | 'brief' | 'pill'

function StructureRow({ children, placement }: { children: ReactNode; placement: Placement }) {
  return (
    <div
      className={cn(
        'flex h-8 min-w-0 items-center gap-2 text-xs @max-[440px]:[&_span:has(>kbd)]:hidden',
        placement === 'brief' ? 'pl-4 pr-2' : placement === 'pill' ? PILL_ROW : 'pl-3 pr-2'
      )}
      role="status"
    >
      {children}
    </div>
  )
}

/** In the pill the glyph takes the lead column; elsewhere it sits inline, as in the app. */
function StructureGlyph({ pill, children }: { pill: boolean; children: ReactNode }) {
  return pill ? <Lead pill>{children}</Lead> : <>{children}</>
}

export function StructureWorking({ placement = 'line' }: { placement?: Placement }) {
  return (
    <div className="@container" data-structure-open data-structure-working>
      <StructureRow placement={placement}>
        <StructureGlyph pill={placement === 'pill'}>
          <Icon name="loader" size={13} className="shrink-0 text-muted motion-safe:animate-spin" />
        </StructureGlyph>
        <span className="min-w-0 truncate text-muted">Writing a brief from your instruction…</span>
        <span className="flex-1" />
        <Button size="xs" variant="ghost" kbd={['Esc']} onMouseDown={keepFocus}>
          Cancel
        </Button>
      </StructureRow>
    </div>
  )
}

export function StructureDone({ placement = 'line' }: { placement?: Placement }) {
  return (
    <div className="@container" data-structure-done>
      <StructureRow placement={placement}>
        <StructureGlyph pill={placement === 'pill'}>
          <Icon name={STRUCTURE_ICON} size={13} className="shrink-0 text-muted" />
        </StructureGlyph>
        <span className="shrink-0 text-fg">Structured</span>
        <span className="min-w-0 truncate text-muted">change brief</span>
        <span className="flex-1" />
        <Button size="xs" variant="ghost" kbd={['Ctrl', 'Z']} onMouseDown={keepFocus}>
          Undo
        </Button>
        <Button size="xs" variant="ghost" onMouseDown={keepFocus}>
          Try again
        </Button>
        <IconButton icon="close" label="Hide" size="xs" tone="muted" />
      </StructureRow>
    </div>
  )
}

// ── Queue ────────────────────────────────────────────────────────────────

/** Queued instructions, above the box while a run is live. */
export function FollowUpQueue({ className, edge = 'box' }: { className?: string; edge?: Edge }) {
  return (
    <ul className={cn('m-0 list-none p-0', className)} data-follow-up-queue aria-label="Queued instructions">
      {FOLLOW_UPS.map((entry) => (
        <li
          key={entry.id}
          className={cn('flex h-8 items-center gap-2 text-xs', edge === 'pill' ? PILL_ROW_BARE : 'pl-3 pr-2')}
          data-follow-up-offline={entry.offline ? '' : undefined}
        >
          <span className="shrink-0 text-tertiary">{entry.offline ? 'Queued · offline' : 'Queued'}</span>
          <span className="min-w-0 flex-1 truncate text-secondary" title={entry.preview}>
            {entry.preview}
          </span>
          <Button size="xs" variant="ghost" aria-label="Edit queued instruction">
            Edit
          </Button>
          {entry.offline ? null : (
            <Button size="xs" variant="ghost" aria-label="Send queued instruction now" title="Interrupt the run and apply it now">
              Send now
            </Button>
          )}
          <IconButton icon="close" label="Remove queued instruction" size="xs" tone="muted" />
        </li>
      ))}
    </ul>
  )
}

// ── Alerts ───────────────────────────────────────────────────────────────

/**
 * The run's error, with Retry when the failure is one a retry can fix. In
 * B it is a row on the pill's edges — the danger glyph in the lead column,
 * the words on the text edge — instead of a box with its own radius.
 */
export function ErrorAlert({ className, edge = 'box' }: { className?: string; edge?: Edge }) {
  if (edge === 'pill') {
    return (
      <div role="alert" className={cn('flex min-h-8 min-w-0 items-center gap-2 py-1 text-xs', PILL_ROW, className)}>
        <Lead pill>
          <Icon name="warningCircle" size={14} className="text-danger" />
        </Lead>
        <span className="min-w-0 flex-1 text-fg [overflow-wrap:anywhere]">{ERROR_TEXT}</span>
        <Button size="xs" variant="secondary" onMouseDown={keepFocus}>
          Retry
        </Button>
        <IconButton icon="close" label="Dismiss" size="xs" tone="muted" />
      </div>
    )
  }
  return (
    <Alert onDismiss={() => undefined} className={className}>
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 [overflow-wrap:anywhere]">{ERROR_TEXT}</span>
        <Button size="xs">Retry</Button>
      </div>
    </Alert>
  )
}

/**
 * ModelReadinessBanner, missing key: on the line its fix is the one action.
 * In B it is the pill's first row, on the pill's edges, with no box of its own.
 */
export function ReadinessBanner({ primary, className, edge = 'box' }: { primary: boolean; className?: string; edge?: Edge }) {
  if (edge === 'pill') {
    return (
      <div role="status" className={cn('flex min-w-0 items-center gap-2 pt-3.5', PILL_ROW, className)}>
        <Lead pill>
          <Icon name="key" size={15} className="text-muted" />
        </Lead>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg-strong">Add an API key for Anthropic</div>
          <div className="text-xs text-muted">Keys stay encrypted on this device.</div>
        </div>
        <Button size="sm" variant={primary ? 'primary' : 'secondary'}>
          Add API key
        </Button>
      </div>
    )
  }
  return (
    <Alert
      variant="info"
      className={className}
      actions={
        <Button size="sm" variant={primary ? 'primary' : 'secondary'}>
          Add API key
        </Button>
      }
    >
      <div className="text-sm font-medium text-fg-strong">Add an API key for Anthropic</div>
      <div className="mt-0.5 text-xs text-secondary">Keys stay encrypted on this device.</div>
    </Alert>
  )
}

// ── Attachments ──────────────────────────────────────────────────────────

/** ComposerAttachments: image chips, then file chips. */
export function Attachments() {
  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <ImageChip url={SAMPLE_IMAGE} label="Image 1" onClick={() => undefined} onRemove={() => undefined} />
        <FileChip name={SAMPLE_FILE.name} chars={SAMPLE_FILE.chars} onRemove={() => undefined} />
      </div>
    </div>
  )
}

