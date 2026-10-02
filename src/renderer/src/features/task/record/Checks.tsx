import type { DoneWhenCheck } from '@shared/doneWhenChecks'
import { checksTally } from '@shared/doneWhenChecks'
import { StatusGlyph, cn } from '@renderer/lib/ui'
import { RecordRow } from './RecordLayout'
import { TickedText } from './TickedText'

const VERDICT_WORD = { met: 'Met', not_met: 'Not met', open: 'Not checked yet' } as const

/** A check names commands and files in ticks: the markdown chip, on the record's own plane. */
const CHECK_CODE = 'rounded-sm bg-surface px-1 py-0.5 font-mono text-[0.85em]'
/** Evidence is already small and quiet: mono at the caption step, no chip. */
const EVIDENCE_CODE = 'font-mono text-caption'

function CheckLine({ check, showPending }: { check: DoneWhenCheck; showPending: boolean }) {
  const state = check.verdict === 'met' ? 'review' : check.verdict === 'not_met' ? 'failed' : 'queued'
  return (
    <li className="flex items-start gap-2.5 text-sm" data-check={check.id} data-check-verdict={check.verdict ?? 'open'}>
      <span className="mt-[3px] shrink-0">
        <StatusGlyph state={state} size={14} />
        <span className="sr-only">{VERDICT_WORD[check.verdict ?? 'open']}:</span>
      </span>
      {/* The record prose's reading measure: evidence ran 150 characters a line. */}
      <div className="min-w-0 max-w-[80ch] flex-1">
        <p className={cn('m-0 [overflow-wrap:anywhere]', check.verdict === 'met' ? 'text-secondary' : 'text-fg')}>
          <TickedText text={check.text} code={CHECK_CODE} />
        </p>
        {check.evidence ? (
          <p className="m-0 mt-0.5 text-xs text-tertiary [overflow-wrap:anywhere]" title="The agent's evidence">
            <TickedText text={check.evidence} code={EVIDENCE_CODE} />
          </p>
        ) : null}
      </div>
      {check.verdict === null && showPending ? (
        <span className="shrink-0 pt-px text-xs text-tertiary">checked at the end</span>
      ) : null}
    </li>
  )
}

/**
 * The checks the run is judged against, while that judgment is still open —
 * a live run, or one that ended without a result. Once the run has a result
 * the checks move under it (`CheckedBlock`), so they are said once.
 */
export function DoneWhenRow({ checks, live }: { checks: readonly DoneWhenCheck[]; live: boolean }) {
  if (checks.length === 0) return null
  const t = checksTally(checks)
  return (
    <RecordRow label="Done when" meta={`${t.met}/${t.total}`}>
      <ul className="m-0 list-none space-y-1.5 p-0">
        {checks.map((c) => (
          <CheckLine key={c.id} check={c} showPending={live} />
        ))}
      </ul>
    </RecordRow>
  )
}

/** Under the result: every check with the agent's verdict and its evidence. */
export function CheckedBlock({ checks }: { checks: readonly DoneWhenCheck[] }) {
  if (checks.length === 0) return null
  const t = checksTally(checks)
  return (
    <div className="mt-4" data-checked>
      <h4 className="m-0 text-sm font-semibold text-fg-strong">
        Checked · {t.met} of {t.total} done-when {t.total === 1 ? 'check' : 'checks'} met
        {t.open > 0 ? <span className="font-normal text-tertiary"> · {t.open} not checked</span> : null}
      </h4>
      <ul className="m-0 mt-1.5 list-none space-y-1.5 p-0">
        {checks.map((c) => (
          <CheckLine key={c.id} check={c} showPending={false} />
        ))}
      </ul>
    </div>
  )
}

/**
 * Which run each check belongs to: the last run that had started when the
 * check was made. A check made before any run (from the brief) is the first's.
 */
export function checksByRun(
  runs: ReadonlyArray<{ n: number; at: number | null }>,
  checks: readonly DoneWhenCheck[]
): Map<number, DoneWhenCheck[]> {
  const out = new Map<number, DoneWhenCheck[]>()
  if (runs.length === 0) return out
  for (const check of checks) {
    const made = Date.parse(check.createdAt)
    let owner = runs[0]!.n
    for (const run of runs) {
      if (run.at != null && Number.isFinite(made) && run.at <= made) owner = run.n
    }
    const list = out.get(owner) ?? []
    list.push(check)
    out.set(owner, list)
  }
  return out
}
