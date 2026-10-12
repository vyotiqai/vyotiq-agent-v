import type { UiItem } from '@shared/transcript'
import {
  formatAgentInstanceShortId,
  parseAgentInstanceRunId,
  parseAgentInstanceRunIdFromArgs
} from '@shared/utils/agentInstance'
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
  /** The run polled one child: its short id, so the line says which one it stands for. */
  child?: string
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
  // A view is updated in place by id, never folded into a repeat.
  if (w.kind === 'view') return null
  // Polls of a child — awaits, pulls, merges, cancels — fold like any other
  // call. A spawn never folds: consecutive spawns are one block by groupWork,
  // and each child in that block is a row the fold would swallow.
  if (w.kind === 'instance') return w.tool.tool.name === 'spawn_agent_instance' ? null : [w.tool]
  if (w.kind !== 'explore' || w.tools.length === 0) return null
  const sig = signature(w.tools[0]!)
  return w.tools.every((t) => signature(t) === sig) ? w.tools : null
}

/** The words of a thought or note, its kind and whitespace aside; null for any other row. */
function proseKey(w: WorkItem): string | null {
  if (w.kind !== 'thought' && w.kind !== 'note') return null
  const text = w.text.trim()
  return text ? `${w.kind}\u0000${text}` : null
}

/** A prose row whose saying is done: only settled thoughts and notes fold. */
function settledProse(w: WorkItem): boolean {
  return w.kind === 'thought' ? !w.streaming : w.kind === 'note' ? !w.item.streaming : true
}

/**
 * The same paragraph said again back to back — a provider that echoes its
 * reasoning, a note streamed and then re-emitted. Adjacent rows of one
 * settled thought or note are that paragraph said once: the last of the run
 * is kept, so a still-streaming tail is never the row dropped.
 */
export function collapseEchoes(items: readonly WorkItem[]): WorkItem[] {
  const out: WorkItem[] = []
  for (let i = 0; i < items.length; ) {
    const w = items[i]!
    const key = proseKey(w)
    let j = i + 1
    if (key && settledProse(w)) {
      while (j < items.length && proseKey(items[j]!) === key) j += 1
    }
    out.push(j > i + 1 ? items[j - 1]! : w)
    i = j
  }
  return out
}

/**
 * A work list with each run of one call repeated unchanged — the reasoning
 * between them allowed, nothing else — folded, and each paragraph echoed back
 * to back collapsed first (see {@link collapseEchoes}): from the
 * {@link REPEAT_FOLD_AT}th call in a row, every call before the last one
 * (with the thoughts between them) becomes one line. The last call keeps its
 * row and the thought right above it, so where the wait ended and why is
 * still read where it happened.
 */
export function foldRepeats(items: readonly WorkItem[]): (WorkItem | RepeatRun)[] {
  const list = collapseEchoes(items)
  const out: (WorkItem | RepeatRun)[] = []
  for (let i = 0; i < list.length; ) {
    const first = callsOf(list[i]!)
    if (!first) {
      out.push(list[i]!)
      i += 1
      continue
    }
    const sig = signature(first[0]!)
    // The rows of the run, and how many calls they hold between them.
    const at = [i]
    let calls = first.length
    for (let j = i + 1; j < list.length; j += 1) {
      const w = list[j]!
      if (w.kind === 'thought') continue
      const next = callsOf(w)
      if (!next || signature(next[0]!) !== sig) break
      at.push(j)
      calls += next.length
    }
    // One row already says "Ran 9 commands"; folding needs a row to fold above.
    if (at.length < 2 || calls < REPEAT_FOLD_AT) {
      out.push(list[i]!)
      i += 1
      continue
    }
    // Up to and including the row before the last: the thoughts after it
    // lead into the last call and stay with it.
    const end = at[at.length - 2]! + 1
    const earlier = list.slice(i, end)
    const call = first[0]!
    // Polls of one child: the line names it, since the rows that did are folded under it.
    const runId =
      list[i]!.kind === 'instance'
        ? (parseAgentInstanceRunId(call.tool.content) ?? parseAgentInstanceRunIdFromArgs(call.tool.argsPreview))
        : null
    out.push({
      kind: 'repeats',
      id: `repeats:${list[i]!.id}`,
      earlier,
      calls: earlier.flatMap((w) => callsOf(w) ?? []),
      command: call.tool.name === 'terminal',
      child: runId ? formatAgentInstanceShortId(runId) : undefined
    })
    i = end
  }
  return out
}
