import type { UiItem } from '@shared/transcript'
import type { WorkItem } from '../recordModel'

type ToolItem = Extract<UiItem, { kind: 'tool' }>

/**
 * The same call made again and again, unchanged — a poll of a background
 * run's exit file, a spawn that keeps failing the same way. Each one was a
 * card or a line of its own with a thought above it, and one wait took a
 * screen. From this many in a row, all but the last fold to one line above it.
 */
export const REPEAT_FOLD_AT = 3

/** Calls before the last one, folded to a line; the last stays as it was. */
export type RepeatRun = {
  kind: 'repeats'
  id: string
  /** Everything the line stands for: the earlier calls and the thoughts between them. */
  earlier: WorkItem[]
  /** The earlier calls themselves, in order. */
  calls: ToolItem[]
  /** A command (its output is the point) rather than another kind of call. */
  command: boolean
}

function signature(item: ToolItem): string {
  return `${item.tool.name}\u0000${item.tool.argsPreview ?? ''}`
}

/**
 * The calls a row stands for when they are all one call: a card, a call's
 * line, or a lookup line — of one call, or of the same call made back to back
 * with no reasoning between (the loop folds those into one line already).
 */
function callsOf(w: WorkItem): ToolItem[] | null {
  if (w.kind === 'card' || w.kind === 'tool') return [w.tool]
  if (w.kind !== 'explore' || w.tools.length === 0) return null
  const sig = signature(w.tools[0]!)
  return w.tools.every((t) => signature(t) === sig) ? w.tools : null
}

/**
 * A work list with each run of one call repeated unchanged — the reasoning
 * between them allowed, nothing else — folded: from the {@link REPEAT_FOLD_AT}th
 * in a row, every call before the last one (with the thoughts between them)
 * becomes one line. The last call keeps its row and the thought right above
 * it, so where the wait ended and why is still read where it happened.
 */
export function foldRepeats(items: readonly WorkItem[]): (WorkItem | RepeatRun)[] {
  const out: (WorkItem | RepeatRun)[] = []
  for (let i = 0; i < items.length; ) {
    const first = callsOf(items[i]!)
    if (!first) {
      out.push(items[i]!)
      i += 1
      continue
    }
    const sig = signature(first[0]!)
    // The rows of the run, and how many calls they hold between them.
    const at = [i]
    let calls = first.length
    for (let j = i + 1; j < items.length; j += 1) {
      const w = items[j]!
      if (w.kind === 'thought') continue
      const next = callsOf(w)
      if (!next || signature(next[0]!) !== sig) break
      at.push(j)
      calls += next.length
    }
    // One row already says "Ran 9 commands"; folding needs a row to fold above.
    if (at.length < 2 || calls < REPEAT_FOLD_AT) {
      out.push(items[i]!)
      i += 1
      continue
    }
    // Up to and including the row before the last: the thoughts after it
    // lead into the last call and stay with it.
    const end = at[at.length - 2]! + 1
    const earlier = items.slice(i, end)
    out.push({
      kind: 'repeats',
      id: `repeats:${items[i]!.id}`,
      earlier,
      calls: earlier.flatMap((w) => callsOf(w) ?? []),
      command: first[0]!.tool.name === 'terminal'
    })
    i = end
  }
  return out
}
