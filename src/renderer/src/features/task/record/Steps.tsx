import { useContext, useState } from 'react'
import { parseAgentInstanceRunId, parseAgentInstanceRunIdFromArgs, formatAgentInstanceShortId } from '@shared/utils/agentInstance'
import { formatElapsed } from '@shared/utils/timeFormat'
import { Icon } from '@renderer/lib/icons'
import { StepMarker, cn } from '@renderer/lib/ui'
import { useSharedNow } from '@renderer/lib/hooks/useSharedNow'
import type { RecordStep } from '../recordModel'
import { RecordOpenContext, stepOpenKey } from '../recordFind'
import { RecordRow } from './RecordLayout'
import { NowLine, WorkList, workIsLive } from './WorkItems'

/** The plan's steps; only the live step is open, the rest are one line each. */
export function Steps({
  steps,
  runN,
  activity = null
}: {
  steps: readonly RecordStep[]
  runN: number
  /** The live run's activity, shown at the end of the live step's work. */
  activity?: string | null
}) {
  if (steps.length === 0) return null
  const liveKey = steps.find((s) => s.state === 'running' || s.state === 'needs')?.key
  return (
    <RecordRow>
      <ol className="-mx-2" aria-label="Steps">
        {steps.map((s) => (
          <StepRow key={s.key} step={s} runN={runN} activity={s.key === liveKey ? activity : null} />
        ))}
      </ol>
    </RecordRow>
  )
}

/** Brings this record's needs-you card into view and puts focus on its first action. */
export function showNeedsYou(from: Element): void {
  const card = from.closest('[data-record-scroll]')?.querySelector<HTMLElement>('[data-needs-you]')
  if (!card) return
  card.scrollIntoView({ block: 'start', behavior: 'smooth' })
  card.querySelector<HTMLElement>('button:not([disabled]), [href], input, textarea')?.focus({ preventScroll: true })
}

/** Instances this step started, by the short id the navigator and panes use. */
function instanceKeys(step: RecordStep): string[] {
  const keys: string[] = []
  for (const w of step.work) {
    if (w.kind !== 'instance' || w.tool.tool.name !== 'spawn_agent_instance') continue
    const runId = parseAgentInstanceRunId(w.tool.tool.content) ?? parseAgentInstanceRunIdFromArgs(w.tool.tool.argsPreview)
    if (runId) keys.push(formatAgentInstanceShortId(runId))
  }
  return keys
}

function editSummaryText(edits: RecordStep['edits']): string | null {
  if (!edits) return null
  const files = `${edits.files} ${edits.files === 1 ? 'file' : 'files'} edited`
  if (edits.add === undefined || edits.del === undefined) return files
  return `${files} · +${edits.add} −${edits.del}`
}

function StepRow({ step, runN, activity }: { step: RecordStep; runN: number; activity: string | null }) {
  const live = step.state === 'running' || step.state === 'needs'
  const [open, setOpen] = useState<boolean | null>(null)
  // Find in record opens a step that holds a match, whatever you last chose.
  const forced = useContext(RecordOpenContext).has(stepOpenKey(runN, step.key))
  const expanded = forced || (open ?? live)
  const quiet = step.state === 'queued'
  const now = useSharedNow(live && step.startedAt != null)
  const durationMs =
    step.startedAt == null ? null : step.endedAt != null ? step.endedAt - step.startedAt : live ? now - step.startedAt : null
  const instances = instanceKeys(step)
  const summary = editSummaryText(step.edits)
  const tail = step.work[step.work.length - 1]
  const showActivity = activity != null && !(tail && workIsLive(tail))
  const canOpen = step.work.length > 0 || showActivity
  return (
    <li className={cn('rounded-lg', live && 'bg-card')} data-step={step.n} data-step-state={step.state}>
      {/* The title button stretches over the whole row (its ::after), so the row
          toggles anywhere; the needs-you link sits above it as its own control. */}
      <div
        className={cn(
          'group relative flex min-h-8 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 vy-transition',
          !live && canOpen && 'hover:bg-surface'
        )}
      >
        <StepMarker state={step.state} n={step.n} />
        <button
          type="button"
          aria-expanded={canOpen ? expanded : undefined}
          disabled={!canOpen}
          onClick={() => setOpen(!expanded)}
          className={cn(
            'min-w-0 flex-1 truncate rounded-sm text-left text-sm after:absolute after:inset-0 after:rounded-lg focus-visible:vy-focus-ring disabled:cursor-default',
            live ? 'font-medium text-fg-strong' : quiet ? 'text-muted' : 'text-secondary'
          )}
        >
          {step.title}
        </button>
        {instances.map((k) => (
          <span
            key={k}
            className="inline-flex h-[18px] shrink-0 items-center rounded-sm bg-surface px-1.5 font-mono text-2xs text-muted"
            title={`Instance ${k}`}
          >
            {k}
          </span>
        ))}
        {step.state === 'needs' ? (
          <button
            type="button"
            onClick={(e) => showNeedsYou(e.currentTarget)}
            className="relative z-[1] shrink-0 rounded-sm text-xs font-medium text-accent hover:underline focus-visible:vy-focus-ring"
          >
            Waiting for you — see above
          </button>
        ) : summary ? (
          <span className="hidden shrink-0 text-xs text-tertiary @[640px]/record:inline">{summary}</span>
        ) : null}
        <span className="w-14 shrink-0 text-right font-mono text-caption text-tertiary tnum">
          {durationMs != null && durationMs >= 1000 ? formatElapsed(durationMs) : ''}
        </span>
        {canOpen ? (
          <Icon
            name={expanded ? 'chevron' : 'chevronRight'}
            size={12}
            className={cn('shrink-0 text-tertiary', !expanded && 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100')}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
      </div>
      {expanded && canOpen ? (
        <div className="space-y-2 pb-3 pl-[36px] pr-2">
          {step.work.length > 0 ? <WorkList items={step.work} /> : null}
          {showActivity ? <NowLine text={activity!} /> : null}
        </div>
      ) : null}
    </li>
  )
}
