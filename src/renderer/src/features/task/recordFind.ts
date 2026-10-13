import { createContext } from 'react'
import { parseArgsRecord } from '@shared/toolSummary'
import { stripSpokenBlock } from '@shared/spokenSummary'
import type { RecordRun, WorkItem } from './recordModel'
import { plainLine, untick } from './record/plainText'
import { foldRepeats } from './record/repeats'
import './recordFind.css'

/**
 * Find in record (Ctrl F).
 *
 * The record folds most of itself away — closed steps, earlier runs — so a
 * search over the DOM alone would miss them. The model decides what has to be
 * open for a match to be seen; the DOM then gives the exact ranges to mark and
 * scroll to. A command's output is searched as far as the record holds it (a
 * long one is held cut, the rest loading when its card opens): a match opens
 * the card. Other tool output is not searched.
 * Text is matched as the record shows it — markdown marks and code ticks
 * dropped — so a fold is opened only for a match the page then has.
 */

/**
 * Keys of the folds a match needs open: `run:<n>` for an earlier run,
 * `work:<n>` for the line a run's work folds behind, `step:<n>:<key>` for
 * a step, `thought:<id>` for a thought shown as one line,
 * `brief:<n>` for a brief whose words are folded, and
 * `repeats:<id>` for the line a call repeated unchanged folds to.
 */
export const RecordOpenContext = createContext<ReadonlySet<string>>(new Set())

export const runOpenKey = (n: number): string => `run:${n}`
export const stepOpenKey = (runN: number, stepKey: string): string => `step:${runN}:${stepKey}`
/** The one line a settled run's work folds behind. */
export const workOpenKey = (runN: number): string => `work:${runN}`
export const thoughtOpenKey = (id: string): string => `thought:${id}`
/** A brief folded to six lines, or a follow-up the app wrote, shown as its ask. */
export const briefOpenKey = (runN: number): string => `brief:${runN}`
/** A repeat line's id already reads `repeats:<its first row's id>`. */
export const repeatOpenKey = (id: string): string => id
/** A command card whose output holds a match. */
export const cardOpenKey = (id: string): string => `card:${id}`
/** The earlier rows a long work list keeps behind one line, by the list's first row. */
export const earlierOpenKey = (firstId: string): string => `earlier:${firstId}`

/**
 * A work list longer than this shows its latest rows and keeps the rest
 * behind a "Show more" line: a 5,000-call run opened in full was 60k nodes
 * and a second per keypress.
 */
export const WORK_PAGE = 200

/** The rows a list of this length keeps folded at first. */
export function earlierCount(length: number): number {
  return Math.max(0, length - WORK_PAGE)
}

/** A terminal card's output, as far as the record holds it. */
function commandOutput(w: WorkItem): string {
  return w.kind === 'card' && w.tool.tool.name === 'terminal' ? (w.tool.tool.content ?? '') : ''
}

/** Markdown — a note, a Result — as its words: what the page shows of it. */
// Find matches what's on screen: a voice answer's spoken summary is hidden there.
const shownProse = (text: string | null | undefined): string => (text ? plainLine(stripSpokenBlock(text)) : '')

/** The text a work item shows once its step is open. */
function workText(w: WorkItem): string {
  switch (w.kind) {
    case 'note':
      return shownProse(w.text)
    case 'thought':
      return untick(w.text)
    case 'card': {
      const args = parseArgsRecord(w.tool.tool.argsPreview)
      const command = typeof args?.command === 'string' ? args.command : ''
      const path = typeof args?.path === 'string' ? args.path : ''
      return `${command}\n${path}\n${w.tool.tool.summary ?? ''}`
    }
    case 'instance': {
      // A spawn's row shows the outcome it asked for, else its goal.
      const args = parseArgsRecord(w.tool.tool.argsPreview)
      const said = [args?.outcome, args?.goal].filter((v): v is string => typeof v === 'string')
      return untick(said.join('\n'))
    }
    case 'tool':
      return `${w.tool.tool.summary ?? ''}\n${w.tool.tool.status === 'fail' ? (w.tool.tool.content ?? '') : ''}`
    case 'plan':
      return w.title ?? ''
    case 'view': {
      const args = parseArgsRecord(w.tool.tool.argsPreview)
      return [args?.title, args?.subtitle].filter((v): v is string => typeof v === 'string').join('\n')
    }
    case 'error':
      return w.message
    case 'notice':
      return w.item.text
    case 'said':
      return untick(w.text)
    case 'explore':
    case 'compaction':
      return ''
    default: {
      const _exhaustive: never = w
      return _exhaustive
    }
  }
}

function has(text: string | null | undefined, q: string): boolean {
  return Boolean(text) && text!.toLowerCase().includes(q)
}

/** Its row text or, for a command, its output. */
function matches(w: WorkItem, q: string): boolean {
  return has(workText(w), q) || has(commandOutput(w), q)
}

/** The folds to open so every match in the model is on screen. */
export function foldsToOpen(runs: readonly RecordRun[], query: string): Set<string> {
  const q = query.trim().toLowerCase()
  const open = new Set<string>()
  if (!q) return open
  runs.forEach((run, i) => {
    const isLast = i === runs.length - 1
    const inBrief = has(untick(run.text), q)
    if (inBrief) open.add(briefOpenKey(run.n))
    let inWork = false
    // Work outside any step folds only with the line it sits behind.
    if ([...run.setup, ...run.after].some((w) => matches(w, q))) inWork = true
    for (const step of run.steps) {
      if (has(plainLine(step.title), q)) inWork = true
      // Work between steps is never folded inside one: only the work line must open.
      if (step.between.some((w) => matches(w, q))) inWork = true
      if (step.work.some((w) => matches(w, q))) {
        open.add(stepOpenKey(run.n, step.key))
        inWork = true
      }
    }
    if (inWork) open.add(workOpenKey(run.n))
    const inRun = inWork || inBrief || has(run.command, q) || has(shownProse(run.result?.text), q)
    if (inRun && !isLast) open.add(runOpenKey(run.n))
    for (const list of [run.setup, run.after, ...run.steps.flatMap((s) => [s.work, s.between])]) {
      // A thought shows one line until opened; one that matches opens in full.
      for (const w of list) if (w.kind === 'thought' && has(untick(w.text), q)) open.add(thoughtOpenKey(w.id))
      // A command whose output matches opens its card, where the output shows.
      for (const w of list) if (w.kind === 'card' && has(commandOutput(w), q)) open.add(cardOpenKey(w.tool.id))
      // A long list's earlier rows show in full when one of them matches.
      const earlier = earlierCount(list.length)
      if (earlier > 0 && list.slice(0, earlier).some((w) => matches(w, q))) open.add(earlierOpenKey(list[0]!.id))
      // A call repeated unchanged folds its earlier rows to one line: that opens too.
      for (const row of foldRepeats(list)) {
        if (row.kind === 'repeats' && row.earlier.some((w) => matches(w, q))) open.add(repeatOpenKey(row.id))
      }
    }
  })
  return open
}

/** Every case-insensitive occurrence of `query` in the text under `root`. */
export function findRanges(root: HTMLElement, query: string): Range[] {
  const q = query.trim().toLowerCase()
  if (!q || typeof document === 'undefined') return []
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest('[aria-hidden="true"], .sr-only, script, style')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLowerCase()
    let from = 0
    for (let at = text.indexOf(q, from); at >= 0; at = text.indexOf(q, from)) {
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + q.length)
      ranges.push(range)
      from = at + q.length
    }
  }
  return ranges
}

type HighlightRegistry = { set: (name: string, h: unknown) => void; delete: (name: string) => void }
type HighlightCtor = new (...ranges: Range[]) => unknown

function registry(): { highlights: HighlightRegistry; Highlight: HighlightCtor } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight
  if (!css?.highlights || !Highlight) return null
  return { highlights: css.highlights, Highlight }
}

/** The pane whose find bar owns the marks — `::highlight()` names are global. */
let owner: string | null = null

/**
 * Marks matches with the CSS Custom Highlight API — no DOM is rewritten, so
 * nothing React owns is touched. Styled by `::highlight(record-find)` and
 * `::highlight(record-find-current)` in recordFind.css; the last pane to search
 * owns them.
 */
export function paintMatches(id: string, ranges: readonly Range[], current: number): void {
  const cur = ranges[current]
  if (cur) revealMatch(cur)
  const reg = registry()
  if (!reg) return
  owner = id
  if (ranges.length === 0) {
    reg.highlights.delete('record-find')
    reg.highlights.delete('record-find-current')
    return
  }
  reg.highlights.set('record-find', new reg.Highlight(...ranges))
  if (cur) {
    // Painted above the other marks wherever they overlap.
    const mark = new reg.Highlight(cur) as { priority?: number }
    mark.priority = 1
    reg.highlights.set('record-find-current', mark)
  } else {
    reg.highlights.delete('record-find-current')
  }
}

/** What a fold inside a reply listens for, on its `[data-find-fold]` element, to open for find. */
export const FIND_REVEAL_EVENT = 'record-find-reveal'

/**
 * Folds the model knows nothing of live inside a reply's markdown: a
 * `<details>` the answer wrote, a long code card cut at its first lines.
 * The DOM still holds their text, so find counts a match there — and opens
 * them for the current one, or it would scroll to text nobody can see.
 */
function revealMatch(range: Range): void {
  const from = range.startContainer.parentElement
  // A match in a fold's own summary is already in view.
  const summary = from?.closest('summary')
  for (let el = from; el; el = el.parentElement) {
    if (el instanceof HTMLDetailsElement && !el.open && summary?.parentElement !== el) el.open = true
    if (el.hasAttribute('data-find-fold')) el.dispatchEvent(new Event(FIND_REVEAL_EVENT))
  }
}

/** Clears the marks if this pane still owns them. */
export function clearMatches(id: string): void {
  if (owner !== id) return
  const reg = registry()
  if (!reg) return
  reg.highlights.delete('record-find')
  reg.highlights.delete('record-find-current')
  owner = null
}
