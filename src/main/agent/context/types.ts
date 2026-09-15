import type { ChatMessage, ModelInfo, ResponseVerbosity, UserRule } from '../../../shared/ipc'
import type { TokenUsage } from '../providers/types'
import {
  BUDGET_SHARES as SHARED_BUDGET_SHARES,
  DEFAULT_CONTEXT_WINDOW as SHARED_DEFAULT_CONTEXT_WINDOW
} from '../../../shared/domain/contextBudget'

export type BudgetLayers = {
  system: number
  tools: number
  memoryWorkspace: number
  history: number
  buffer: number
}

/** Fixed budget shares of model context window — kept in sync via shared/domain/contextBudget. */
export const BUDGET_SHARES: BudgetLayers = SHARED_BUDGET_SHARES

export const KEEP_RECENT_TURNS = 12
export const KEEP_LAST_TOOL_RESULTS = 6
export const MEMORY_INDEX_CAP = 3000
export const MEMORY_STATE_CAP = 3000
export const DEFAULT_CONTEXT_WINDOW = SHARED_DEFAULT_CONTEXT_WINDOW

import { z } from 'zod'

export const CompactionTriggerReasonSchema = z.enum([
  'proactive',
  'overflow',
  'manual'
])
export type CompactionTriggerReason = z.infer<typeof CompactionTriggerReasonSchema>

export const CompactionRecordSchema = z.object({
  summary: z.string().min(1),
  createdAt: z.string(),
  tokenEstimate: z.number().int().min(0),
  /**
   * Count of leading messages in `messages.jsonl` that this summary already
   * represents. The loop skips them when rebuilding its working set.
   */
  foldedMessages: z.number().int().min(0).optional(),
  /** Why this fold ran (observability for compaction chains). */
  triggerReason: CompactionTriggerReasonSchema.optional(),
  /** Messages summarized in this fold. */
  messagesFolded: z.number().int().min(0).optional(),
  /** Messages kept verbatim after this fold. */
  keptMessages: z.number().int().min(0).optional(),
  /** Post-compact context estimate at fold time. */
  postCompactEstimatedTokens: z.number().int().min(0).optional(),
  /** Model content window at fold time. */
  contentWindowAtCompact: z.number().int().min(1).optional(),
  /** User decisions from ask_question in the folded prefix. */
  retainedDecisions: z.array(z.string()).max(8).optional(),
  /**
   * Extractive facts pinned independently of the LLM summary. Assemble injects
   * these with a reserved budget so rolling/token caps cannot drop them.
   */
  pinnedFacts: z
    .object({
      files: z.array(z.string()).max(64),
      wroteFiles: z.array(z.string()).max(64),
      decisions: z.array(z.string()).max(32),
      todos: z.array(z.string()).max(32),
      doneWhen: z.array(z.string()).max(32),
      constraints: z.array(z.string()).max(32),
      contractGoal: z.string().max(240).optional()
    })
    .optional(),
  /** Extractive verifier accepted this summary before the watermark advanced. */
  verified: z.boolean().optional(),
  /** Share of extracted fold files cited in the summary (0–1). */
  verifyCoverage: z.number().min(0).max(1).optional(),
  /** Human-readable verify failures (empty when verified). */
  verifyFailures: z.array(z.string()).max(16).optional()
})
export type CompactionRecord = z.infer<typeof CompactionRecordSchema>

export type AssembleInput = {
  harness: string
  messages: ChatMessage[]
  workspacePath: string | null
  focusedFile?: string | null
  goal: string
  model: ModelInfo
  toolsJsonEstimate: number
  lastUsage?: TokenUsage
  keepRecentTurns?: number
  contract?: string
  priorCompaction?: CompactionRecord | null
  loopHint?: string
  skillsSection?: string
  pluginRulesSection?: string
  /** User-global rules from settings; assembled before workspace rules. */
  userRules?: UserRule[]
  /** Optional assistant identity override (settings.agentPersona). */
  persona?: string
  /** Built-in identity blurb; overridden by settings.agentIdentity, and assembled only when identity is empty and no user persona is set. */
  identity?: string
  /** Optional tone directive (settings.agentTone). Empty/omitted = spine default. */
  tone?: string
  /** Preferred response language (settings.responseLanguage). Empty/omitted = auto. */
  responseLanguage?: string
  /** Default answer length (settings.responseVerbosity). */
  responseVerbosity?: ResponseVerbosity
  modeSection?: string
  plan?: string
  /**
   * Plan mode: keep the `<plan>` inner text equal to on-disk plan.md (no
   * heading strip, no token cap) so str_replace/edit args can quote it.
   */
  planVerbatim?: boolean
  sessionEnv?: string
  /** Current run task list from todos.json (volatile; survives compaction folds). */
  taskList?: string
  /** Long-lived goal overlay from goal.json. */
  activeGoal?: string
}

export type ContextLayerBreakdown = {
  system: number
  history: number
  tools: number
  buffer: number
}

export type AssembleResult = {
  system: string
  systemStable: string
  systemVolatile: string
  messages: ChatMessage[]
  compaction?: CompactionRecord | null
  estimatedTokens: number
  layers: ContextLayerBreakdown
  overflow: boolean
  anthropicNative: {
    enableContextManagement: boolean
  }
}
