import { useState, type ReactNode } from 'react'
import { Icon } from '@renderer/lib/icons'
import { cn } from '@renderer/lib/ui'
import type { AttentionEntry, AttentionState } from '../homeEntries'
import { STATE_PRESENTATION } from '../statePresentation'
import { HomeCard } from './HomeSection'

/** Rows shown before the lane folds. Three is enough to see the pattern. */
const COLLAPSED_ROWS = 3

/**
 * One state's worth of sessions, under a header that names the state, counts it
 * and says in a sentence what the condition is.
 *
 * The header is the point: seven sessions sharing one problem used to render as
 * seven identical alarms, which buried the single failure above them. Folding
 * past the third row keeps the section readable without hiding that the tail is
 * there — the count in the header is always the real total.
 */
export function AttentionLane({
  state,
  entries,
  renderRow
}: {
  state: AttentionState
  entries: readonly AttentionEntry[]
  renderRow: (entry: AttentionEntry) => ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const presentation = STATE_PRESENTATION[state]
  const shown = expanded ? entries : entries.slice(0, COLLAPSED_ROWS)
  const hidden = entries.length - shown.length

  return (
    <HomeCard
      role="group"
      className="animate-fade-in"
      aria-label={`${presentation.label}, ${entries.length}`}
    >
      <div className="flex min-w-0 items-start gap-2.5 border-b border-border/40 bg-surface/30 px-3 py-2.5">
        <span
          className={cn(
            'mt-px inline-flex size-4 shrink-0 items-center justify-center',
            presentation.tone
          )}
          aria-hidden="true"
        >
          <Icon name={presentation.icon} size={13} />
        </span>
        <div className="min-w-0 flex-1">
          {/* Count sits beside the label, the same idiom the section headings
              use — pinned to the far right it aligned to nothing. */}
          <p className="m-0 truncate text-sm font-medium text-fg">
            {presentation.label}
            <span className="ml-1.5 text-2xs tabular-nums text-tertiary">{entries.length}</span>
          </p>
          <p className="m-0 mt-0.5 text-2xs leading-snug text-muted">{presentation.detail}</p>
        </div>
      </div>

      <div role="list" className="divide-y divide-border/40">
        {shown.map((entry) => renderRow(entry))}
      </div>

      {hidden > 0 || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          className="w-full border-t border-border/40 px-3 py-2 text-left text-2xs text-muted vy-transition hover:bg-surface hover:text-fg focus-visible:vy-focus-ring"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show fewer' : `Show ${hidden} more`}
        </button>
      ) : null}
    </HomeCard>
  )
}
