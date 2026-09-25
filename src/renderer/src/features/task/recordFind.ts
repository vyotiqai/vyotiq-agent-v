import { createContext } from 'react'
import { parseArgsRecord } from '@shared/toolSummary'
import type { RecordRun, WorkItem } from './recordModel'

/**
 * Find in record (Ctrl F).
 *
 * The record folds most of itself away — closed steps, earlier runs — so a
 * search over the DOM alone would miss them. The model decides what has to be
 * open for a match to be seen; the DOM then gives the exact ranges to mark and
 * scroll to. Tool output is not searched: it loads only when a card opens.
 */

/** Keys of the folds a match needs open: `run:<n>` for an earlier run, `step:<n>:<key>` for a step. */
export const RecordOpenContext = createContext<ReadonlySet<string>>(new Set())

export const runOpenKey = (n: number): string => `run:${n}`
export const stepOpenKey = (runN: number, stepKey: string): string => `step:${runN}:${stepKey}`

/** The text a work item shows once its step is open. */
function workText(w: WorkItem): string {
  switch (w.kind) {
    case 'note':
    case 'thought':
      return w.text
    case 'card': {
      const args = parseArgsRecord(w.tool.tool.argsPreview)
      const command = typeof args?.command === 'string' ? args.command : ''
      const path = typeof args?.path === 'string' ? args.path : ''
      return `${command}\n${path}\n${w.tool.tool.summary ?? ''}`
    }
    case 'instance': {
      const args = parseArgsRecord(w.tool.tool.argsPreview)
      return typeof args?.goal === 'string' ? args.goal : ''
    }
    case 'tool':
      return `${w.tool.tool.summary ?? ''}\n${w.tool.tool.status === 'fail' ? (w.tool.tool.content ?? '') : ''}`
    case 'plan':
      return w.title ?? ''
    case 'error':
      return w.message
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

/** The folds to open so every match in the model is on screen. */
export function foldsToOpen(runs: readonly RecordRun[], query: string): Set<string> {
  const q = query.trim().toLowerCase()
  const open = new Set<string>()
  if (!q) return open
  runs.forEach((run, i) => {
    const isLast = i === runs.length - 1
    let inRun = has(run.text, q) || has(run.result?.text, q)
    const lists: WorkItem[][] = [run.setup, run.after]
    for (const list of lists) if (list.some((w) => has(workText(w), q))) inRun = true
    for (const step of run.steps) {
      if (has(step.title, q)) inRun = true
      if (step.work.some((w) => has(workText(w), q))) {
        open.add(stepOpenKey(run.n, step.key))
        inRun = true
      }
    }
    if (inRun && !isLast) open.add(runOpenKey(run.n))
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
 * `::highlight(record-find-current)` in styles.css; the last pane to search
 * owns them.
 */
export function paintMatches(id: string, ranges: readonly Range[], current: number): void {
  const reg = registry()
  if (!reg) return
  owner = id
  if (ranges.length === 0) {
    reg.highlights.delete('record-find')
    reg.highlights.delete('record-find-current')
    return
  }
  reg.highlights.set('record-find', new reg.Highlight(...ranges))
  const cur = ranges[current]
  if (cur) {
    // Painted above the other marks wherever they overlap.
    const mark = new reg.Highlight(cur) as { priority?: number }
    mark.priority = 1
    reg.highlights.set('record-find-current', mark)
  } else {
    reg.highlights.delete('record-find-current')
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
