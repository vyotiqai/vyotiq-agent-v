import { useMemo } from 'react'
import { parseViewSpecStreaming } from '@shared/viewSpec'
import type { UiItem } from '@shared/transcript'
import type { RecordRun, WorkItem } from '../recordModel'
import { ViewCard, useViewText } from './reply/view/ViewFence'
import { RecordRow } from './RecordLayout'

type ToolItem = Extract<UiItem, { kind: 'tool' }>

/*
  The views a run drew while it worked (show_view), after its work and above
  its answer. One place per view: a later call with the same id redraws it
  there, starting from what it showed, so a progress table fills in where you
  are already looking instead of stacking a copy per update. The work keeps a
  one-line row for each call, so when it was drawn is still on record.

  While the work is open this is the bottom of the record, next to the live
  line; once the work folds it stays, between the fold and the answer.
*/

/** The id a call's arguments name so far; the title stands in, as a fence's does. */
function viewIdOf(tool: ToolItem): string | null {
  return parseViewSpecStreaming(tool.tool.argsPreview ?? '')?.id ?? null
}

/** A call that has something to draw: blocks streamed in, or a settled view. */
function drawable(tool: ToolItem): boolean {
  if (tool.tool.status === 'fail') return false
  const spec = parseViewSpecStreaming(tool.tool.argsPreview ?? '')
  return Boolean(spec && (spec.blocks.length > 0 || tool.tool.status === 'done'))
}

/**
 * The newest drawable call per view id, in the order the views first
 * appeared. An update still writing its first block leaves the copy before
 * it on screen rather than blanking it.
 */
export function runViews(work: readonly WorkItem[]): ToolItem[] {
  const order: string[] = []
  const latest = new Map<string, ToolItem>()
  for (const w of work) {
    if (w.kind !== 'view' || !drawable(w.tool)) continue
    const id = viewIdOf(w.tool)
    if (!id) continue
    if (!latest.has(id)) order.push(id)
    latest.set(id, w.tool)
  }
  return order.map((id) => latest.get(id)!)
}

function allWork(run: RecordRun): WorkItem[] {
  return [...run.setup, ...run.steps.flatMap((s) => [...s.work, ...s.between]), ...run.after]
}

export function RunViews({ run }: { run: RecordRun }) {
  const views = useMemo(() => runViews(allWork(run)), [run])
  if (views.length === 0) return null
  return (
    <RecordRow className="flex flex-col gap-3">
      {/* Keyed by call: each update mounts fresh and reshapes from the copy before it. */}
      {views.map((tool) => (
        <RunView key={tool.key ?? tool.id} tool={tool} />
      ))}
    </RecordRow>
  )
}

function RunView({ tool }: { tool: ToolItem }) {
  const running = tool.tool.status === 'running'
  const { spec, cut } = useViewText(tool.tool.argsPreview ?? '', running)
  return <ViewCard spec={spec} streaming={running} cut={cut} />
}
