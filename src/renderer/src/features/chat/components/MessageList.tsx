import { Fragment, memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAppVirtualizer } from '@renderer/lib/hooks/useAppVirtualizer'
import { Icon } from '@renderer/lib/icons'
import { Tooltip, cn, ImageLightbox, MarkdownContent } from '@renderer/lib/ui'
import {
  focusComposerMessage,
  isEditableShortcutTarget,
  isMainComposerTarget,
  matchShortcut
} from '@renderer/lib/shortcuts'
import {
  findTranscriptRowMatches,
  isChangesOrPrDockClaimingFind,
  wrapMatchIndex
} from '@renderer/lib/chat/transcriptFind'
import type { TurnOutcome, UiAgentQuestionAnswer, UiItem } from '@shared/transcript'
import type { ToolApprovalDecision } from '@shared/ipc'
import { isRetryableTurnFailure } from '@shared/errors'
import {
  CHAT_COLUMN,
  CHAT_GUTTER,
  CHAT_STAGE_INSET,
  CHAT_STAGE_TOP_INSET,
  COMPOSER_DOCK_CLEARANCE_PX,
  COMPOSER_DOCK_RESERVE_VAR,
  COMPOSER_FLOAT_BOTTOM_INSET_PX,
  TRANSCRIPT_CONTAINER,
  TOOL_BODY_CLAMP_PX,
  TOOL_GROUP_LIST_ESTIMATE_MIN_PX,
  TOOL_TERMINAL_VIEWPORT_MAX_PX,
  TRANSCRIPT_ROW_GAP,
  TRANSCRIPT_TURN_GAP,
  TRANSCRIPT_WORK_PAIR_GAP,
  TRANSCRIPT_WORK_ROW_GAP,
  DISCLOSURE_ROW
} from '@renderer/lib/utils/layout'
import {
  buildTranscriptRows,
  isTurnWorkRow,
  rowLeadingGap,
  stabilizeTranscriptRows,
  transcriptRowFingerprint,
  turnHasClosingAnswer,
  turnHasVisibleToolWork,
  type AssistantItem,
  type TranscriptRow,
  timestampMs
} from '../utils/transcriptRows'
import type { StepUsageTotals } from '@shared/utils/runTelemetry'
import type { ChatItemsStore, ChatMetaStore } from '../chatStores'
import { useChatLiveItems, useResolvedTurnUsage } from './ChatStreamLeaves'
import { resolveTasksAnchorUserId } from '../utils/tasksAnchor'
import {
  compactActivityFromRows,
  formatRunActivityLabel
} from '../utils/runActivity'
import { buildFooterStats } from '../utils/messageFooterStats'
import { ChangeSummary, COMPACT_PREVIEW_COUNT } from './ChangeSummary'
import { TextShimmer } from './TextShimmer'
import { MessageFooter } from './MessageFooter'
import { AgentContextCard } from './AgentContextCard'
import { ThinkingBlock } from './ThinkingBlock'
import { CompactSummaryBlock } from './CompactSummaryBlock'
import { ToolApprovalCard } from './ToolApprovalCard'
import { AskQuestionPanel } from './AskQuestionPanel'
import { ToolCard } from './ToolCard'
import { ToolGroup } from './ToolGroup'
import { TurnSummary } from './TurnSummary'
import { UserPrompt } from './UserPrompt'
import { TasksCeilingBand } from './TasksCeilingBand'
import { shouldRenderThinking } from '@shared/transcript'
import {
  formatCitationsForCopy,
  resolveInlineCitations,
  type CitationCatalogEntry
} from '@shared/utils/inlineCitations'
import { toolHasBody, toolDefaultExpanded, toolUsesPeekCollapse } from '../toolUi'
import { collectTurnCitationCatalogs } from '../utils/citationCatalog'
import { useRunSession } from '../RunSessionContext'

/** Stable id on the first work row of a turn (region landmark / tests). */
function turnWorkPanelId(
  row: TranscriptRow,
  rows: readonly TranscriptRow[],
  index: number
): string | undefined {
  if (!isTurnWorkRow(row)) return undefined
  for (let i = 0; i < index; i += 1) {
    const prior = rows[i]!
    if (isTurnWorkRow(prior) && prior.turnIndex === row.turnIndex) return undefined
  }
  return `turn-work-${row.turnIndex}`
}

/** ~chars per visual line in the 840px chat column at text-sm. */
const CHARS_PER_LINE = 65
const EMPTY_CITATION_CATALOG: CitationCatalogEntry[] = []
/** Line height for text-sm + leading-relaxed (1.625 × 13px). */
const LINE_PX = 21

function appearanceMeasureScale(): number {
  if (typeof document === 'undefined') return 1
  const style = getComputedStyle(document.documentElement)
  const font = Number.parseFloat(style.getPropertyValue('--vy-font-scale')) || 1
  const density = Number.parseFloat(style.getPropertyValue('--vy-density-scale')) || 1
  return font * density
}

/**
 * First-paint height guesses for the virtualizer.
 * Collapsed Thought/Read stay near disclosure height (~44–52). Text/user
 * must not under-estimate — that stacks absolute rows on top of each other.
 */
export function estimateTranscriptRowSize(row: TranscriptRow | undefined): number {
  if (!row) return 48
  const scale = appearanceMeasureScale()
  const linePx = LINE_PX * scale
  const bodyClampPx = TOOL_BODY_CLAMP_PX * scale
  switch (row.kind) {
    case 'turn':
      return 40
    case 'thinking':
      return row.item.thinkingStreaming || row.item.thinkingExpanded ? 116 : 44
    case 'user': {
      const len = row.item.content?.length ?? 0
      const media =
        (row.item.images?.length ?? 0) + (row.item.attachments?.length ?? 0)
      // UserPrompt clamps body at TOOL_BODY_CLAMP_PX when overflowing.
      const bodyLines = Math.max(1, Math.ceil(len / CHARS_PER_LINE))
      const body = Math.min(bodyClampPx, 28 * scale + bodyLines * linePx)
      const chrome = 40 + (media > 0 ? 36 : 0) + (len > 400 ? 22 : 0)
      return chrome + body
    }
    case 'text': {
      const content = row.item.content
      const newlines = content.split('\n').length
      const fromChars = Math.ceil(content.length / CHARS_PER_LINE)
      const lines = Math.max(1, newlines, fromChars)
      const base = 40 * scale + lines * linePx
      // Prefer slight overestimate over overlap; measureElement corrects mounted rows.
      if (row.item.streaming) return Math.min(1200, base)
      return Math.min(2400, base)
    }
    case 'activity': {
      const pending = row.tools.some((t) => t.tool.status === 'running')
      const groupExpanded = row.tools[0]?.groupExpanded === true
      const toolExpanded = row.tools.some((t) => t.toolExpanded === true)
      const hasFailure = row.tools.some((t) => t.tool.status === 'fail')
      const multi = row.tools.length > 1
      if (multi) {
        // Collapsed multi-tool groups ignore stale per-tool expand flags. The
        // nested rows stay in the transcript's flow, so estimate from the
        // number of rows instead of an inner viewport that no longer exists.
        // Failed tools keep the group open (same policy as ToolGroup / toolDefaultExpanded).
        if (pending || groupExpanded || hasFailure) {
          const rowEstimate = Math.max(
            TOOL_GROUP_LIST_ESTIMATE_MIN_PX,
            row.tools.length * 32
          )
          return 48 + rowEstimate
        }
        return 48
      }
      const lone = row.tools[0]!
      const autoOpen = toolDefaultExpanded(lone.tool.name, lone.tool.status)
      // Lone running tools auto-expand; file reads + diffs stay compact.
      if (autoOpen || toolExpanded || groupExpanded) {
        if (lone.tool.name === 'terminal') return 56 + TOOL_TERMINAL_VIEWPORT_MAX_PX
        return 56 + TOOL_BODY_CLAMP_PX
      }
      return 48
    }
    case 'card': {
      const autoOpen = toolDefaultExpanded(row.item.tool.name, row.item.tool.status)
      const expanded =
        row.item.toolExpanded === true || (autoOpen && row.item.toolExpanded !== false)
      const hasBody = toolHasBody(row.item.tool, {
        toolProgress: row.item.toolProgress
      })
      const peekCollapse = toolUsesPeekCollapse(row.item.tool.name)
      // Terminal output is always capped inside TOOL_TERMINAL_VIEWPORT — do not
      // add the old unbounded +80 fudge that assumed growing transcript height.
      if (row.item.tool.name === 'terminal') {
        if (expanded) return 56 + TOOL_TERMINAL_VIEWPORT_MAX_PX
        // Panel fold: collapsed terminal unmounts body (no clamp stub).
        return 56
      }
      if (expanded) return 56 + TOOL_BODY_CLAMP_PX + 80
      // Peek tools keep a clamped body when collapsed; panel tools fully fold.
      if (hasBody && peekCollapse) return 56 + TOOL_BODY_CLAMP_PX
      return 56
    }
    case 'changes': {
      // Compact receipt: header + preview rows (+ optional Show more footer).
      const preview = Math.min(row.files.length, COMPACT_PREVIEW_COUNT)
      const moreFooter = row.files.length > COMPACT_PREVIEW_COUNT ? 28 : 0
      return 40 + preview * 28 + moreFooter
    }
    case 'approval':
      return 280
    case 'question': {
      // Prefer overestimate — under-sized slots clip tall multi-question gates.
      // Header+footer ~72; prompt ~28; option row ~28; boolean ~40; text ~72.
      let body = 0
      for (const q of row.question.questions) {
        body += 28
        if (q.type === 'text') body += 72
        else if (q.type === 'boolean') body += 40
        else body += Math.max(2, q.options?.length ?? 2) * 28
      }
      return Math.max(320, 72 + body)
    }
    case 'run_error':
      return 72
    case 'compaction':
      return row.expanded === false ? 44 : 280
    default: {
      const _exhaustive: never = row
      return _exhaustive
    }
  }
}

/**
 * Cheap revision string so streaming content growth re-measures without a length
 * change. Tail-follow only cares about the bottom of the transcript, and only the
 * trailing row grows during a stream (its id is stable, its content fingerprint
 * changes) — so a single last-row fingerprint is equivalent to a full O(n) join.
 */
export function transcriptRowsContentRevision(rows: readonly TranscriptRow[]): string {
  if (rows.length === 0) return ''
  return transcriptRowFingerprint(rows[rows.length - 1]!)
}

/** Vertical inset of the pinned turn prompt below the scrollport's top edge. */
const STICKY_TURN_TOP_PX = 10

/** Minimum pin slack when no dock reserve is known yet. */
const NEAR_BOTTOM_MIN_PX = 80
/**
 * Tail-follow can set scrollTop to a stale scrollHeight; the scroll event then
 * lands slightly short of the new bottom. Treat that lag as still pinned so the
 * live user prompt is not left just above the fold with a "Latest N" chip.
 */
const FOLLOW_LAG_PX = 240

/**
 * Bottom reserve added to the scrollport while the "Latest" chip is showing.
 *
 * The chip is a zero-height sticky row (`h-0`, `-translate-y-full`), so it
 * floats over whatever the last row happens to be — usually a Thought header —
 * and covers it. Reserving its height in the scroll container lifts the content
 * out from under it, and costs nothing once the reader is pinned to the bottom.
 */
const JUMP_TO_BOTTOM_CLEARANCE_PX = 40

/**
 * Virtualize only long idle transcripts that never streamed in this mount.
 * Live runs (and the idle view right after them) stay in document flow so a
 * cold virtualizer cannot invent black gaps / overlapping absolute slots.
 */
const VIRTUALIZE_MIN_ROWS = 160

/**
 * During a live run, keep only this many trailing rows in document flow. Older
 * rows in the same turn are virtualized — one user prompt with dozens of agent
 * steps otherwise mounts the entire transcript and freezes the renderer.
 */
const HYBRID_FLOW_TAIL_ROWS = 40

/** Keep document flow briefly after a live run ends so heights settle before virtualizing. */
const POST_LIVE_FLOW_HOLD_MS = 800

type TranscriptLayoutMode = 'flow' | 'hybrid' | 'full-virtual'

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

function nearBottomThreshold(): number {
  return NEAR_BOTTOM_MIN_PX
}

/** Structure for tail-follow — ids only; tool status churn must not yank scroll. */
function structuralKey(items: UiItem[]): string {
  return items.map((item) => item.id).join('|')
}

/** Topmost visible row in global displayRows coordinates. */
export function captureScrollAnchor(
  el: HTMLElement,
  flowStartIndex: number,
  virtualItemIndices: readonly number[]
): { index: number; offsetPx: number } | null {
  const containerTop = el.getBoundingClientRect().top

  const liveFlow = el.querySelector('[data-live-turn-flow]')
  if (liveFlow) {
    const rows = liveFlow.querySelectorAll('[data-transcript-row]')
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i]!.getBoundingClientRect()
      if (rect.bottom > containerTop + 1) {
        const attr = rows[i]!.getAttribute('data-transcript-row')
        return {
          index: attr != null ? Number(attr) : flowStartIndex + i,
          offsetPx: containerTop - rect.top
        }
      }
    }
  }

  for (const index of virtualItemIndices) {
    const node = el.querySelector(`[data-index="${index}"]`)
    if (!node) continue
    const rect = node.getBoundingClientRect()
    if (rect.bottom > containerTop + 1) {
      return { index, offsetPx: containerTop - rect.top }
    }
  }

  const column = el.querySelector('[data-chat-column]')
  if (column && column !== liveFlow) {
    const isVirtualColumn =
      column instanceof HTMLElement &&
      column.style.height !== '' &&
      column.querySelector('.absolute')
    if (!isVirtualColumn) {
      const rows = column.querySelectorAll('[data-transcript-row]')
      for (let i = 0; i < rows.length; i++) {
        const rect = rows[i]!.getBoundingClientRect()
        if (rect.bottom > containerTop + 1) {
          const attr = rows[i]!.getAttribute('data-transcript-row')
          return {
            index: attr != null ? Number(attr) : i,
            offsetPx: containerTop - rect.top
          }
        }
      }
    }
  }

  return null
}

/** Spacing as padding (not margin) so row rhythm stays consistent. */
function rowSpacingClass(row: TranscriptRow, next?: TranscriptRow): string {
  if (row.kind === 'turn') {
    return cn('pt-1', TRANSCRIPT_ROW_GAP)
  }
  const isWork =
    row.kind === 'activity' ||
    row.kind === 'thinking' ||
    row.kind === 'card' ||
    row.kind === 'changes'
  const tightPair =
    (row.kind === 'thinking' && (next?.kind === 'activity' || next?.kind === 'card')) ||
    ((row.kind === 'activity' || row.kind === 'card') && next?.kind === 'thinking')
  const gap = tightPair
    ? TRANSCRIPT_WORK_PAIR_GAP
    : isWork
      ? TRANSCRIPT_WORK_ROW_GAP
      : TRANSCRIPT_ROW_GAP
  return cn(gap, rowLeadingGap(row) > 0 && TRANSCRIPT_TURN_GAP)
}

/** User bubble; optionally mounts the tasks band directly underneath. */
function TranscriptUserPrompt({
  item,
  onImageClick,
  editingUserMessageIndex = null,
  editComposer,
  onBeginEditUserMessage,
  onRevertUserMessage,
  messageCount = 0,
  running = false,
  pendingRun = false,
  showTasksBand = false
}: {
  item: Extract<TranscriptRow, { kind: 'user' }>['item']
  onImageClick: (url: string, label: string) => void
  editingUserMessageIndex?: number | null
  editComposer?: ReactNode
  onBeginEditUserMessage?: (messageIndex: number) => void
  onRevertUserMessage?: (messageIndex: number) => void
  messageCount?: number
  running?: boolean
  pendingRun?: boolean
  showTasksBand?: boolean
}) {
  const match = /^user-(\d+)$/.exec(item.id)
  const userIndex = match ? Number(match[1]) : -1
  const canRevert =
    userIndex >= 0 &&
    messageCount > userIndex + 1 &&
    !running &&
    !pendingRun &&
    editingUserMessageIndex == null
  return (
    <>
      <UserPrompt
        item={item}
        onImageClick={onImageClick}
        editing={editingUserMessageIndex != null && item.id === `user-${editingUserMessageIndex}`}
        editComposer={
          editingUserMessageIndex != null && item.id === `user-${editingUserMessageIndex}`
            ? editComposer
            : undefined
        }
        onBeginEdit={
          onBeginEditUserMessage && editingUserMessageIndex == null
            ? () => {
                if (userIndex < 0) return
                onBeginEditUserMessage(userIndex)
              }
            : undefined
        }
        canRevert={canRevert}
        onRevert={
          onRevertUserMessage && canRevert
            ? () => {
                if (userIndex < 0) return
                onRevertUserMessage(userIndex)
              }
            : undefined
        }
      />
      {showTasksBand ? (
        <TasksCeilingBand key={item.id} running={running} className="mt-1" />
      ) : null}
    </>
  )
}

function footerTurnSpan(
  rows: readonly TranscriptRow[],
  turnIndex: number,
  item: AssistantItem,
  live: boolean,
  terminalStatus?: TurnOutcome | null
): {
  startedAt: number | null
  endedAt: number | null
  active: boolean
  hasTurnSummary: boolean
  status?: TurnOutcome
} {
  for (const row of rows) {
    if (row.kind === 'turn' && row.turnIndex === turnIndex) {
      return {
        startedAt: row.span.startedAt,
        endedAt: row.span.endedAt,
        active: row.span.active,
        hasTurnSummary: true,
        status: row.span.status
      }
    }
  }
  let startedAt: number | null = null
  for (const row of rows) {
    if (row.kind === 'user' && row.turnIndex === turnIndex) {
      startedAt = timestampMs(row.item.at)
      break
    }
  }
  return {
    startedAt,
    endedAt: timestampMs(item.at),
    active: live && item.streaming === true,
    hasTurnSummary: false,
    ...(terminalStatus ? { status: terminalStatus } : {})
  }
}

function AssistantTextRow({
  item,
  final,
  catalog,
  onOpenWorkspaceFile,
  startedAt = null,
  endedAt = null,
  active = false,
  usage = null,
  turnStatus = null,
  omitReceipt = false,
  omitDuration = false
}: {
  item: AssistantItem
  final: boolean
  catalog: readonly CitationCatalogEntry[]
  onOpenWorkspaceFile?: (path: string, options?: { line?: number }) => void
  startedAt?: number | null
  endedAt?: number | null
  active?: boolean
  usage?: StepUsageTotals | null
  turnStatus?: TurnOutcome | null
  omitReceipt?: boolean
  omitDuration?: boolean
}) {
  const resolved = useMemo(
    () => resolveInlineCitations(item.content, catalog),
    [item.content, catalog]
  )
  const copyContent = useMemo(
    () => formatCitationsForCopy(item.content, catalog),
    [item.content, catalog]
  )

  return (
    <div className="group/message">
      <MarkdownContent
        content={resolved.markdown}
        streaming={item.streaming}
        linkWorkspacePaths
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
      {final ? (
        <MessageFooter
          content={item.content}
          copyContent={copyContent}
          at={item.at}
          startedAt={startedAt}
          endedAt={endedAt}
          active={active}
          usage={usage}
          omitReceipt={omitReceipt}
          omitDuration={omitDuration}
          copyHidden={
            item.streaming === true ||
            (turnStatus != null && turnStatus !== 'done')
          }
        />
      ) : null}
    </div>
  )
}

const TranscriptRowBlock = memo(function TranscriptRowBlock({
  row,
  onImageClick,
  onLoadToolContent,
  onThinkingToggle,
  onToolToggle,
  onGroupToggle,
  onTurnToggle,
  onApprovalDecision,
  onQuestionSubmit,
  onRetryNetwork,
  autoFocusApproval = true,
  turnCollapsed = false,
  showThinking = true,
  live = false,
  suppressPhaseLabel = false,
  mcpServerNames,
  onOpenChanges,
  editingUserMessageIndex = null,
  editComposer,
  onBeginEditUserMessage,
  onRevertUserMessage,
  messageCount = 0,
  running = false,
  pendingRun = false,
  showTasksBand = false,
  citationCatalog = EMPTY_CITATION_CATALOG,
  footerStartedAt = null,
  footerEndedAt = null,
  footerActive = false,
  footerUsage = null,
  footerStatus = null,
  footerOmitReceipt = false,
  footerOmitDuration = false
}: {
  row: TranscriptRow
  onImageClick: (url: string, label: string) => void
  onLoadToolContent?: (toolCallId: string) => Promise<string | null>
  onThinkingToggle?: (messageId: string, expanded: boolean) => void
  onToolToggle?: (toolCallId: string, expanded: boolean) => void
  onGroupToggle?: (anchorToolCallId: string, expanded: boolean) => void
  onTurnToggle?: (turnIndex: number) => void
  onApprovalDecision?: (requestId: string, decision: ToolApprovalDecision) => void | Promise<void>
  onQuestionSubmit?: (requestId: string, answers: UiAgentQuestionAnswer[]) => void | Promise<void>
  /** Retry affordance for retryable run_error rows. */
  onRetryNetwork?: () => void
  autoFocusApproval?: boolean
  turnCollapsed?: boolean
  showThinking?: boolean
  live?: boolean
  /** Live expanded with tool rows visible — TurnSummary skips duplicate phase label. */
  suppressPhaseLabel?: boolean
  mcpServerNames?: ReadonlyMap<string, string>
  onOpenChanges?: (path?: string) => void
  editingUserMessageIndex?: number | null
  editComposer?: ReactNode
  onBeginEditUserMessage?: (messageIndex: number) => void
  onRevertUserMessage?: (messageIndex: number) => void
  messageCount?: number
  running?: boolean
  pendingRun?: boolean
  /** Mount TasksCeilingBand under this user prompt (task-owning turn). */
  showTasksBand?: boolean
  citationCatalog?: readonly CitationCatalogEntry[]
  footerStartedAt?: number | null
  footerEndedAt?: number | null
  footerActive?: boolean
  footerUsage?: StepUsageTotals | null
  footerStatus?: TurnOutcome | null
  footerOmitReceipt?: boolean
  footerOmitDuration?: boolean
}) {
  const { onOpenWorkspaceFile } = useRunSession()

  if (row.kind === 'user') {
    return (
      <TranscriptUserPrompt
        item={row.item}
        onImageClick={onImageClick}
        editingUserMessageIndex={editingUserMessageIndex}
        editComposer={editComposer}
        onBeginEditUserMessage={onBeginEditUserMessage}
        onRevertUserMessage={onRevertUserMessage}
        messageCount={messageCount}
        running={running}
        pendingRun={pendingRun}
        showTasksBand={showTasksBand}
      />
    )
  }

  if (row.kind === 'turn') {
    return (
      <TurnSummary
        span={row.span}
        collapsed={turnCollapsed}
        controlsId={`turn-work-${row.turnIndex}`}
        suppressPhaseLabel={suppressPhaseLabel}
        usage={footerUsage}
        onToggle={onTurnToggle ? () => onTurnToggle(row.turnIndex) : undefined}
      />
    )
  }

  if (row.kind === 'thinking') {
    if (!showThinking) return null
    return (
      <ThinkingBlock
        content={row.item.thinking ?? ''}
        streaming={row.item.thinkingStreaming}
        expanded={row.item.thinkingExpanded}
        onToggle={
          onThinkingToggle ? (next) => onThinkingToggle(row.item.id, next) : undefined
        }
      />
    )
  }

  if (row.kind === 'text') {
    return (
      <AssistantTextRow
        item={row.item}
        final={row.final}
        catalog={citationCatalog}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        startedAt={footerStartedAt}
        endedAt={footerEndedAt}
        active={footerActive}
        usage={footerUsage}
        turnStatus={footerStatus}
        omitReceipt={footerOmitReceipt}
        omitDuration={footerOmitDuration}
      />
    )
  }

  if (row.kind === 'run_error') {
    // Terminal errors lose the composer banner (suppressed when this row
    // exists) — carry the retry affordance here so transient failures keep it.
    const canRetry =
      Boolean(onRetryNetwork) && isRetryableTurnFailure({ errorCode: row.code })
    return (
      <div
        className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger [overflow-wrap:anywhere]"
        role="alert"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0">{row.message}</span>
          {canRetry ? (
            <button
              type="button"
              className="shrink-0 rounded-xl border border-border px-2 py-0.5 text-caption font-medium text-fg transition-colors hover:bg-surface"
              onClick={onRetryNetwork}
            >
              Retry
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  if (row.kind === 'compaction') {
    return (
      <CompactSummaryBlock
        summary={row.summary}
        tokenEstimate={row.tokenEstimate}
        expanded={row.expanded}
        verifyStatus={row.verifyStatus}
        verifyFailures={row.verifyFailures}
        verifyCoverage={row.verifyCoverage}
      />
    )
  }

  if (row.kind === 'changes') {
    // Receipt only — Keep/Discard lives in the Changes panel (Review).
    return <ChangeSummary files={row.files} compact onOpenChanges={onOpenChanges} />
  }

  if (row.kind === 'approval') {
    return (
      <ToolApprovalCard
        approval={row.approval}
        onDecide={onApprovalDecision}
        captureFocus={autoFocusApproval}
      />
    )
  }

  if (row.kind === 'question') {
    return <AskQuestionPanel question={row.question} onSubmit={onQuestionSubmit} />
  }

  if (row.kind === 'activity') {
    // Prefer per-item toolExpanded so siblings keep toolDefaultExpanded when
    // only one tool has an explicit expand flag (do not pass a Set that blanks them).
    const anchor = row.tools[0]!
    return (
      <ToolGroup
        tools={row.tools}
        groupExpanded={anchor.groupExpanded}
        live={live}
        onGroupToggle={
          onGroupToggle ? (expanded) => onGroupToggle(anchor.id, expanded) : undefined
        }
        onToolToggle={onToolToggle}
        onLoadFullContent={onLoadToolContent}
        mcpServerNames={mcpServerNames}
      />
    )
  }

  if (row.kind === 'card') {
    return (
      <ToolCard
        item={row.item}
        expanded={row.item.toolExpanded}
        // Without a host that persists the choice the card owns its own state,
        // so it still opens instead of swallowing the click.
        onToggle={onToolToggle ? (next) => onToolToggle(row.item.id, next) : undefined}
        onLoadFullContent={onLoadToolContent}
        mcpServerNames={mcpServerNames}
      />
    )
  }

  return null
})

export function MessageList({
  items: itemsProp,
  itemsStore,
  emptyLabel,
  workspacePath,
  restoreScrollTop,
  scrollRestoreToken,
  onScrollTopChange,
  onActivate,
  onLoadToolContent,
  onThinkingToggle,
  onToolToggle,
  onGroupToggle,
  onTurnToggle,
  onApprovalDecision,
  onQuestionSubmit,
  onRetryNetwork,
  approvalAutoFocus = true,
  collapsedTurns,
  showThinking = true,
  mcpServerNames,
  pendingRun = false,
  running = false,
  networkWait = null,
  compacting = false,
  turnFailed = false,
  turnFailureLabel = null,
  turnStatus = null,
  transcriptLoading = false,
  virtualizeLiveEarly = false,
  onOpenChanges,
  sideRailPad = false,
  editingUserMessageIndex = null,
  editComposer,
  onBeginEditUserMessage,
  onRevertUserMessage,
  messageCount = 0,
  turnUsage,
  metaStore
}: {
  items: UiItem[]
  itemsStore?: ChatItemsStore
  /** Orientation text for a fresh transcript (e.g. "New chat in demo"); hidden while pending/running. */
  emptyLabel?: string
  /** Fresh-chat only: workspace root backing the read-only agent context card. */
  workspacePath?: string
  restoreScrollTop?: number
  scrollRestoreToken?: number
  onScrollTopChange?: (scrollTop: number) => void
  onActivate?: () => void
  onLoadToolContent?: (toolCallId: string) => Promise<string | null>
  onThinkingToggle?: (messageId: string, expanded: boolean) => void
  onToolToggle?: (toolCallId: string, expanded: boolean) => void
  onGroupToggle?: (anchorToolCallId: string, expanded: boolean) => void
  onTurnToggle?: (turnIndex: number) => void
  onApprovalDecision?: (requestId: string, decision: ToolApprovalDecision) => void | Promise<void>
  onQuestionSubmit?: (requestId: string, answers: UiAgentQuestionAnswer[]) => void | Promise<void>
  /** Retry affordance for retryable run_error rows (banner is suppressed at terminal). */
  onRetryNetwork?: () => void
  /** Autofocus Allow once only when this transcript is the focused visible pane. */
  approvalAutoFocus?: boolean
  /** Persisted turn-summary collapse state from the chat stream controller. */
  collapsedTurns?: ReadonlySet<number>
  showThinking?: boolean
  mcpServerNames?: ReadonlyMap<string, string>
  pendingRun?: boolean
  running?: boolean
  networkWait?: {
    attempt: number
    maxAttempts: number
    retryInMs: number
    code?: string
  } | null
  compacting?: boolean
  turnFailed?: boolean
  turnFailureLabel?: string | null
  turnStatus?: TurnOutcome | null
  /** True while the selected chat transcript is still loading. */
  transcriptLoading?: boolean
  /** Hybrid-virtualize live transcripts without waiting for 160 rows. */
  virtualizeLiveEarly?: boolean
  onOpenChanges?: (path?: string) => void
  /** When false, use symmetric gutter (immersive Agent — no floating side rail). */
  sideRailPad?: boolean
  editingUserMessageIndex?: number | null
  editComposer?: ReactNode
  onBeginEditUserMessage?: (messageIndex: number) => void
  onRevertUserMessage?: (messageIndex: number) => void
  messageCount?: number
  /** Per UI-turn usage, aligned with transcript `turnIndex`. */
  turnUsage?: readonly StepUsageTotals[]
  /** Live meta store — receipt updates without waiting for ChatView to re-render. */
  metaStore?: ChatMetaStore
}) {
  const items = useChatLiveItems(itemsStore, itemsProp)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const appliedRestoreRef = useRef<number | null>(null)
  const restoreScrollTopRef = useRef<number | null>(
    typeof restoreScrollTop === 'number' ? restoreScrollTop : null
  )
  const restorePendingRef = useRef(typeof restoreScrollTop === 'number')
  const pinnedToBottomRef = useRef(typeof restoreScrollTop !== 'number')
  const hasPendingQuestionRef = useRef(false)
  const programmaticScrollRef = useRef(false)
  const lastScrollTopRef = useRef(0)
  const seenUserRowIdRef = useRef<string | null | undefined>(undefined)
  const autoScrollRafRef = useRef<number | null>(null)
  const [scrollRestored, setScrollRestored] = useState(() => typeof restoreScrollTop !== 'number')
  const [isUnpinned, setIsUnpinned] = useState(false)
  const [unpinnedNewCount, setUnpinnedNewCount] = useState(0)
  const unpinnedSeenIdsRef = useRef<Set<string> | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const openedFindFromComposerRef = useRef(false)
  const [lightbox, setLightbox] = useState<{ url: string; label: string } | null>(null)
  /** Topmost visible row while in flow layout — restores position after virtualization flips on. */
  const flowAnchorRef = useRef<{ index: number; offsetPx: number } | null>(null)
  const shouldVirtualizeRef = useRef(false)
  const flowStartIndexRef = useRef(0)
  const rowVirtualizerRef = useRef<ReturnType<typeof useAppVirtualizer> | null>(null)
  const prevLayoutModeRef = useRef<TranscriptLayoutMode>('flow')
  const scrollBeforeLayoutChangeRef = useRef(0)
  const pendingFullVirtualScrollRef = useRef<number | null>(null)
  const collapsedTurnSet = useMemo(
    () => collapsedTurns ?? new Set<number>(),
    [collapsedTurns]
  )
  const prevStructuralKeyRef = useRef<string | null>(null)
  const prevRowsRef = useRef<TranscriptRow[] | null>(null)
  const wasLiveRef = useRef(false)
  const [, setPostLiveHoldGeneration] = useState(0)
  const live = pendingRun || running
  /** Render-assigned live flag so restore callbacks (rAF/RO) see current run state. */
  const liveRef = useRef(live)
  liveRef.current = live
  if (live) {
    wasLiveRef.current = true
  }
  const postLiveHold = wasLiveRef.current && !live

  useLayoutEffect(() => {
    if (live) return
    if (!wasLiveRef.current) return
    const timer = window.setTimeout(() => {
      wasLiveRef.current = false
      setPostLiveHoldGeneration((generation) => generation + 1)
    }, POST_LIVE_FLOW_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [live, pendingRun, running])

  // Defer the expensive transcript derivation so streaming token frames do not
  // block urgent UI (composer typing, scroll). React recomputes allRows/displayRows
  // as a non-urgent render, yielding to interaction. Ref: react.dev/reference/react/useDeferredValue.
  const deferredItems = useDeferredValue(items)
  const itemsStructuralKey = useMemo(() => structuralKey(deferredItems), [deferredItems])
  const allRows = useMemo(() => {
    const next = buildTranscriptRows(deferredItems, {
      pendingRun,
      running,
      showThinking,
      networkWait,
      compacting,
      turnFailed,
      turnFailureLabel,
      turnStatus
    })
    return stabilizeTranscriptRows(prevRowsRef.current, next)
  }, [
    deferredItems,
    pendingRun,
    running,
    showThinking,
    networkWait,
    compacting,
    turnFailed,
    turnFailureLabel,
    turnStatus
  ])
  useLayoutEffect(() => {
    prevRowsRef.current = allRows
  }, [allRows])
  const citationCatalogs = useMemo(() => collectTurnCitationCatalogs(allRows), [allRows])
  const resolvedTurnUsage = useResolvedTurnUsage(metaStore, turnUsage)
  const activeLiveTurnIndex = useMemo(() => {
    if (!(pendingRun || running)) return null
    let max = -1
    for (const row of allRows) {
      if (row.turnIndex > max) max = row.turnIndex
    }
    return max < 0 ? null : max
  }, [allRows, pendingRun, running])
  const latestTurnIndex = useMemo(() => {
    let latest = -1
    for (const row of allRows) latest = Math.max(latest, row.turnIndex)
    return latest
  }, [allRows])

  const tasksAnchorUserId = useMemo(() => resolveTasksAnchorUserId(deferredItems), [deferredItems])

  const displayRows = useMemo(() => {
    const visible = allRows.filter((row) => {
      if (collapsedTurnSet.has(row.turnIndex) && isTurnWorkRow(row)) return false
      return true
    })
    // Hide thinking when showThinking is off; otherwise drop empty rows ThinkingBlock skips.
    if (!showThinking) {
      return visible.filter((row) => row.kind !== 'thinking')
    }
    return visible.filter((row) => {
      if (row.kind !== 'thinking') return true
      return shouldRenderThinking(row.item.thinking, row.item.thinkingStreaming)
    })
  }, [allRows, collapsedTurnSet, showThinking])

  const latestUserRowId = useMemo(() => {
    for (let i = displayRows.length - 1; i >= 0; i--) {
      const row = displayRows[i]!
      if (row.kind === 'user') return row.id
    }
    return null
  }, [displayRows])

  const findMatches = useMemo(
    () => findTranscriptRowMatches(displayRows, findQuery),
    [displayRows, findQuery]
  )
  const currentFindRow =
    findOpen && findMatches.length > 0
      ? findMatches[wrapMatchIndex(matchIndex, findMatches.length)]!
      : null

  const nearBottomPx = nearBottomThreshold()
  const nearBottomPxRef = useRef(nearBottomPx)
  nearBottomPxRef.current = nearBottomPx

  restoreScrollTopRef.current =
    typeof restoreScrollTop === 'number' ? restoreScrollTop : null

  /**
   * Shared body of applyRestore and its ResizeObserver twin. Live restores pin
   * to the tail — the saved top predates tail growth while the pane was away,
   * so restoring it lands short of the bottom and reads as unpinned; the
   * reader's intent is the live tail. Non-live restores apply the saved top
   * and pin only when it already sits at the bottom.
   */
  const applySavedScrollTop = useCallback(
    (el: HTMLDivElement, top: number): void => {
      programmaticScrollRef.current = true
      if (liveRef.current) {
        el.scrollTop = el.scrollHeight
        pinnedToBottomRef.current = true
      } else {
        el.scrollTop = top
        const contentTall = el.scrollHeight > el.clientHeight + nearBottomPxRef.current
        pinnedToBottomRef.current = !contentTall || distanceFromBottom(el) <= nearBottomPxRef.current
      }
    },
    []
  )

  const onImageClick = useCallback((url: string, label: string) => {
    setLightbox({ url, label })
  }, [])
  const closeLightbox = useCallback(() => setLightbox(null), [])

  const handleTurnToggle = useCallback(
    (turnIndex: number) => {
      onTurnToggle?.(turnIndex)
    },
    [onTurnToggle]
  )

  useLayoutEffect(() => {
    appliedRestoreRef.current = null
    const top = restoreScrollTopRef.current
    const hasRestore = typeof top === 'number'
    restorePendingRef.current = hasRestore
    setScrollRestored(!hasRestore)
    if (!hasRestore) pinnedToBottomRef.current = true
  }, [scrollRestoreToken])

  useLayoutEffect(() => {
    const top = restoreScrollTopRef.current
    if (typeof top !== 'number') {
      restorePendingRef.current = false
      setScrollRestored(true)
      pinnedToBottomRef.current = true
      return
    }
    const el = containerRef.current
    if (!el) return

    const applyRestore = (): void => {
      if (!restorePendingRef.current && appliedRestoreRef.current === (scrollRestoreToken ?? 0)) {
        return
      }
      applySavedScrollTop(el, top)
      appliedRestoreRef.current = scrollRestoreToken ?? 0
      setScrollRestored(true)
      restorePendingRef.current = false
      window.requestAnimationFrame(() => {
        programmaticScrollRef.current = false
      })
    }

    const id = window.requestAnimationFrame(applyRestore)
    return () => window.cancelAnimationFrame(id)
  }, [applySavedScrollTop, scrollRestoreToken])

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!restorePendingRef.current) return
      const top = restoreScrollTopRef.current
      if (typeof top !== 'number') {
        restorePendingRef.current = false
        return
      }
      applySavedScrollTop(el, top)
      restorePendingRef.current = false
      window.requestAnimationFrame(() => {
        programmaticScrollRef.current = false
      })
    })
    ro.observe(el)
    const inner = el.firstElementChild
    if (inner) ro.observe(inner)
    return () => ro.disconnect()
  }, [applySavedScrollTop, scrollRestoreToken])

  useEffect(() => {
    return () => {
      if (autoScrollRafRef.current) window.cancelAnimationFrame(autoScrollRafRef.current)
    }
  }, [])

  const followTail = useCallback((behavior: ScrollBehavior) => {
    const el = containerRef.current
    if (!el) return
    programmaticScrollRef.current = true
    // Scroll to the true end (includes paddingBottom when composer space is reserved).
    const top = el.scrollHeight
    if (behavior === 'smooth' && typeof el.scrollTo === 'function') {
      el.scrollTo({ top, behavior: 'smooth' })
    } else {
      el.scrollTop = top
    }
    pinnedToBottomRef.current = true
    lastScrollTopRef.current = el.scrollTop
    // Keep the pre-layout-change scroll position truthful even though
    // handleScroll skips programmatic scrolls: at run end the stale value
    // would otherwise restore a pre-run offset instead of the tail.
    scrollBeforeLayoutChangeRef.current = top
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [])

  useLayoutEffect(() => {
    seenUserRowIdRef.current = undefined
  }, [scrollRestoreToken])

  useLayoutEffect(() => {
    const id = latestUserRowId
    const prev = seenUserRowIdRef.current
    if (prev === undefined) {
      seenUserRowIdRef.current = id
      return
    }
    seenUserRowIdRef.current = id
    if (id == null || id === prev || findOpen) return
    restorePendingRef.current = false
    unpinnedSeenIdsRef.current = null
    setUnpinnedNewCount(0)
    setIsUnpinned(false)
    pinnedToBottomRef.current = true
    const el = containerRef.current
    if (!el) return
    // Pin to the live tail so the just-sent prompt sits at the bottom edge with
    // the streaming response below it. A top-scroll here would fight the
    // tail-follow below and bury the prompt above the fold during long streams.
    followTail('auto')
    lastScrollTopRef.current = el.scrollTop
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [latestUserRowId, findOpen, followTail])

  const jumpToBottom = useCallback(() => {
    restorePendingRef.current = false
    unpinnedSeenIdsRef.current = null
    setUnpinnedNewCount(0)
    setIsUnpinned(false)
    followTail('smooth')
  }, [followTail])

  const jumpToTop = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    programmaticScrollRef.current = true
    restorePendingRef.current = false
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: 0, behavior: 'smooth' })
    } else {
      el.scrollTop = 0
    }
    pinnedToBottomRef.current = false
    setIsUnpinned(true)
    lastScrollTopRef.current = el.scrollTop
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [])

  const closeTranscriptFind = useCallback(() => {
    setFindOpen(false)
    setFindQuery('')
    setMatchIndex(0)
    if (openedFindFromComposerRef.current) {
      openedFindFromComposerRef.current = false
      focusComposerMessage()
    }
  }, [])

  const openTranscriptFind = useCallback((fromComposer: boolean) => {
    openedFindFromComposerRef.current = fromComposer
    setFindOpen(true)
  }, [])

  const stepFindMatch = useCallback((delta: number) => {
    setMatchIndex((i) => i + delta)
  }, [])

  const scrollToDisplayRow = useCallback((index: number) => {
    const el = containerRef.current
    if (!el) return
    programmaticScrollRef.current = true
    const flowStart = flowStartIndexRef.current
    const virtualizer = rowVirtualizerRef.current
    if (shouldVirtualizeRef.current && virtualizer && index < flowStart) {
      virtualizer.scrollToIndex(index, { align: 'center' })
    } else {
      const node = el.querySelector(`[data-transcript-row="${index}"]`)
      if (node instanceof HTMLElement && typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({ block: 'center', inline: 'nearest' })
      } else if (index === 0) {
        el.scrollTop = 0
      }
    }
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [])

  useEffect(() => {
    if (!isUnpinned) {
      unpinnedSeenIdsRef.current = null
      setUnpinnedNewCount(0)
      return
    }
    if (unpinnedSeenIdsRef.current == null) {
      unpinnedSeenIdsRef.current = new Set(items.map((item) => item.id))
      setUnpinnedNewCount(0)
      return
    }
    const seen = unpinnedSeenIdsRef.current
    let added = 0
    for (const item of items) {
      if (!seen.has(item.id)) {
        seen.add(item.id)
        added += 1
      }
    }
    if (added > 0) setUnpinnedNewCount((n) => n + added)
  }, [isUnpinned, items])

  useEffect(() => {
    setMatchIndex(0)
  }, [findQuery])

  useEffect(() => {
    if (!findOpen) return
    findInputRef.current?.focus()
    findInputRef.current?.select()
  }, [findOpen])

  useEffect(() => {
    if (!findOpen || currentFindRow == null) return
    scrollToDisplayRow(currentFindRow)
  }, [findOpen, currentFindRow, scrollToDisplayRow])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'End' && e.key !== 'Home') return
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (e.defaultPrevented) return
      if (isEditableShortcutTarget(e.target)) return
      const target = e.target instanceof Element ? e.target : null
      if (
        target?.closest(
          'aside[aria-label="Sidebar"], [id^="dock-panel-"], [data-chat-side-rail]'
        )
      ) {
        return
      }
      const list = containerRef.current
      if (!list) return
      const pane = list.closest('[data-chat-pane]')
      if (pane?.getAttribute('data-chat-pane-focused') === '0') return
      const otherList = target?.closest('[data-transcript-scroll]')
      if (otherList && otherList !== list) return
      e.preventDefault()
      if (e.key === 'End') jumpToBottom()
      else jumpToTop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [jumpToBottom, jumpToTop])

  useEffect(() => {
    const onCommand = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (id === 'jump-latest') jumpToBottom()
      else if (id === 'jump-top') jumpToTop()
      else if (id === 'find') setFindOpen(true)
    }
    window.addEventListener('vyotiq:command', onCommand)
    return () => window.removeEventListener('vyotiq:command', onCommand)
  }, [jumpToBottom, jumpToTop])

  useEffect(() => {
    const paneOwnsEvent = (e: KeyboardEvent): boolean => {
      const target = e.target instanceof Element ? e.target : null
      const list = containerRef.current
      if (!list) return false
      const pane = list.closest('[data-chat-pane]')
      if (pane?.getAttribute('data-chat-pane-focused') === '0') return false
      const otherList = target?.closest('[data-transcript-scroll]')
      if (otherList && otherList !== list) return false
      return true
    }

    const onFindKey = (e: KeyboardEvent): void => {
      if (matchShortcut(e, 'find')) {
        const target = e.target
        if (target instanceof Element && target.closest('[data-transcript-find]')) {
          e.preventDefault()
          findInputRef.current?.select()
          return
        }
        if (isEditableShortcutTarget(target) && !isMainComposerTarget(target)) return
        if (isChangesOrPrDockClaimingFind() && !isMainComposerTarget(target)) return
        if (!paneOwnsEvent(e)) return
        e.preventDefault()
        openTranscriptFind(isMainComposerTarget(target))
        return
      }
      if (!findOpen) return
      if (e.key === 'F3') {
        if (!paneOwnsEvent(e)) return
        e.preventDefault()
        stepFindMatch(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onFindKey)
    return () => window.removeEventListener('keydown', onFindKey)
  }, [findOpen, openTranscriptFind, stepFindMatch])

  useEffect(() => {
    if (!findOpen) return undefined
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeTranscriptFind()
    }
    window.addEventListener('keydown', onEsc, true)
    return () => window.removeEventListener('keydown', onEsc, true)
  }, [findOpen, closeTranscriptFind])

  const scheduleTailFollow = useCallback(() => {
    if (autoScrollRafRef.current) window.cancelAnimationFrame(autoScrollRafRef.current)
    autoScrollRafRef.current = window.requestAnimationFrame(() => {
      autoScrollRafRef.current = null
      if (!scrollRestored || restorePendingRef.current || !pinnedToBottomRef.current) return
      if (hasPendingQuestionRef.current) return
      const el = containerRef.current
      // Only skip when already flush at the absolute bottom. Skipping for the
      // whole dock slack can leave streaming growth below the visible fold.
      if (el && distanceFromBottom(el) < 1) return
      followTail('auto')
    })
  }, [followTail, scrollRestored])

  useEffect(() => {
    hasPendingQuestionRef.current = deferredItems.some((item) => item.kind === 'question')
  }, [deferredItems])

  useEffect(() => {
    if (!scrollRestored || restorePendingRef.current || !pinnedToBottomRef.current) return
    if (prevStructuralKeyRef.current === itemsStructuralKey) return
    prevStructuralKeyRef.current = itemsStructuralKey
    // AskQuestionPanel scrolls the gate to show its header; pin-follow would bury it.
    if (deferredItems.some((item) => item.kind === 'question')) return
    scheduleTailFollow()
  }, [deferredItems, itemsStructuralKey, scheduleTailFollow, scrollRestored])

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!scrollRestored || restorePendingRef.current || !pinnedToBottomRef.current) return
      scheduleTailFollow()
    })
    ro.observe(el)
    const inner = el.firstElementChild
    if (inner) ro.observe(inner)
    return () => ro.disconnect()
  }, [scheduleTailFollow, scrollRestored])

  const streamingAnnouncement = useMemo(() => {
    if (activeLiveTurnIndex != null) {
      const turnRow = allRows.find(
        (row) => row.kind === 'turn' && row.turnIndex === activeLiveTurnIndex
      )
      if (turnRow?.kind === 'turn' && turnRow.span.activity) {
        const suppressPhase =
          turnRow.span.active === true &&
          !collapsedTurnSet.has(turnRow.turnIndex) &&
          turnHasVisibleToolWork(allRows, turnRow.turnIndex) &&
          !compacting
        if (suppressPhase) return ''
        return `Assistant: ${formatRunActivityLabel(turnRow.span.activity)}`
      }
    }
    if (compacting) {
      const hasCompactionRow = allRows.some((row) => row.kind === 'compaction')
      if (!hasCompactionRow) {
        return `Assistant: ${formatRunActivityLabel(compactActivityFromRows(allRows))}`
      }
      return ''
    }
    for (let i = allRows.length - 1; i >= 0; i--) {
      const row = allRows[i]
      if (row?.kind !== 'turn' || !row.span.activity) continue
      return `Assistant: ${formatRunActivityLabel(row.span.activity)}`
    }
    if (turnStatus) {
      const label =
        turnStatus === 'done'
          ? 'Completed'
          : turnStatus === 'cancelled'
            ? 'Cancelled'
            : turnStatus === 'interrupted'
              ? 'Interrupted'
              : 'Failed'
      return `Assistant: ${label}`
    }
    return ''
  }, [allRows, activeLiveTurnIndex, compacting, collapsedTurnSet, turnStatus])

  const liveReceiptAnnouncement = useMemo(() => {
    if (activeLiveTurnIndex == null) return ''
    const usage = resolvedTurnUsage?.[activeLiveTurnIndex]
    if (!usage) return ''
    const stats = buildFooterStats({
      startedAt: null,
      endedAt: null,
      active: false,
      nowMs: 0,
      usage,
      omitDuration: true
    })
    return stats.caption ? `Assistant usage: ${stats.caption}` : ''
  }, [activeLiveTurnIndex, resolvedTurnUsage])

  const rowsContentRevision = useMemo(
    () => transcriptRowsContentRevision(displayRows),
    [displayRows]
  )

  // Streaming text_delta keeps the same item id, so structuralKey alone misses
  // content growth. Re-pin while live when the user is already at the tail.
  useEffect(() => {
    if (!running && !pendingRun) return
    if (!scrollRestored || restorePendingRef.current || !pinnedToBottomRef.current) return
    scheduleTailFollow()
  }, [rowsContentRevision, running, pendingRun, scheduleTailFollow, scrollRestored])

  const virtualizeMinRows = virtualizeLiveEarly ? 0 : VIRTUALIZE_MIN_ROWS

  const useHybridVirtualize =
    live &&
    displayRows.length >= virtualizeMinRows &&
    activeLiveTurnIndex != null

  const flowStartIndex = useMemo(() => {
    if (!useHybridVirtualize || activeLiveTurnIndex == null) return displayRows.length
    const turnStartIdx = displayRows.findIndex((row) => row.turnIndex >= activeLiveTurnIndex)
    const turnBased = turnStartIdx < 0 ? displayRows.length : turnStartIdx
    const tailStart = Math.max(0, displayRows.length - HYBRID_FLOW_TAIL_ROWS)
    return Math.max(turnBased, tailStart)
  }, [useHybridVirtualize, displayRows, activeLiveTurnIndex])

  const useFullVirtualize =
    !live &&
    !postLiveHold &&
    displayRows.length >= (virtualizeLiveEarly ? HYBRID_FLOW_TAIL_ROWS : VIRTUALIZE_MIN_ROWS)

  const virtualizedRows = useMemo(() => {
    if (useHybridVirtualize && flowStartIndex > 0) {
      return displayRows.slice(0, flowStartIndex)
    }
    if (useFullVirtualize) return displayRows
    return []
  }, [useHybridVirtualize, flowStartIndex, useFullVirtualize, displayRows])

  const flowSuffixRows = useMemo(() => {
    if (useHybridVirtualize && flowStartIndex > 0) {
      return displayRows.slice(flowStartIndex)
    }
    return []
  }, [useHybridVirtualize, flowStartIndex, displayRows])

  const getItemKey = useCallback(
    (index: number) => virtualizedRows[index]?.id ?? index,
    [virtualizedRows]
  )

  const estimateSize = useCallback(
    (index: number) => estimateTranscriptRowSize(virtualizedRows[index]),
    [virtualizedRows]
  )

  const measureElementHeight = useCallback((element: Element) => {
  // offsetHeight includes padding/border (layout box, not compositor-skewed).
    if (element instanceof HTMLElement && element.offsetHeight > 0) {
      return element.offsetHeight
    }
    return element.getBoundingClientRect().height
  }, [])

  const shouldVirtualize = virtualizedRows.length > 0
  shouldVirtualizeRef.current = shouldVirtualize
  flowStartIndexRef.current = flowStartIndex

  const layoutMode: TranscriptLayoutMode =
    useHybridVirtualize && flowStartIndex > 0
      ? 'hybrid'
      : useFullVirtualize
        ? 'full-virtual'
        : 'flow'

  const rowVirtualizer = useAppVirtualizer({
    count: shouldVirtualize ? virtualizedRows.length : 0,
    getScrollElement: () => containerRef.current,
    estimateSize,
    measureElement: measureElementHeight,
    getItemKey,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: nearBottomPx,
    overscan: 8,
    enabled: shouldVirtualize,
    // jsdom / first paint often report 0×0 until layout; seed a viewport so rows mount.
    initialRect: { width: 720, height: 800 }
  })
  rowVirtualizerRef.current = rowVirtualizer

  const recordScrollAnchor = useCallback((): void => {
    const el = containerRef.current
    if (!el) return
    const virtualIndices = rowVirtualizerRef.current?.getVirtualItems().map((item) => item.index) ?? []
    flowAnchorRef.current = captureScrollAnchor(el, flowStartIndexRef.current, virtualIndices)
  }, [])

  const handleScroll = useCallback(
    (scrollTop: number) => {
      const el = containerRef.current
      const prevTop = lastScrollTopRef.current
      lastScrollTopRef.current = scrollTop
      if (el && !programmaticScrollRef.current) {
        const dist = distanceFromBottom(el)
        const near = dist <= nearBottomPxRef.current
        let pinned = pinnedToBottomRef.current
        if (near) {
          pinned = true
        } else if (
          pinned &&
          dist <= FOLLOW_LAG_PX &&
          scrollTop >= prevTop
        ) {
          // Stale follow: scrollTop moved toward the tail but height grew first.
          pinned = true
        } else {
          pinned = false
        }
        pinnedToBottomRef.current = pinned
        restorePendingRef.current = false
        setIsUnpinned((prev) => (prev === !pinned ? prev : !pinned))
        recordScrollAnchor()
        scrollBeforeLayoutChangeRef.current = el.scrollTop
      }
      if (!programmaticScrollRef.current) {
        onScrollTopChange?.(scrollTop)
      }
    },
    [onScrollTopChange, recordScrollAnchor]
  )

  const remasureMountedRows = useCallback(() => {
    const root = containerRef.current
    const virtualizer = rowVirtualizerRef.current
    if (!root || !virtualizer) return
    const nodes = root.querySelectorAll('[data-index]')
    for (const node of nodes) {
      virtualizer.measureElement(node)
    }
  }, [])

  // Never call measure() here — it clears itemSizeCache and off-screen rows fall
  // back to estimates (huge gaps between Thought/Read). Remasure mounted only.
  useLayoutEffect(() => {
    if (!shouldVirtualize) return
    remasureMountedRows()
  }, [displayRows.length, scrollRestored, shouldVirtualize, remasureMountedRows])

  const restoreScrollAfterLayoutChange = useCallback(
    (mode: TranscriptLayoutMode): void => {
      const el = containerRef.current
      if (!el) return
      programmaticScrollRef.current = true
      const savedTop = scrollBeforeLayoutChangeRef.current
      const bottomTop = Math.max(0, el.scrollHeight - el.clientHeight)
      // scrollBeforeLayoutChangeRef only records user scrolls (programmatic
      // tail-follow is guarded out in handleScroll), so it goes stale during a
      // long stream. Mid-stream (live) flips trust an active pin over the
      // stale top to keep the tail. Run-end flips (liveRef already false)
      // also trust an active pin: pinnedToBottomRef is only cleared by a
      // genuine user scroll-away in handleScroll, so manual readers who
      // scrolled up mid-run keep position restore here.
      const wasAtBottom =
        pinnedToBottomRef.current ||
        (savedTop > 0
          ? savedTop >= bottomTop - nearBottomPxRef.current
          : distanceFromBottom(el) <= nearBottomPxRef.current)
      if (wasAtBottom) {
        el.scrollTop = el.scrollHeight
        pinnedToBottomRef.current = true
      } else if (mode === 'full-virtual') {
        if (!wasAtBottom && savedTop > 0) {
          pendingFullVirtualScrollRef.current = savedTop
          remasureMountedRows()
          rowVirtualizer.scrollToOffset(savedTop)
        } else {
          const anchor = flowAnchorRef.current
          if (anchor) {
            remasureMountedRows()
            rowVirtualizer.scrollToIndex(anchor.index, { align: 'start' })
            el.scrollTop += anchor.offsetPx
          } else if (savedTop > 0) {
            el.scrollTop = savedTop
          }
        }
      } else if (savedTop > 0) {
        el.scrollTop = savedTop
        pinnedToBottomRef.current = false
      }
      window.requestAnimationFrame(() => {
        programmaticScrollRef.current = false
      })
    },
    [remasureMountedRows, rowVirtualizer]
  )

  useLayoutEffect(() => {
    const prevMode = prevLayoutModeRef.current
    const mode = layoutMode
    if (prevMode !== mode) {
      restoreScrollAfterLayoutChange(mode)
    }
    prevLayoutModeRef.current = mode
  }, [layoutMode, restoreScrollAfterLayoutChange])

  useLayoutEffect(() => {
    if (!useFullVirtualize) return
    const saved = pendingFullVirtualScrollRef.current
    if (saved == null || saved <= 0) return
    const el = containerRef.current
    if (!el) return
    const bottomTop = Math.max(0, el.scrollHeight - el.clientHeight)
    if (saved >= bottomTop - nearBottomPxRef.current) {
      pendingFullVirtualScrollRef.current = null
      return
    }
    programmaticScrollRef.current = true
    remasureMountedRows()
    el.scrollTop = saved
    rowVirtualizer.scrollToOffset(saved)
    pendingFullVirtualScrollRef.current = null
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false
    })
  }, [useFullVirtualize, remasureMountedRows, rowVirtualizer])

  useLayoutEffect(() => {
    if (!shouldVirtualize) return
    remasureMountedRows()
  }, [rowsContentRevision, shouldVirtualize, remasureMountedRows])

  useLayoutEffect(() => {
    if (!scrollRestored || displayRows.length === 0) return
    // Honor explicit restore only when the reader is not pinned to the tail.
    if (typeof restoreScrollTop === 'number' && !pinnedToBottomRef.current) return
    if (shouldVirtualize) {
      // Remasure visible rows first so end scroll uses real heights, not cold estimates.
      remasureMountedRows()
    }
    const el = containerRef.current
    if (el && pinnedToBottomRef.current) {
      const saved = scrollBeforeLayoutChangeRef.current
      const bottomTop = Math.max(0, el.scrollHeight - el.clientHeight)
      const atBottom =
        distanceFromBottom(el) <= nearBottomPxRef.current ||
        saved >= bottomTop - nearBottomPxRef.current
      if (atBottom) {
        el.scrollTop = el.scrollHeight
        pinnedToBottomRef.current = true
      }
    }
    // Pin once after restore/surface — followOnAppend handles stream growth.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-shot pin
  }, [scrollRestored, scrollRestoreToken, shouldVirtualize])

  const renderRow = (row: TranscriptRow, omitTasksBand = false): ReactNode => {
    const footerSpan =
      row.kind === 'text' && row.final
        ? footerTurnSpan(
            allRows,
            row.turnIndex,
            row.item,
            activeLiveTurnIndex != null && row.turnIndex === activeLiveTurnIndex,
            row.turnIndex === latestTurnIndex ? turnStatus : null
          )
        : null
    const closingAnswer = turnHasClosingAnswer(allRows, row.turnIndex)
    const liveTurn = activeLiveTurnIndex != null && row.turnIndex === activeLiveTurnIndex
    const rowUsage =
      row.kind === 'turn' || (row.kind === 'text' && row.final)
        ? row.kind === 'turn' && !liveTurn && closingAnswer
          ? null
          : (resolvedTurnUsage?.[row.turnIndex] ?? null)
        : null
    return (
    <TranscriptRowBlock
      row={row}
      onImageClick={onImageClick}
      onLoadToolContent={onLoadToolContent}
      onThinkingToggle={onThinkingToggle}
      onToolToggle={onToolToggle}
      onGroupToggle={onGroupToggle}
      onTurnToggle={handleTurnToggle}
      onApprovalDecision={onApprovalDecision}
      onQuestionSubmit={onQuestionSubmit}
      onRetryNetwork={onRetryNetwork}
      autoFocusApproval={approvalAutoFocus}
      turnCollapsed={collapsedTurnSet.has(row.turnIndex)}
      showThinking={showThinking}
      live={activeLiveTurnIndex != null && row.turnIndex === activeLiveTurnIndex}
      suppressPhaseLabel={
        row.kind === 'turn' &&
        row.span.active === true &&
        !collapsedTurnSet.has(row.turnIndex) &&
        turnHasVisibleToolWork(allRows, row.turnIndex) &&
        !compacting
      }
      mcpServerNames={mcpServerNames}
      onOpenChanges={onOpenChanges}
      editingUserMessageIndex={editingUserMessageIndex}
      editComposer={editComposer}
      onBeginEditUserMessage={onBeginEditUserMessage}
      onRevertUserMessage={onRevertUserMessage}
      messageCount={messageCount}
      running={running}
      pendingRun={pendingRun}
      showTasksBand={
        !omitTasksBand &&
        row.kind === 'user' &&
        tasksAnchorUserId != null &&
        row.item.id === tasksAnchorUserId
      }
      citationCatalog={citationCatalogs.get(row.turnIndex) ?? EMPTY_CITATION_CATALOG}
      footerStartedAt={footerSpan?.startedAt ?? null}
      footerEndedAt={footerSpan?.endedAt ?? null}
      footerActive={footerSpan?.active ?? false}
      footerStatus={footerSpan?.status ?? null}
      footerUsage={rowUsage}
      footerOmitReceipt={Boolean(
        (footerSpan?.hasTurnSummary && footerSpan.active) ||
          (footerSpan?.status != null && footerSpan.status !== 'done')
      )}
      footerOmitDuration={Boolean(
        (footerSpan?.hasTurnSummary && footerSpan.active) ||
          (footerSpan?.status != null && footerSpan.status !== 'done')
      )}
    />
    )
  }

  /**
   * Turn-grouped flow rendering: rows are wrapped per turn so the turn's user
   * prompt bubble pins natively (position: sticky) while its content scrolls and
   * releases when the next turn pushes it out. The original user prompt bubble pins
   * inline with native scroll behavior, edge-to-edge floating without any complete
   * row background fills.
   */
  const renderTurnGroups = (
    entries: readonly { row: TranscriptRow; index: number }[],
    keyPrefix: string
  ): ReactNode => {
    const groups: {
      turnIndex: number
      start: number
      items: { row: TranscriptRow; index: number }[]
    }[] = []
    for (const entry of entries) {
      const last = groups[groups.length - 1]
      if (last && last.turnIndex === entry.row.turnIndex) last.items.push(entry)
      else groups.push({ turnIndex: entry.row.turnIndex, start: entry.index, items: [entry] })
    }
    return groups.map((group) => (
      <div
        key={`${keyPrefix}-turn-${group.start}`}
        data-turn-group={group.turnIndex}
        className={group.turnIndex > 0 ? TRANSCRIPT_TURN_GAP : undefined}
      >
        {group.items.map(({ row, index }) => {
          const isUser = row.kind === 'user'
          const hasTasksBand =
            isUser && tasksAnchorUserId != null && row.item.id === tasksAnchorUserId
          return (
            <Fragment key={row.id}>
              <div
                data-transcript-row={index}
                data-find-current={currentFindRow === index ? '' : undefined}
                id={turnWorkPanelId(row, displayRows, index)}
                data-sticky-turn-prompt={isUser ? '' : undefined}
                className={cn(
                  isUser
                    ? 'sticky z-sticky mb-2.5'
                    : rowSpacingClass(row, displayRows[index + 1]),
                  currentFindRow === index && 'rounded-md ring-1 ring-accent/40'
                )}
                style={isUser ? { top: `${STICKY_TURN_TOP_PX}px` } : undefined}
              >
                {renderRow(row, isUser)}
              </div>
              {hasTasksBand ? (
                <div key={`${row.id}-tasks-band`} className="mt-1 pb-2.5">
                  <TasksCeilingBand key={row.item.id} running={running} />
                </div>
              ) : null}
            </Fragment>
          )
        })}
      </div>
    ))
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        {findOpen ? (
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border/40 px-3 py-1">
            <Icon name="search" size={12} className="shrink-0 text-muted" />
            <input
              ref={findInputRef}
              type="search"
              data-transcript-find=""
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              placeholder="Find in transcript"
              aria-label="Find in transcript"
              className="min-w-0 flex-1 bg-transparent text-caption text-fg outline-none placeholder:text-muted"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  closeTranscriptFind()
                  return
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  stepFindMatch(e.shiftKey ? -1 : 1)
                }
              }}
            />
            {findQuery.trim() ? (
              <span className="shrink-0 tabular-nums text-2xs text-muted">
                {findMatches.length === 0
                  ? 'No matches'
                  : `${wrapMatchIndex(matchIndex, findMatches.length) + 1} of ${findMatches.length}`}
              </span>
            ) : null}
            <button
              type="button"
              className="rounded px-1 text-2xs text-muted hover:text-fg"
              aria-label="Close find"
              onClick={closeTranscriptFind}
            >
              Esc
            </button>
          </div>
        ) : null}
        <div
          ref={containerRef}
          data-transcript-scroll
          style={{
            // Floating composer overlays this scrollport — reserve its measured
            // height (published on the stage via COMPOSER_DOCK_RESERVE_VAR) so the
            // last row can scroll fully clear; jump-to-bottom adds its own clearance.
            paddingBottom: `calc(var(${COMPOSER_DOCK_RESERVE_VAR}, 0px) + ${
              COMPOSER_DOCK_CLEARANCE_PX +
              COMPOSER_FLOAT_BOTTOM_INSET_PX +
              (isUnpinned ? JUMP_TO_BOTTOM_CLEARANCE_PX : 0)
            }px)`
          }}
          className={cn(
            TRANSCRIPT_CONTAINER,
            'relative min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]',
            CHAT_STAGE_TOP_INSET,
            sideRailPad ? CHAT_STAGE_INSET : CHAT_GUTTER
          )}
          onScroll={(e) => handleScroll(e.currentTarget.scrollTop)}
          onPointerDownCapture={() => onActivate?.()}
          onFocus={() => onActivate?.()}
        >
          <div className="sr-only" role="status" aria-live="polite">
            {streamingAnnouncement}
          </div>
          <div
            className="sr-only"
            role="status"
            aria-live="polite"
            data-live-receipt-announcement
          >
            {liveReceiptAnnouncement}
          </div>
          {transcriptLoading && items.length === 0 ? (
            <div
              className={cn(
                CHAT_COLUMN,
                'flex min-h-[12rem] flex-col items-center justify-center gap-2 text-sm text-muted'
              )}
              role="status"
              aria-busy="true"
            >
              <Icon name="loader" size={16} className="motion-safe:animate-spin" />
              <span>Loading chat…</span>
            </div>
          ) : items.length === 0 && !pendingRun && !running && emptyLabel ? (
            <div
              className={cn(
                CHAT_COLUMN,
                'flex min-h-[12rem] flex-col items-center justify-center gap-2 text-sm text-muted'
              )}
              data-chat-empty-state
            >
              <span>{emptyLabel}</span>
              {workspacePath ? <AgentContextCard workspacePath={workspacePath} /> : null}
            </div>
          ) : (
            (() => {
              // Short transcripts: normal flow — no absolute top collision risk.
              // Long transcripts / Vitest empty-range: virtualize or full-DOM test fallback.
              const virtualItems = shouldVirtualize ? rowVirtualizer.getVirtualItems() : []
              const allowFullFallback =
                typeof process !== 'undefined' && process.env.VITEST === 'true'
              const useHybridLayout = shouldVirtualize && flowSuffixRows.length > 0
              const useFlowLayout =
                !shouldVirtualize ||
                (virtualItems.length === 0 &&
                  displayRows.length > 0 &&
                  allowFullFallback)

              const loadingOverlay =
                transcriptLoading && items.length > 0 ? (
                  <div
                    className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center"
                    role="status"
                    aria-busy="true"
                  >
                    <span className="inline-flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1 text-caption text-muted shadow-sm">
                      <Icon name="loader" size={12} className="motion-safe:animate-spin" />
                      Loading chat…
                    </span>
                  </div>
                ) : null

              const liveCompactCard = displayRows.some(
                (row) =>
                  row.kind === 'compaction' &&
                  (row.verifyStatus === 'verifying' || row.verifyStatus === 'retrying')
              )
              const hasCompactionRow = displayRows.some((row) => row.kind === 'compaction')
              const compactStatus =
                compacting && !live && !liveCompactCard && !hasCompactionRow ? (
                  <div className={cn('flex w-full flex-col', CHAT_COLUMN)} data-compact-status>
                    <div
                      className={cn(DISCLOSURE_ROW, 'text-tertiary', TRANSCRIPT_ROW_GAP)}
                      role="status"
                    >
                      <TextShimmer className="shrink-0">
                        {formatRunActivityLabel(compactActivityFromRows(allRows))}
                      </TextShimmer>
                    </div>
                  </div>
                ) : null

              if (useFlowLayout) {
                return (
                  <>
                    {loadingOverlay}
                    <div className={cn('flex w-full flex-col', CHAT_COLUMN)} data-chat-column>
                      {renderTurnGroups(
                        displayRows.map((row, index) => ({ row, index })),
                        'flow'
                      )}
                    </div>
                    {compactStatus}
                  </>
                )
              }
              if (useHybridLayout) {
                return (
                  <>
                    {loadingOverlay}
                    <div
                      className={cn('relative w-full', CHAT_COLUMN)}
                      data-chat-column
                      style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                    >
                      {virtualItems.map((virtualItem) => {
                        const row = virtualizedRows[virtualItem.index]!
                        return (
                          <div
                            key={virtualItem.key}
                            data-index={virtualItem.index}
                            data-transcript-row={virtualItem.index}
                            data-find-current={
                              currentFindRow === virtualItem.index ? '' : undefined
                            }
                            ref={rowVirtualizer.measureElement}
                            id={turnWorkPanelId(row, displayRows, virtualItem.index)}
                            className={cn(
                              'absolute left-0 w-full',
                              rowSpacingClass(row, displayRows[virtualItem.index + 1]),
                              currentFindRow === virtualItem.index &&
                                'rounded-md ring-1 ring-accent/40'
                            )}
                            style={{ top: `${virtualItem.start}px` }}
                          >
                            {renderRow(row)}
                          </div>
                        )
                      })}
                    </div>
                    <div className={cn('flex w-full flex-col', CHAT_COLUMN)} data-live-turn-flow>
                      {renderTurnGroups(
                        flowSuffixRows.map((row, localIndex) => ({
                          row,
                          index: flowStartIndex + localIndex
                        })),
                        'suffix'
                      )}
                    </div>
                    {compactStatus}
                  </>
                )
              }
              return (
                <>
                  {loadingOverlay}
                  <div
                    className={cn('relative w-full', CHAT_COLUMN)}
                    data-chat-column
                    style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                  >
                    {virtualItems.map((virtualItem) => {
                      const row = virtualizedRows[virtualItem.index]!
                      return (
                        <div
                          key={virtualItem.key}
                          data-index={virtualItem.index}
                          data-transcript-row={virtualItem.index}
                          data-find-current={
                            currentFindRow === virtualItem.index ? '' : undefined
                          }
                          ref={rowVirtualizer.measureElement}
                          id={turnWorkPanelId(row, displayRows, virtualItem.index)}
                          className={cn(
                            'absolute left-0 w-full',
                            rowSpacingClass(row, displayRows[virtualItem.index + 1]),
                            currentFindRow === virtualItem.index &&
                              'rounded-md ring-1 ring-accent/40'
                          )}
                          style={{ top: `${virtualItem.start}px` }}
                        >
                          {renderRow(row)}
                        </div>
                      )
                    })}
                  </div>
                  {compactStatus}
                </>
              )
            })()
          )}
          {isUnpinned ? (
            <div
              className="pointer-events-none sticky bottom-4 z-dropdown flex h-0 justify-center"
              data-jump-to-bottom
            >
              <Tooltip content="Jump to latest (End)">
                <button
                  type="button"
                  onClick={jumpToBottom}
                  aria-label={
                    unpinnedNewCount > 0
                      ? `Jump to latest messages, ${unpinnedNewCount} new`
                      : 'Jump to latest messages'
                  }
                  className="pointer-events-auto inline-flex -translate-y-full items-center gap-1.5 rounded-full border border-border/80 bg-surface/95 py-1.5 px-2.5 text-caption font-medium text-secondary shadow-md backdrop-blur-sm vy-transition hover:border-border hover:bg-surface hover:text-fg focus-visible:vy-focus-ring"
                >
                  <Icon name="chevron" size={12} />
                  <span className="tracking-[var(--vy-tracking-tight)]">Latest</span>
                  {unpinnedNewCount > 0 ? (
                    <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs font-medium leading-4 text-accent-fg">
                      {unpinnedNewCount}
                    </span>
                  ) : null}
                </button>
              </Tooltip>
            </div>
          ) : null}
        </div>
      </div>
      {lightbox ? (
        <ImageLightbox
          url={lightbox.url}
          label={lightbox.label}
          onClose={closeLightbox}
        />
      ) : null}
    </>
  )
}
