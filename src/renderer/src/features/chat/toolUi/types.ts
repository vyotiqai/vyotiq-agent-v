import type { IconName } from '@renderer/lib/icons'
import type { ChatRightPanelId } from '@renderer/lib/utils/layout'
import type { UiGroupTiming, UiToolProgressEntry, UiToolRow } from '@shared/transcript'

export type ToolPresentation = 'prominent' | 'compact'

export type ToolCategory = 'file' | 'edit' | 'search' | 'command' | 'browse' | 'browser'

export type ToolBodyTiming = UiGroupTiming

export type ToolHeaderMeta = {
  verb: string
  target: string
  icon?: IconName
  exitCode?: number | null
  statusDot?: 'running' | 'done' | 'fail'
  filePath?: string
  /**
   * 1-based line to land on when `filePath` is opened. Only set when the tool
   * genuinely reported one (a read range, a unified-diff hunk) — never guessed.
   */
  fileLine?: number
  /**
   * Dock panel this card's leading icon reveals, for tools whose result lives
   * in a panel rather than a file (a PR card opens the pull request panel).
   */
  opensPanel?: ChatRightPanelId
  added?: number
  removed?: number
}

export type ToolBodyProps = {
  tool: UiToolRow
  expanded?: boolean
  loading?: boolean
  loadFailed?: boolean
  /** Live progress lines from a long-running tool. */
  toolProgress?: UiToolProgressEntry[]
  /** Live terminal stdout/stderr streamed while the command runs. */
  terminalOutput?: string
  onLoadFullContent?: (toolCallId: string) => Promise<string | null>
  /** Collapse the expanded body (e.g. after copy). */
  onCollapse?: () => void
  mcpServerNames?: ReadonlyMap<string, string>
  /** Suppress redundant path chrome already shown in the compact row. */
  inGroup?: boolean
  timing?: ToolBodyTiming
}

export type ToolBodyContext = {
  tool: UiToolRow
  expanded: boolean
  loading?: boolean
  loadFailed?: boolean
  toolProgress?: UiToolProgressEntry[]
  terminalOutput?: string
  onLoadFullContent?: (toolCallId: string) => Promise<string | null>
  onCollapse?: () => void
  mcpServerNames?: ReadonlyMap<string, string>
  inGroup?: boolean
  timing?: ToolBodyTiming
}
