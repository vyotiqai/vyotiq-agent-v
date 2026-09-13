import type { UiGroupTiming, UiToolRow } from '@shared/transcript'
import { mcpDoneLabel, mcpRunningLabel } from '@shared/utils/mcpToolMeta'
import {
  inferFileWriteAction,
  isUnresolvedToolName,
  mcpToolSummary,
  parseArgsRecord,
  parseMcpToolDisplay,
  summarizeToolArgs
} from '@shared/toolSummary'
import { formatElapsed } from '@shared/utils/timeFormat'
import {
  formatAgentInstanceShortId,
  parseAgentInstanceRunId,
  parseAgentInstanceRunIdFromArgs
} from '@shared/utils/agentInstance'
import {
  categoryLabels,
  getToolHeaderMeta,
  isInterruptedToolContent,
  mixedGroupLabels,
  toolCategory,
  toolLabel,
  type ToolCategory
} from '../toolUi'
import { truncateText } from '../toolUi/parsers/common'
import { parseReadLineRange } from '../toolUi/parsers/read'

export type ToolGroupCategory = ToolCategory

export type ToolGroupNestedTool = {
  id: string
  name: string
  category: ToolGroupCategory
  title: string
  subtitle: string
  status: UiToolRow['status']
  /** Material file-type icon path when the tool targets a real file. */
  filePath?: string
}

export type ToolGroupState = 'pending' | 'completed' | 'interrupted'

export type ToolGroupProps = {
  state: ToolGroupState
  nestedTools: ToolGroupNestedTool[]
  summary: string
  runningLabel: string
  doneLabel: string
  elapsedMs: number | null
  elapsedDisplay: string
  singleTool: boolean
}

const CATEGORY_COUNT_LABELS: Record<ToolGroupCategory, [singular: string, plural: string]> = {
  file: ['file', 'files'],
  edit: ['edit', 'edits'],
  search: ['lookup', 'lookups'],
  command: ['command', 'commands'],
  browse: ['directory', 'directories'],
  browser: ['action', 'actions']
}

const CATEGORY_MIXED_VERBS: Record<ToolGroupCategory, { running: string; done: string }> = {
  file: { running: 'reading', done: 'read' },
  edit: { running: 'editing', done: 'edited' },
  search: { running: 'searching', done: 'searched' },
  command: { running: 'running', done: 'ran' },
  browse: { running: 'listing', done: 'listed' },
  browser: { running: 'browsing', done: 'browsed' }
}

function capitalize(text: string): string {
  if (!text) return text
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function joinComposite(parts: string[]): string {
  if (parts.length === 0) return ''
  if (parts.length === 1) return capitalize(parts[0]!)
  if (parts.length === 2) return `${capitalize(parts[0]!)} and ${parts[1]}`
  return `${capitalize(parts[0]!)}, ${parts.slice(1, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

function compositeMixedLabels(tools: ToolGroupNestedTool[]): { running: string; done: string } {
  const counts: Record<ToolGroupCategory, number> = {
    file: 0,
    edit: 0,
    search: 0,
    command: 0,
    browse: 0,
    browser: 0
  }
  for (const tool of tools) counts[tool.category] += 1

  const order: ToolGroupCategory[] = ['file', 'browse', 'browser', 'search', 'command', 'edit']
  const active = order.filter((category) => counts[category] > 0)
  if (active.length === 0) return mixedGroupLabels()
  if (active.length === 1) return categoryLabels(active[0]!)
  // 3+ categories: short umbrella verb; counts stay in the summary chip.
  if (active.length > 2) return mixedGroupLabels()

  const running = joinComposite(active.map((category) => CATEGORY_MIXED_VERBS[category].running))
  const done = joinComposite(active.map((category) => CATEGORY_MIXED_VERBS[category].done))
  return { running, done }
}

function groupLabels(
  tools: ToolGroupNestedTool[],
  rows: UiToolRow[]
): { running: string; done: string } {
  const first = tools[0]
  const names = rows.map((row) => row.name)
  if (!first) return mixedGroupLabels()
  if (names.length > 0 && names.every((name) => name === names[0])) {
    const mcp = parseMcpToolDisplay(names[0]!)
    if (mcp) {
      return {
        running: mcpRunningLabel(mcp.toolName),
        done: mcpDoneLabel(mcp.toolName)
      }
    }
    const allCreated = rows.every(
      (row) => inferFileWriteAction(row.name, row.content) === 'created'
    )
    const specific = {
      running: toolLabel(names[0]!, 'running', rows[0]?.content),
      done: allCreated ? 'Created' : toolLabel(names[0]!, 'done')
    }
    if (specific.running !== 'Running' && specific.done !== 'Done') return specific
  }
  if (tools.every((tool) => tool.category === first.category)) {
    // Same category (e.g. glob+grep): join per-tool verbs, not the generic category label.
    const unique = [...new Set(names.filter(Boolean))]
    if (unique.length > 0) {
      const runningParts = unique.map((n) => {
        const row = rows.find((item) => item.name === n)
        return toolLabel(n, 'running', row?.content).toLowerCase()
      })
      const doneParts = unique.map((n) => {
        const row = rows.find((item) => item.name === n)
        return toolLabel(n, 'done', row?.content).toLowerCase()
      })
      if (
        runningParts.every((p) => p !== 'running') &&
        doneParts.every((p) => p !== 'done')
      ) {
        // Listing-family tools share the same verb but add different nouns
        // (`Listing`, `Listing memory`). Joining those creates noisy labels such
        // as "Listed and listed memory"; the category label already carries the
        // useful action and the summary carries the count.
        const runningVerb = runningParts.map((part) => part.split(/\s+/)[0]).filter(Boolean)
        const doneVerb = doneParts.map((part) => part.split(/\s+/)[0]).filter(Boolean)
        if (
          new Set(runningVerb).size === 1 &&
          new Set(doneVerb).size === 1
        ) {
          return categoryLabels(first.category)
        }
        return {
          running: joinComposite(runningParts),
          done: joinComposite(doneParts)
        }
      }
    }
    return categoryLabels(first.category)
  }
  return compositeMixedLabels(tools)
}

function isUnknownToolContent(content: string | undefined): boolean {
  return /^Unknown tool[:\s"]/i.test((content ?? '').trim())
}

function toolSubtitle(tool: UiToolRow): string {
  if (isUnresolvedToolName(tool.name)) return ''
  // Unknown builtins: never promote args.path (e.g. "placeholder") as the subtitle.
  if (isUnknownToolContent(tool.content)) return ''
  if (
    tool.name === 'spawn_agent_instance' ||
    tool.name === 'await_agent_instance' ||
    tool.name === 'pull_agent_instance' ||
    tool.name === 'merge_agent_instance'
  ) {
    const runId =
      parseAgentInstanceRunId(tool.content) ?? parseAgentInstanceRunIdFromArgs(tool.argsPreview)
    if (runId) return formatAgentInstanceShortId(runId)
  }
  const summary = tool.summary?.trim() || summarizeToolArgs(tool.name, tool.argsPreview)
  if (!summary) {
    // ask_question with no recoverable title must not render "Asked …".
    if (tool.name === 'ask_question') return ''
    return '…'
  }
  if (tool.name === 'terminal') return summary.slice(0, 80)
  if (tool.name === 'read' || tool.name === 'edit' || tool.name === 'str_replace' || tool.name === 'delete') {
    const parts = summary.split(/[/\\]/)
    const file = parts[parts.length - 1] || summary
    const range = tool.name === 'read' ? parseReadLineRange(tool) : ''
    return range ? `${file} ${range}` : file
  }
  const mcp = parseMcpToolDisplay(tool.name)
  if (mcp) {
    const args = parseArgsRecord(tool.argsPreview)
    if (args) {
      const fromMcp = mcpToolSummary(mcp.toolName, args)
      if (fromMcp) return truncateText(fromMcp, 80)
    }
  }
  return truncateText(summary, 80)
}

function nestedRowTitle(tool: UiToolRow, subtitle: string, inGroup: boolean): string {
  // Unknown tool rows: show humanized name, not args.path ("placeholder").
  if (isUnknownToolContent(tool.content)) {
    return toolLabel(tool.name, tool.status, tool.content)
  }
  if (inGroup) {
    // Group header already shows Preparing… — avoid repeating it on each row.
    if (isUnresolvedToolName(tool.name)) return ''
    // Keep a directory listing visibly distinct from a later read of the same
    // path. The path remains the subtitle, so the chronological actions are
    // both preserved without relying on filename repetition alone.
    if (tool.name === 'list_dir') return toolLabel(tool.name, tool.status, tool.content)
    if (subtitle && subtitle !== '…' && subtitle !== tool.name) return subtitle
    const preview = tool.argsPreview?.trim()
    if (preview) {
      const fromArgs = toolSubtitle({ ...tool, argsPreview: preview })
      if (fromArgs && fromArgs !== '…' && fromArgs !== tool.name) return fromArgs
    }
    if (tool.name && tool.name !== 'tool') {
      const summary = tool.summary?.trim()
      if (summary && summary !== tool.name) return truncateText(summary, 80)
    }
  }
  if (tool.status === 'running' && isUnresolvedToolName(tool.name)) {
    return 'Preparing…'
  }
  return toolLabel(tool.name, tool.status, tool.content)
}

function formatCount(value: number, label: string, plural: string): string {
  return `${value} ${value === 1 ? label : plural}`
}

function summarizeCounts(tools: ToolGroupNestedTool[]): string {
  // Unresolved streaming names default to category "file" — exclude them so the
  // header does not read "Preparing… 2 files".
  const counted = tools.filter((tool) => !isUnresolvedToolName(tool.name))
  const counts: Record<ToolGroupCategory, number> = {
    file: 0,
    edit: 0,
    search: 0,
    command: 0,
    browse: 0,
    browser: 0
  }
  for (const tool of counted) counts[tool.category] += 1

  const parts: string[] = []
  if (counts.file > 0) {
    const [s, p] = CATEGORY_COUNT_LABELS.file
    parts.push(formatCount(counts.file, s, p))
  }
  if (counts.edit > 0) {
    const [s, p] = CATEGORY_COUNT_LABELS.edit
    parts.push(formatCount(counts.edit, s, p))
  }
  if (counts.search > 0) {
    const [s, p] = CATEGORY_COUNT_LABELS.search
    parts.push(formatCount(counts.search, s, p))
  }
  if (counts.command > 0) {
    const [s, p] = CATEGORY_COUNT_LABELS.command
    parts.push(formatCount(counts.command, s, p))
  }
  if (counts.browse > 0) {
    const browseTools = counted.filter((tool) => tool.category === 'browse')
    const directoryCount = browseTools.filter((tool) => tool.name === 'list_dir').length
    const memoryCount = browseTools.filter((tool) => tool.name === 'memory_list').length
    const otherCount = browseTools.length - directoryCount - memoryCount
    if (directoryCount > 0) {
      const [s, p] = CATEGORY_COUNT_LABELS.browse
      parts.push(formatCount(directoryCount, s, p))
    }
    if (memoryCount > 0) {
      parts.push(formatCount(memoryCount, 'memory listing', 'memory listings'))
    }
    if (otherCount > 0) {
      parts.push(formatCount(otherCount, 'listing', 'listings'))
    }
  }
  if (counts.browser > 0) {
    const [s, p] = CATEGORY_COUNT_LABELS.browser
    parts.push(formatCount(counts.browser, s, p))
  }

  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]!
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

function isInterrupted(tools: UiToolRow[]): boolean {
  return tools.some((tool) => isInterruptedToolContent(tool.content))
}

function deriveState(tools: UiToolRow[]): ToolGroupState {
  // A closed groupTiming only proves the first tool finished — a sibling can
  // still be running, and the group must read as live until every tool settles.
  if (tools.some((tool) => tool.status === 'running')) return 'pending'
  if (isInterrupted(tools)) return 'interrupted'
  return 'completed'
}

export function mapToolGroupProps(
  tools: UiToolRow[],
  options: {
    groupTiming?: UiGroupTiming
  }
): ToolGroupProps {
  const inGroup = tools.length > 1
  const nestedTools: ToolGroupNestedTool[] = tools.map((tool) => {
    const subtitle = toolSubtitle(tool)
    const meta = getToolHeaderMeta(tool)
    return {
      id: tool.id,
      name: tool.name,
      category: toolCategory(tool.name),
      title: nestedRowTitle(tool, subtitle, inGroup),
      subtitle: inGroup && tool.name !== 'list_dir' ? '' : subtitle,
      status: tool.status,
      ...(meta.filePath ? { filePath: meta.filePath } : {})
    }
  })

  const state = deriveState(tools)
  const { groupTiming } = options

  let elapsedMs: number | null = null
  if (groupTiming?.startedAt != null) {
    if (groupTiming.endedAt != null) elapsedMs = groupTiming.endedAt - groupTiming.startedAt
    else if (state === 'pending') elapsedMs = Date.now() - groupTiming.startedAt
  }

  const labels = groupLabels(nestedTools, tools)
  // Interrupted groups never completed — header uses the in-progress verb.
  const settledLabel = state === 'interrupted' ? labels.running : labels.done

  return {
    state,
    nestedTools,
    summary: summarizeCounts(nestedTools),
    runningLabel: labels.running,
    doneLabel: settledLabel,
    elapsedMs,
    elapsedDisplay: elapsedMs != null && elapsedMs >= 1000 ? formatElapsed(elapsedMs) : '',
    singleTool: tools.length === 1
  }
}
