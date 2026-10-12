import { useState } from 'react'
import type { DoneWhenCheck } from '@shared/doneWhenChecks'
import { checksTally } from '@shared/doneWhenChecks'
import { Icon } from '@renderer/lib/icons'
import { StatusGlyph, cn } from '@renderer/lib/ui'
import { SECTION_LABEL } from '@renderer/lib/utils/layout'
import { RecordRow } from './RecordLayout'
import { TickedText } from './TickedText'

const VERDICT_WORD = { met: 'Met', not_met: 'Not met', open: 'Not checked yet' } as const

/** A check names commands and files in ticks: the markdown chip, on the record's own plane. */
const CHECK_CODE = 'rounded-sm bg-surface px-1 py-0.5 font-mono text-[0.85em]'
/** Evidence is already small and quiet: mono at the caption step, no chip. */
const EVIDENCE_CODE = 'font-mono text-caption'

function CheckLine({ check }: { check: DoneWhenCheck }) {
  const state = check.verdict === 'met' ? 'review' : check.verdict === 'not_met' ? 'failed' : 'queued'
  return (
    <li className="flex items-start gap-2.5 text-sm" data-check={check.id} data-check-verdict={check.verdict ?? 'open'}>
      <span className="mt-[3px] shrink-0">
        <StatusGlyph state={state} size={14} />
        <span className="sr-only">{VERDICT_WORD[check.verdict ?? 'open']}:</span>
      </span>
      {/* The record prose's reading measure (reply.css): evidence ran 150 characters a line. */}
      <div className="min-w-0 max-w-[72ch] flex-1">
        <p className={cn('m-0 [overflow-wrap:anywhere]', check.verdict === 'met' ? 'text-secondary' : 'text-fg')}>
          <TickedText text={check.text} code={CHECK_CODE} />
        </p>
        {check.evidence ? (
          <p className="m-0 mt-0.5 text-xs text-tertiary [overflow-wrap:anywhere]" title="The agent's evidence">
            <TickedText text={check.evidence} code={EVIDENCE_CODE} />
          </p>
        ) : null}
      </div>
    </li>
  )
}

/**
 * The checks the run is judged against, while that judgment is still open —
 * a live run, or one that ended without a result. Once the run has a result
 * the checks move under it (`CheckedBlock`), so they are said once.
 *
 * While the run works they are one line that opens onto them: three open
 * checks above the work pushed what is happening now down the page, and
 * they are judged at the end, not read along the way.
 */
export function DoneWhenRow({ checks, live }: { checks: readonly DoneWhenCheck[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  if (checks.length === 0) return null
  const t = checksTally(checks)
  const list = (
    <ul className="m-0 list-none space-y-1.5 p-0" id={live ? 'done-when-checks' : undefined}>
      {checks.map((c) => (
        <CheckLine key={c.id} check={c} />
      ))}
    </ul>
  )
  if (!live) {
    return (
      <RecordRow label="Done when" meta={`${t.met}/${t.total}`}>
        {list}
      </RecordRow>
    )
  }
  const said = t.met + t.notMet > 0 ? `${t.met} of ${t.total} met so far` : `${t.total} ${t.total === 1 ? 'check' : 'checks'} · checked at the end`
  return (
    <section aria-label="Done when" className="py-3" data-done-when={open ? 'open' : 'folded'}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="done-when-checks"
        onClick={() => setOpen((v) => !v)}
        className="group flex h-6 w-full items-center gap-2 rounded-sm text-left focus-visible:vy-focus-ring"
      >
        <span className={cn('shrink-0', SECTION_LABEL)}>Done when</span>
        <span className="min-w-0 flex-1 truncate text-xs text-tertiary">{said}</span>
        <Icon
          name={open ? 'chevron' : 'chevronRight'}
          size={11}
          className={cn('shrink-0 text-tertiary', open ? '' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100')}
        />
      </button>
      {open ? <div className="mt-2">{list}</div> : null}
    </section>
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
          <CheckLine key={c.id} check={c} />
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
