import { useState } from 'react'
import type { DoneWhenCheck } from '@shared/doneWhenChecks'
import { Icon } from '@renderer/lib/icons'
import { Button, StatusGlyph, cn } from '@renderer/lib/ui'
import { coverCheckInstruction } from '@renderer/features/task/followUps'

export { coverCheckInstruction }

const OPEN_WORD = { not_met: 'Not met', open: 'Not checked' } as const

/**
 * Review leads with what is still open: a done-when check the agent marked
 * not met, or never checked. Each can go back to the agent as an instruction.
 * The met ones fold to a count — the record lists every check with its
 * evidence, so here they only need to be countable. Shown once the run has
 * stopped; while it works the verdicts are still coming.
 */
export function ReviewChecks({
  checks,
  inset,
  onAsk
}: {
  checks: readonly DoneWhenCheck[]
  /** The review's rows inset 16px; the tab's list rows 12px. */
  inset: 'px-3' | 'px-4'
  onAsk?: (instruction: string) => void
}) {
  const [showMet, setShowMet] = useState(false)
  const open = checks.filter((c) => c.verdict !== 'met')
  const met = checks.filter((c) => c.verdict === 'met')
  if (checks.length === 0) return null
  return (
    <section aria-label="Done-when checks" className={cn('shrink-0 border-b border-border py-2', inset)} data-review-checks>
      {open.length ? (
        <ul className="m-0 list-none space-y-1.5 p-0">
          {open.map((c) => (
            // The one block that asks something of you here: tinted, bled past the text's edge so
            // the glyph and words stay on the met rows' line.
            <li
              key={c.id}
              className="-mx-2 flex items-start gap-2.5 rounded-md bg-warning-soft px-2 py-2"
              data-check={c.id}
              data-check-verdict={c.verdict ?? 'open'}
            >
              <span className="mt-px shrink-0">
                <StatusGlyph state={c.verdict === 'not_met' ? 'failed' : 'queued'} size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="m-0 text-xs text-fg [overflow-wrap:anywhere]">
                  <span className="sr-only">{c.verdict === 'not_met' ? OPEN_WORD.not_met : OPEN_WORD.open}: </span>
                  {c.text}
                </p>
                <p className="m-0 mt-0.5 text-caption text-tertiary [overflow-wrap:anywhere]">
                  {c.verdict === 'not_met' ? (c.evidence ?? OPEN_WORD.not_met) : 'Not checked before the run ended'}
                </p>
              </div>
              {onAsk ? (
                <Button size="xs" variant="secondary" className="shrink-0" onClick={() => onAsk(coverCheckInstruction(c))}>
                  {c.verdict === 'not_met' ? 'Ask it to cover this' : 'Ask it to check'}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {met.length ? (
        <>
          <button
            type="button"
            aria-expanded={showMet}
            onClick={() => setShowMet(!showMet)}
            className={cn(
              '-mx-1 flex h-6 items-center gap-1.5 rounded-sm px-1 text-caption text-tertiary vy-transition hover:text-fg focus-visible:vy-focus-ring',
              open.length ? 'mt-1.5' : ''
            )}
            data-review-checks-met
          >
            <StatusGlyph state="review" size={12} />
            {met.length} of {checks.length} {checks.length === 1 ? 'check' : 'checks'} met
            <Icon name={showMet ? 'chevron' : 'chevronRight'} size={10} />
          </button>
          {showMet ? (
            <ul className="m-0 mt-1 list-none space-y-1.5 p-0">
              {met.map((c) => (
                <li key={c.id} className="flex items-start gap-2.5" data-check={c.id} data-check-verdict="met">
                  <span className="mt-px shrink-0">
                    <StatusGlyph state="review" size={14} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="m-0 text-xs text-secondary [overflow-wrap:anywhere]">
                      <span className="sr-only">Met: </span>
                      {c.text}
                    </p>
                    {c.evidence ? <p className="m-0 mt-0.5 text-caption text-tertiary [overflow-wrap:anywhere]">{c.evidence}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
