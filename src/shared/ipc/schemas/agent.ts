import { z } from 'zod'
import { AgentInteractionModeSchema } from './settings'
import { ProviderIdSchema } from './providers'

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024
export const MAX_IMAGE_DATA_URL_CHARS = Math.ceil(MAX_IMAGE_BYTES * (4 / 3)) + 128

/** Raw bytes an attachment may carry before extraction; PDFs are the heavy case. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
/** Base64 of `MAX_ATTACHMENT_BYTES`, rejected before main allocates the buffer. */
export const MAX_ATTACHMENT_DATA_CHARS = Math.ceil(MAX_ATTACHMENT_BYTES * (4 / 3)) + 128
/** Extracted text kept per attachment, so one document cannot eat the context. */
export const MAX_ATTACHMENT_CHARS = 120_000

/** Inline audio for providers that accept audio data URLs / inline bytes. */
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024
export const MAX_AUDIO_DATA_URL_CHARS = Math.ceil(MAX_AUDIO_BYTES * (4 / 3)) + 128
/** Native PDF/document bytes sent without text extraction. */
export const MAX_NATIVE_FILE_BYTES = 8 * 1024 * 1024
export const MAX_NATIVE_FILE_DATA_CHARS = Math.ceil(MAX_NATIVE_FILE_BYTES * (4 / 3)) + 128

/**
 * A run id becomes a directory name under the workspace sessions root, so it must
 * never contain a separator or a `..` segment. Generated ids are UUIDs.
 */
export const RunIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/, 'Invalid run id')
  .refine((value) => value !== '.' && value !== '..', 'Invalid run id')

const AttachmentImagePartSchema = z.object({
  type: z.literal('image_url'),
  url: z.string().min(1).max(MAX_IMAGE_DATA_URL_CHARS)
})

/** A document the user attached, already reduced to text in the main process. */
export const AttachmentFilePartSchema = z.object({
  type: z.literal('file'),
  name: z.string().min(1).max(400),
  mime: z.string().max(200),
  text: z.string().max(MAX_ATTACHMENT_CHARS)
})

/** Inline audio for providers that accept audio data URLs / inline bytes. */
export const AttachmentAudioPartSchema = z.object({
  type: z.literal('audio'),
  url: z.string().min(1).max(MAX_AUDIO_DATA_URL_CHARS),
  mime: z.string().max(200).optional()
})

/** Native document bytes for providers that accept PDF/file on the wire. */
export const AttachmentNativeFilePartSchema = z.object({
  type: z.literal('file_native'),
  name: z.string().min(1).max(400),
  mime: z.string().max(200),
  data: z.string().min(1).max(MAX_NATIVE_FILE_DATA_CHARS)
})

export const ContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  AttachmentImagePartSchema,
  AttachmentFilePartSchema,
  AttachmentAudioPartSchema,
  AttachmentNativeFilePartSchema
])
export type ContentPart = z.infer<typeof ContentPartSchema>

export const MessageContentSchema = z.union([z.string(), z.array(ContentPartSchema).min(1)])
export type MessageContent = z.infer<typeof MessageContentSchema>

export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: MessageContentSchema,
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  /** Whether the tool call succeeded; persisted for accurate reload without events.jsonl. */
  ok: z.boolean().optional(),
  /** Renderer history contains a preview; full tool output remains on disk. */
  contentTruncated: z.boolean().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.string()
      })
    )
    .optional(),
  /** Display/summary thinking text for UI replay (not injected into compaction). */
  thinking: z.string().optional(),
  /** Opaque provider reasoning replay state for multi-turn tool loops. */
  reasoningState: z.unknown().optional(),
  /** Loop-injected protocol turn (goal continue / plan nudge). Persisted for
   * the model, but never rendered as a user chat bubble. */
  synthetic: z.boolean().optional(),
  /** ISO timestamp when the user sent this message (turn-duration start). */
  at: z.string().datetime().optional()
})
export type ChatMessage = z.infer<typeof ChatMessageSchema>

export const RunStatusSchema = z.object({
  status: z.enum(['running', 'cancelled', 'error', 'done']),
  step: z.number().int().min(0).default(0),
  updatedAt: z.string(),
  error: z.string().optional(),
  goal: z.string().optional(),
  workspacePath: z.string().optional(),
  /** Latest chatStart invocation represented by outcome fields. */
  invokeId: z.number().int().min(1).optional(),
  /** Last Ask / Plan / Agent mode for this run (survives resume). */
  mode: AgentInteractionModeSchema.optional(),
  /** ISO timestamp when an orphan interrupt marked this run resumable. */
  interruptedAt: z.string().optional(),
  /** Present when status is cancelled but the run can resume from disk. */
  resumable: z.literal(true).optional(),
  /** Parent run that spawned this inline Agent V instance. */
  parentRunId: z.string().min(1).optional(),
  /** Hide from default sidebar list; shown nested under the parent turn. */
  inlineInstance: z.literal(true).optional(),
  /** Write path prefixes for inline instances (enforced on writers; shared-workspace fallback). */
  pathScope: z.array(z.string().min(1)).optional(),
  /** Git worktree checkout for write-capable inline instances. */
  worktreePath: z.string().min(1).optional(),
  /** Branch checked out in the instance worktree; used for sequential merge-back. */
  worktreeBranch: z.string().min(1).optional()
})
export type RunStatus = z.infer<typeof RunStatusSchema>

export function IpcResultSchema<T extends z.ZodTypeAny>(data: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({
      ok: z.literal(false),
      error: z.string(),
      code: z.string().optional()
    })
  ])
}

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string }

/**
 * Why a turn ended without finishing its work. Drives the Continue affordance:
 * the run is over, but the model was cut off rather than done. `goal_wait` is
 * the bounded goal auto-continue stop: the goal is still active but the model
 * finished twice without tool calls, so the run parks for the user instead of
 * looping unbounded.
 */
export const IncompleteReasonSchema = z.enum([
  'truncated',
  'empty_response',
  'filtered',
  'context_overflow',
  'network_interrupted',
  'circuit_open',
  'provider_error',
  'goal_wait',
  'repetition'
])
export type IncompleteReason = z.infer<typeof IncompleteReasonSchema>

/**
 * Fields on every agent event. `invokeId` identifies the chatStart invoke that produced
 * the event: a run is reused across turns, so runId alone cannot tell a live event apart
 * from one arriving late from the previous turn.
 */
const eventBase = {
  runId: z.string(),
  invokeId: z.number().int().min(1).optional()
}

export const RunGoalStatusSchema = z.enum(['active', 'paused', 'complete'])
export type RunGoalStatus = z.infer<typeof RunGoalStatusSchema>

export const RunGoalSchema = z.object({
  objective: z.string().min(1),
  status: RunGoalStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  continueCount: z.number().int().min(0).optional()
})
export type RunGoal = z.infer<typeof RunGoalSchema>

export const RunLoopStatusSchema = z.enum(['armed', 'stopped'])
export type RunLoopStatus = z.infer<typeof RunLoopStatusSchema>

export const LOOP_INTERVAL_MIN_MS = 30_000
export const LOOP_INTERVAL_MAX_MS = 86_400_000

export const RunLoopSchema = z.object({
  prompt: z.string().min(1),
  intervalMs: z.number().int().min(LOOP_INTERVAL_MIN_MS).max(LOOP_INTERVAL_MAX_MS),
  status: RunLoopStatusSchema,
  nextAt: z.string(),
  lastTickAt: z.string().optional()
})
export type RunLoop = z.infer<typeof RunLoopSchema>

const AgentEventUnionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text_delta'),
    ...eventBase,
    text: z.string()
  }),
  z.object({
    type: z.literal('thinking_delta'),
    ...eventBase,
    text: z.string(),
    step: z.number().int().min(1).optional()
  }),
  z.object({
    type: z.literal('thinking_done'),
    ...eventBase,
    text: z.string().optional(),
    step: z.number().int().min(1).optional()
  }),
  z.object({
    type: z.literal('tool_start'),
    ...eventBase,
    toolCallId: z.string(),
    name: z.string(),
    summary: z.string()
  }),
  z.object({
    type: z.literal('tool_call_delta'),
    ...eventBase,
    toolCallId: z.string(),
    name: z.string().optional(),
    argumentsDelta: z.string()
  }),
  z.object({
    type: z.literal('tool_result'),
    ...eventBase,
    toolCallId: z.string(),
    name: z.string(),
    summary: z.string(),
    ok: z.boolean(),
    content: z.string().optional(),
    /** IPC preview was capped; full output is on disk until lazy-loaded. */
    contentTruncated: z.boolean().optional()
  }),
  z.object({
    /** Live progress from a long-running tool, shown under the tool row. */
    type: z.literal('tool_progress'),
    ...eventBase,
    parentToolCallId: z.string(),
    kind: z.enum(['text', 'thinking', 'tool', 'done']),
    text: z.string()
  }),
  z.object({
    /** Parent-facing lifecycle for a spawned inline Agent V instance. */
    type: z.literal('agent_instance_update'),
    ...eventBase,
    parentRunId: z.string().min(1),
    instanceRunId: z.string().min(1),
    phase: z.enum(['started', 'done', 'error', 'cancelled']),
    goal: z.string().optional(),
    summary: z.string().optional(),
    pathScope: z.array(z.string().min(1)).optional()
  }),
  z.object({
    /** Incremental stdout/stderr from a running terminal tool call (not persisted). */
    type: z.literal('terminal_output_delta'),
    ...eventBase,
    toolCallId: z.string(),
    text: z.string(),
    stream: z.enum(['stdout', 'stderr']).optional()
  }),
  z.object({
    /** Durable snapshot of in-flight assistant output (crash recovery; never yielded live). */
    type: z.literal('stream_snapshot'),
    ...eventBase,
    step: z.number().int().min(0),
    text: z.string(),
    thinking: z.string().optional()
  }),
  z.object({
    type: z.literal('status'),
    ...eventBase,
    status: z.enum(['running', 'cancelled', 'error', 'done'])
  }),
  z.object({
    type: z.literal('error'),
    ...eventBase,
    message: z.string(),
    code: z.string().optional()
  }),
  z.object({
    type: z.literal('assistant_message'),
    ...eventBase,
    content: z.string(),
    thinking: z.string().optional(),
    toolCalls: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          arguments: z.string()
        })
      )
      .optional()
  }),
  z.object({
    /** In-progress LLM summarization of older history (auto or manual). */
    type: z.literal('compaction_started'),
    ...eventBase,
    mode: z.enum(['auto', 'manual']).optional()
  }),
  z.object({
    /** Extractive verifier is scoring the draft summary against folded facts. */
    type: z.literal('compaction_verifying'),
    ...eventBase,
    summary: z.string().optional(),
    tokenEstimate: z.number().int().min(0).optional()
  }),
  z.object({
    /** First summary failed verification; summarizer is retrying with missing facts. */
    type: z.literal('compaction_verify_retry'),
    ...eventBase,
    summary: z.string().optional(),
    failures: z.array(z.string()).min(1).max(16)
  }),
  z.object({
    /** Summary failed verification after retry — watermark was not advanced. */
    type: z.literal('compaction_verify_failed'),
    ...eventBase,
    summary: z.string().optional(),
    tokenEstimate: z.number().int().min(0).optional(),
    failures: z.array(z.string()).min(1).max(16)
  }),
  z.object({
    type: z.literal('compaction'),
    ...eventBase,
    summary: z.string(),
    tokenEstimate: z.number().int().min(0).optional(),
    /** LLM summary compaction (sole compaction kind). */
    kind: z.enum(['summary']).optional(),
    verified: z.boolean().optional(),
    verifyCoverage: z.number().min(0).max(1).optional(),
    verifyFailures: z.array(z.string()).max(16).optional()
  }),
  z.object({
    /** User-facing cost guidance (never changes settings; surface + recommend only). */
    type: z.literal('token_cost_hint'),
    ...eventBase,
    kind: z.enum([
      'context_above_soft_trigger',
      'low_cache_hit_rate',
      'high_context_watermark',
      'high_thinking_on_long_run',
      'long_run_task_boundary'
    ]),
    message: z.string().min(1)
  }),
  z.object({
    type: z.literal('incomplete'),
    ...eventBase,
    reason: IncompleteReasonSchema,
    step: z.number().int().min(1).optional(),
    /** Human-readable explanation shown next to the Continue action. */
    message: z.string()
  }),
  z.object({
    /**
     * A retry is about to re-stream this step from scratch. The renderer must drop
     * the text and thinking it already showed, or the retried output appends to it.
     */
    type: z.literal('stream_reset'),
    ...eventBase,
    step: z.number().int().min(1)
  }),
  z.object({
    /** Emitted while waiting for connectivity or before a stream retry backoff. */
    type: z.literal('network_wait'),
    ...eventBase,
    attempt: z.number().int().min(1),
    maxAttempts: z.number().int().min(1),
    retryInMs: z.number().int().min(0),
    code: z.string().optional(),
    step: z.number().int().min(1).optional()
  }),
  z.object({
    type: z.literal('step_usage'),
    ...eventBase,
    step: z.number().int().min(1),
    /** Latest step context window size (not cumulative bill). */
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    cachedInputTokens: z.number().int().min(0).optional(),
    cacheCreationInputTokens: z.number().int().min(0).optional(),
    reasoningTokens: z.number().int().min(0).optional(),
    /** Provider-reported account charge in USD when the stream included a cost field. */
    billedCost: z.number().finite().optional(),
    /** Provider-reported cache cost effect (may be negative on a write turn). */
    billedCostSaved: z.number().finite().optional(),
    /** Wall-clock ms of this provider stream (start → done usage chunk). */
    generationMs: z.number().int().min(0).optional(),
    /** Running sum of per-step inputTokens after this step (true billed shape). */
    billedInputTokens: z.number().int().min(0).optional(),
    peakInputTokens: z.number().int().min(0).optional(),
    /** Whether inputTokens already includes cached input tokens. */
    inputTokensIncludesCache: z.boolean().optional(),
    /** Provider reported any cache usage field this step. */
    cacheReported: z.boolean().optional(),
    hotspot: z.enum(['history', 'tools', 'system', 'balanced']).optional(),
    messagesCount: z.number().int().min(0).optional(),
    toolDefCount: z.number().int().min(0).optional(),
    toolResultCharsKept: z.number().int().min(0).optional(),
    compactionCountThisRun: z.number().int().min(0).optional(),
    layers: z
      .object({
        system: z.number().int().min(0),
        history: z.number().int().min(0),
        tools: z.number().int().min(0),
        buffer: z.number().int().min(0)
      })
      .optional()
  }),
  z.object({
    type: z.literal('context_usage'),
    ...eventBase,
    step: z.number().int().min(1),
    estimatedTokens: z.number().int().min(0),
    inputTokens: z.number().int().min(0).optional(),
    contextWindow: z.number().int().min(1),
    contentWindow: z.number().int().min(1).optional(),
    compactionTrigger: z.number().int().min(0),
    source: z.enum(['estimate', 'provider']),
    /** True when estimated tokens still exceed the model window after compaction/trim. */
    overflow: z.boolean().optional(),
    /** Estimate-only layer split; omit when source is provider (totals are not layer-aligned). */
    layers: z
      .object({
        system: z.number().int().min(0),
        history: z.number().int().min(0),
        tools: z.number().int().min(0),
        buffer: z.number().int().min(0)
      })
      .optional()
  }),
  z.object({
    /** Agent switched Ask / Plan / Agent mid-run; composer syncs from this. */
    type: z.literal('mode_changed'),
    ...eventBase,
    mode: AgentInteractionModeSchema
  }),
  z.object({
    /** Turn-level snapshot of agent file writes; used for Undo on the Files Changed card. */
    type: z.literal('writes_checkpoint'),
    ...eventBase,
    checkpointId: z.string().min(1),
    /** True after Keep all / Discard all / Undo fully resolves the checkpoint. */
    undone: z.boolean().optional(),
    files: z.array(
      z.object({
        path: z.string().min(1),
        action: z.enum(['created', 'modified', 'deleted']),
        undoable: z.boolean(),
        resolved: z.enum(['kept', 'discarded']).optional(),
        /** Revert was refused: the file was edited after the agent wrote it. */
        conflicted: z.boolean().optional(),
        hash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional()
      })
    )
  }),
  z.object({
    /** Mid-run follow-up accepted into the active run queue. */
    type: z.literal('follow_up_queued'),
    ...eventBase,
    id: z.string().min(1),
    position: z.number().int().min(1),
    queueLength: z.number().int().min(0),
    preview: z.string().optional()
  }),
  z.object({
    /** Mid-run follow-ups drained into the live message history. */
    type: z.literal('follow_up_applied'),
    ...eventBase,
    ids: z.array(z.string().min(1)).min(1),
    messages: z.array(ChatMessageSchema).min(1)
  }),
  z.object({
    /** Queued mid-run follow-ups discarded because the turn ended without applying them. */
    type: z.literal('follow_up_dropped'),
    ...eventBase,
    ids: z.array(z.string().min(1)).min(1),
    reason: z.string().min(1)
  }),
  z.object({
    type: z.literal('goal_update'),
    ...eventBase,
    goal: RunGoalSchema.nullable(),
    notice: z.string().min(1).optional()
  }),
  z.object({
    type: z.literal('loop_update'),
    ...eventBase,
    loop: RunLoopSchema.nullable()
  })
])

/**
 * Accepts legacy persisted `subagent_update` rows (pre-removal) by rewriting them
 * to `tool_progress` before validation. New code must emit `tool_progress` only.
 */
export const AgentEventSchema = z.preprocess((value) => {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === 'subagent_update'
  ) {
    return { ...(value as Record<string, unknown>), type: 'tool_progress' }
  }
  return value
}, AgentEventUnionSchema)
export type AgentEvent = z.infer<typeof AgentEventUnionSchema>

export const ChatStartResultSchema = z.object({
  runId: z.string(),
  invokeId: z.number().int().min(1)
})
export type ChatStartResult = z.infer<typeof ChatStartResultSchema>

/** Visible transcript run ids — main drops token streams for runs not in this set. */
export const ChatUiSubscribeRequestSchema = z.object({
  runIds: z.array(RunIdSchema)
})
export type ChatUiSubscribeRequest = z.infer<typeof ChatUiSubscribeRequestSchema>

/** Add a single run to the subscribed set without clearing the others (run start). */
export const ChatUiSubscribeAddRequestSchema = z.object({
  runId: RunIdSchema
})
export type ChatUiSubscribeAddRequest = z.infer<typeof ChatUiSubscribeAddRequestSchema>

const LIVE_DELTA_TYPES = new Set([
  'text_delta',
  'thinking_delta',
  'tool_call_delta',
  'terminal_output_delta'
])

/**
 * Fast-path live deltas (main already built them). Other types still use Zod.
 * Returns null when the payload is not a chat event.
 */
export function parseRendererChatEvent(raw: unknown): AgentEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  const type = rec.type
  const runId = rec.runId
  if (typeof type !== 'string' || typeof runId !== 'string' || !runId) return null
  if (LIVE_DELTA_TYPES.has(type)) {
    if (type === 'text_delta') {
      if (typeof rec.text !== 'string') return null
      return rec as AgentEvent
    }
    if (type === 'thinking_delta') {
      if (typeof rec.text !== 'string') return null
      return rec as AgentEvent
    }
    if (type === 'tool_call_delta') {
      if (typeof rec.toolCallId !== 'string' || typeof rec.argumentsDelta !== 'string') return null
      return rec as AgentEvent
    }
    if (typeof rec.toolCallId !== 'string' || typeof rec.text !== 'string') return null
    return rec as AgentEvent
  }
  const parsed = AgentEventSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export const RunSummarySchema = z.object({
  runId: z.string(),
  status: z.enum(['running', 'cancelled', 'error', 'done']),
  updatedAt: z.string(),
  goal: z.string().optional(),
  /** Long-lived goal runtime status from goal.json — not the chat title. */
  goalStatus: RunGoalStatusSchema.optional(),
  loopArmed: z.boolean().optional(),
  resumable: z.literal(true).optional(),
  error: z.string().optional(),
  /** Present when this run is an inline agent instance nested under a parent chat. */
  parentRunId: z.string().min(1).optional(),
  inlineInstance: z.literal(true).optional(),
  /** Write path prefixes for inline instances — used for compact sidebar labels. */
  pathScope: z.array(z.string().min(1)).optional(),
  worktreePath: z.string().min(1).optional(),
  worktreeBranch: z.string().min(1).optional()
})
export type RunSummary = z.infer<typeof RunSummarySchema>

export const ListRunsResultSchema = z.object({
  runs: z.array(RunSummarySchema),
  /** Inline agent instances (also excluded from top-level `runs`). */
  instanceRuns: z.array(RunSummarySchema).default([]),
  capped: z.boolean()
})
export type ListRunsResult = z.infer<typeof ListRunsResultSchema>

export const ListOlderRunsRequestSchema = z.object({
  workspacePath: z.string().min(1),
  /** Return parent runs updated strictly before this ISO timestamp. */
  olderThan: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional()
})
export type ListOlderRunsRequest = z.infer<typeof ListOlderRunsRequestSchema>

export const ListOlderRunsResultSchema = z.object({
  runs: z.array(RunSummarySchema),
  hasMore: z.boolean()
})
export type ListOlderRunsResult = z.infer<typeof ListOlderRunsResultSchema>

export const PersistedEventSchema = z.object({
  at: z.string(),
  event: z.unknown()
})
export type PersistedEvent = z.infer<typeof PersistedEventSchema>

export const LoadRunEventsRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: RunIdSchema
})
export type LoadRunEventsRequest = z.infer<typeof LoadRunEventsRequestSchema>

export const ChatStartRequestSchema = z
  .object({
    messages: z.array(ChatMessageSchema).optional(),
    newMessages: z.array(ChatMessageSchema).optional(),
    /**
     * Client-reported count of its messages already persisted on disk.
     * Makes resume dedupe positional (index-based) instead of text-only.
     */
    persistedMessageCount: z.number().int().min(0).optional(),
    incremental: z.boolean().optional(),
    workspacePath: z.string().min(1),
    focusedFile: z.string().max(4_096).optional(),
    runId: RunIdSchema.optional(),
    /** Ask / Plan / Agent — authoritative for this invoke. */
    mode: AgentInteractionModeSchema.optional(),
    /** Session's pinned provider — authoritative for this invoke. */
    provider: ProviderIdSchema.optional(),
    /** Session's pinned model — authoritative for this invoke. */
    model: z.string().min(1).optional()
  })
  .superRefine((val, ctx) => {
    if (val.incremental) {
      if (!val.runId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'incremental requires runId',
          path: ['runId']
        })
      }
      if (!val.newMessages?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'incremental requires newMessages',
          path: ['newMessages']
        })
      }
      return
    }
    if (val.runId && val.messages?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'messages are ignored on resume; use incremental newMessages',
        path: ['messages']
      })
    }
    if (!val.runId && !val.messages?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'messages required when not incremental',
        path: ['messages']
      })
    }
  })
export type ChatStartRequest = z.infer<typeof ChatStartRequestSchema>

/** Edit a past user message: restore write checkpoints, truncate history, re-run. */
export const ChatRewindAndStartRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: RunIdSchema,
  /** Index into messages.jsonl of the user message being replaced. */
  editMessageIndex: z.number().int().min(0),
  editedUserMessage: ChatMessageSchema.refine((m) => m.role === 'user', {
    message: 'editedUserMessage must be a user message'
  }),
  mode: AgentInteractionModeSchema.optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().min(1).optional()
})
export type ChatRewindAndStartRequest = z.infer<typeof ChatRewindAndStartRequestSchema>

/** Revert to a past user message: restore write checkpoints, truncate history, no re-run. */
export const ChatRewindRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: RunIdSchema,
  /** Index into messages.jsonl of the user message to rewind to (inclusive). */
  userMessageIndex: z.number().int().min(0)
})
export type ChatRewindRequest = z.infer<typeof ChatRewindRequestSchema>

export const ChatRewindResultSchema = z.object({
  messages: z.array(ChatMessageSchema),
  restored: z.array(z.string()),
  skipped: z.array(z.string())
})
export type ChatRewindResult = z.infer<typeof ChatRewindResultSchema>

/** Read-only preview of which files chatRewind to userMessageIndex would restore. */
export const ChatRewindPreviewResultSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      action: z.enum(['created', 'modified', 'deleted']),
      undoable: z.boolean()
    })
  )
})
export type ChatRewindPreviewResult = z.infer<typeof ChatRewindPreviewResultSchema>

export const CancelRunRequestSchema = z.object({
  runId: RunIdSchema
})

export const ChatFollowUpRequestSchema = z.object({
  runId: RunIdSchema,
  message: ChatMessageSchema.refine((m) => m.role === 'user', {
    message: 'Follow-up must be a user message'
  }),
  mode: AgentInteractionModeSchema.optional()
})
export type ChatFollowUpRequest = z.infer<typeof ChatFollowUpRequestSchema>

export const ChatQueueModeRequestSchema = z.object({
  runId: RunIdSchema,
  mode: AgentInteractionModeSchema
})
export type ChatQueueModeRequest = z.infer<typeof ChatQueueModeRequestSchema>

export const ChatQueueModeResultSchema = z.object({
  queued: z.literal(true)
})
export type ChatQueueModeResult = z.infer<typeof ChatQueueModeResultSchema>

export const ChatFollowUpResultSchema = z.object({
  id: z.string().min(1),
  position: z.number().int().min(1),
  queueLength: z.number().int().min(0)
})
export type ChatFollowUpResult = z.infer<typeof ChatFollowUpResultSchema>

export const ChatFollowUpRemoveRequestSchema = z.object({
  runId: RunIdSchema,
  id: z.string().min(1)
})
export type ChatFollowUpRemoveRequest = z.infer<typeof ChatFollowUpRemoveRequestSchema>

export const ChatFollowUpRemoveResultSchema = z.object({
  removed: z.boolean(),
  queueLength: z.number().int().min(0)
})
export type ChatFollowUpRemoveResult = z.infer<typeof ChatFollowUpRemoveResultSchema>

export const ChatFollowUpUpdateRequestSchema = z.object({
  runId: RunIdSchema,
  id: z.string().min(1),
  message: ChatMessageSchema.refine((m) => m.role === 'user', {
    message: 'Follow-up must be a user message'
  })
})
export type ChatFollowUpUpdateRequest = z.infer<typeof ChatFollowUpUpdateRequestSchema>

export const ChatFollowUpUpdateResultSchema = z.object({
  preview: z.string(),
  queueLength: z.number().int().min(0)
})
export type ChatFollowUpUpdateResult = z.infer<typeof ChatFollowUpUpdateResultSchema>

export const ChatFollowUpPromoteRequestSchema = z.object({
  runId: RunIdSchema,
  id: z.string().min(1)
})
export type ChatFollowUpPromoteRequest = z.infer<typeof ChatFollowUpPromoteRequestSchema>

export const ChatFollowUpPromoteResultSchema = z.object({
  queueLength: z.number().int().min(0)
})
export type ChatFollowUpPromoteResult = z.infer<typeof ChatFollowUpPromoteResultSchema>

export const CompactRunRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: RunIdSchema,
  /** Optional operator focus for the summarizer (manual Compact / IPC). */
  focus: z.string().max(2000).optional()
})
export type CompactRunRequest = z.infer<typeof CompactRunRequestSchema>

export const CompactRunResultSchema = z.object({
  summary: z.string(),
  tokenEstimate: z.number().int().min(0),
  /** Messages the working set was reduced to, for the confirmation message. */
  keptMessages: z.number().int().min(0),
  messagesBefore: z.number().int().min(0),
  /** Post-compact estimate for the live context meter. */
  estimatedTokens: z.number().int().min(0).optional(),
  contextWindow: z.number().int().min(1).optional(),
  contentWindow: z.number().int().min(1).optional(),
  /** ask_question answers preserved from the folded prefix. */
  retainedDecisions: z.array(z.string()).max(8).optional(),
  verified: z.boolean().optional(),
  verifyCoverage: z.number().min(0).max(1).optional(),
  verifyFailures: z.array(z.string()).max(16).optional()
})
export type CompactRunResult = z.infer<typeof CompactRunResultSchema>

export const ResolveWritesRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: RunIdSchema,
  checkpointId: z.string().min(1).optional(),
  action: z.enum(['keep', 'discard']),
  /** When omitted, applies to all unresolved files. */
  paths: z.array(z.string().min(1)).optional()
})
export type ResolveWritesRequest = z.infer<typeof ResolveWritesRequestSchema>

export const ResolveWritesResultSchema = z.object({
  /** '' when the request was a soft no-op (no actionable checkpoint). */
  checkpointId: z.string(),
  kept: z.array(z.string()),
  discarded: z.array(z.string()),
  skipped: z.array(z.string()),
  conflicted: z.array(z.string()),
  fullyResolved: z.boolean()
})
export type ResolveWritesResult = z.infer<typeof ResolveWritesResultSchema>

/** Fixed run-dir artifact names (non-screenshot). */
export const RunArtifactFixedNameSchema = z.enum([
  'plan.md',
  'contract.md',
  'receipt.json',
  'todos.json',
  'goal.json',
  'loop.json',
  'trajectory.jsonl',
  'prediction.json'
])

/** Screenshot artifacts: latest alias or unique `browser/snapshot-<id>.jpg`. */
export const RunArtifactBrowserSnapshotSchema = z
  .string()
  .regex(/^browser\/snapshot(?:-[\w.-]+)?\.jpg$/)

/** Run-dir artifacts readable via `runs:readArtifact`. */
export const RunArtifactNameSchema = z.union([
  RunArtifactFixedNameSchema,
  RunArtifactBrowserSnapshotSchema
])
export type RunArtifactName = z.infer<typeof RunArtifactNameSchema>

export const TRAJECTORY_FILENAME = 'trajectory.jsonl' as const
export const PREDICTION_FILENAME = 'prediction.json' as const
export const PREDICTION_MANIFEST_VERSION = 1 as const

/** One observational row in trajectory.jsonl (derived from events.jsonl). */
export const TrajectoryRowSchema = z.object({
  at: z.string().optional(),
  step: z.number().int().min(0),
  kind: z.string().min(1),
  tool: z.string().optional(),
  toolCallId: z.string().optional(),
  ok: z.boolean().optional(),
  summary: z.string().optional(),
  reason: z.string().optional(),
  status: z.string().optional(),
  mode: z.string().optional(),
  parentToolCallId: z.string().optional(),
  progressKind: z.string().optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  estimatedTokens: z.number().int().min(0).optional(),
  overflow: z.boolean().optional(),
  fileCount: z.number().int().min(0).optional()
})
export type TrajectoryRow = z.infer<typeof TrajectoryRowSchema>

/** Observational prediction manifest — never auto-applied to harness sections. */
export const PredictionEntrySchema = z.object({
  at: z.string().min(1),
  step: z.number().int().min(0).optional(),
  type: z.literal('harness_section'),
  target: z.enum(['context', 'tool_policy', 'memory', 'work_style']),
  bucket: z
    .enum(['system_prompt', 'tool_policy', 'loop_notices', 'memory'])
    .optional(),
  confidence: z.number().min(0).max(1),
  observed_only: z.literal(true),
  reason: z.string().optional()
})
export type PredictionEntry = z.infer<typeof PredictionEntrySchema>

export const PredictionManifestSchema = z.object({
  version: z.literal(PREDICTION_MANIFEST_VERSION),
  runId: z.string().min(1),
  writtenAt: z.string().min(1),
  observed_only: z.literal(true),
  predictions: z.array(PredictionEntrySchema)
})
export type PredictionManifest = z.infer<typeof PredictionManifestSchema>

/** Per-run loop checkpoint for survive-restart (step-boundary loop invariants). */
export const LOOP_CHECKPOINT_VERSION = 3 as const

export const LoopCheckpointSchema = z.object({
  version: z.literal(LOOP_CHECKPOINT_VERSION),
  step: z.number().int().min(0),
  invokeId: z.number().int().min(1),
  updatedAt: z.string().min(1),
  truncationContinues: z.number().int().min(0).default(0),
  overflowRetryUsed: z.boolean().default(false),
  /** Runaway-loop invariants, restored on interrupted resume (v2). */
  identicalStepStreak: z.number().int().min(0).default(0),
  lastStepFingerprint: z.string().max(64).default(''),
  /**
   * Near-identical reasoning streak across steps (run be413e92 second guard).
   * Additive v3 fields with defaults: older checkpoints parse/resume with
   * 0 / '' / 0 and LOOP_CHECKPOINT_VERSION stays 3.
   */
  identicalReasoningStreak: z.number().int().min(0).default(0),
  lastReasoningFingerprint: z.string().max(64).default(''),
  /** Generation-repetition aborts auto-continued so far (capped by loopPolicy MAX_REPETITION_ABORTS). */
  repetitionAborts: z.number().int().min(0).default(0),
  consecutiveToolFailureSteps: z.number().int().min(0).default(0),
  /**
   * Signatures of recent all-failed steps, newest first. Additive field:
   * checkpoints written before it parse to []. Feeds the failure-streak
   * novelty rule in loopPolicy.ts; the cap must stay in sync with
   * FAILURE_SIGNATURE_WINDOW there.
   */
  recentFailureSignatures: z.array(z.string().max(64)).max(32).default([]),
  emptyResponseContinues: z.number().int().min(0).default(0),
  goalNoToolFinishes: z.number().int().min(0).default(0),
  /**
   * Durable cumulative usage (v3). events.jsonl rotates its archives
   * (MAX_EVENT_ARCHIVES) and deletes the oldest, so re-summing step_usage
   * rows on resume silently loses billed tokens/cost once history rotates.
   * This checkpoint is monotonic and survives rotation.
   */
  usageTotals: z
    .object({
      billedInputTokens: z.number().int().min(0),
      peakInputTokens: z.number().int().min(0),
      outputTokens: z.number().int().min(0),
      billedCachedInputTokens: z.number().int().min(0),
      cacheCreationInputTokens: z.number().int().min(0),
      reasoningTokens: z.number().int().min(0),
      steps: z.number().int().min(0),
      stepsWithCacheReport: z.number().int().min(0),
      billedCost: z.number(),
      billedCostSaved: z.number(),
      stepsWithCostReport: z.number().int().min(0),
      generationMs: z.number().int().min(0),
      lastStepInputTokens: z.number().int().min(0)
    })
    .optional()
})
export type LoopCheckpoint = z.infer<typeof LoopCheckpointSchema>

/** Per-run receipt.json written at agent loop teardown. */
export const RUN_RECEIPT_VERSION = 5 as const

export const RunReceiptToolStatSchema = z.object({
  ok: z.number().int().min(0),
  failed: z.number().int().min(0)
})
export type RunReceiptToolStat = z.infer<typeof RunReceiptToolStatSchema>

/** Real cumulative token accounting for a run (rebuilt from durable step_usage events). */
export const RunTokenUsageSchema = z.object({
  /** Latest step context window size. */
  inputTokens: z.number().int().min(0).optional(),
  /** Sum of per-step input tokens (multi-step billed input). */
  billedInputTokens: z.number().int().min(0).optional(),
  peakInputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  reasoningTokens: z.number().int().min(0).optional(),
  cachedInputTokens: z.number().int().min(0).optional(),
  billedCachedInputTokens: z.number().int().min(0).optional(),
  cacheCreationInputTokens: z.number().int().min(0).optional()
})
export type RunTokenUsage = z.infer<typeof RunTokenUsageSchema>

/** Per-run usage stat for aggregate surfaces (Home usage strip). */
export const RunStatSchema = z.object({
  runId: z.string(),
  /** Transcript rows stitched across rotated archive heads + the live file. */
  messages: z.number().int().min(0),
  tokenUsage: RunTokenUsageSchema.optional(),
  // — Session detail from receipt.json (absent while a run has no receipt). —
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  billedCost: z.number().finite().optional(),
  /** Final agent step count (receipt.step). */
  steps: z.number().int().min(0).optional(),
  compactionCount: z.number().int().min(0).optional(),
  toolStats: z
    .object({
      totalCalls: z.number().int().min(0),
      ok: z.number().int().min(0),
      failed: z.number().int().min(0),
      byName: z.record(z.string(), RunReceiptToolStatSchema)
    })
    .optional(),
  failureClusters: z
    .array(z.object({ key: z.string(), count: z.number().int().min(1) }))
    .optional(),
  maxConsecutiveToolFailures: z.number().int().min(0).optional(),
  verification: z
    .object({
      lastMutationAt: z.string().optional(),
      lastCheckAt: z.string().optional(),
      verifiedAfterLastMutation: z.boolean()
    })
    .optional(),
  /** Raw model context window in effect at the final step (context pressure). */
  contextWindow: z.number().int().min(0).optional(),
  /** First persisted event timestamp — run start (duration = writtenAt − this). */
  startedAt: z.string().optional(),
  writtenAt: z.string().optional()
})
export type RunStat = z.infer<typeof RunStatSchema>

export const RunStatsRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runIds: z.array(z.string().min(1)).min(1).max(100)
})
export type RunStatsRequest = z.infer<typeof RunStatsRequestSchema>

export const RunStatsResultSchema = z.object({
  stats: z.array(RunStatSchema)
})
export type RunStatsResult = z.infer<typeof RunStatsResultSchema>

/** Home Activity request: aggregate over the open workspaces' receipts. */
export const HomeActivityRequestSchema = z.object({
  workspacePaths: z.array(z.string().min(1)).min(1).max(12),
  /** Local-day window (1–30); the renderer offers 7 and 30. Default 7. */
  windowDays: z.number().int().min(1).max(30).optional()
})
export type HomeActivityRequest = z.infer<typeof HomeActivityRequestSchema>

/** One local-day bucket of usage derived from run receipts. */
export const HomeActivityDaySchema = z.object({
  /** Local calendar day (YYYY-MM-DD) of the receipt's writtenAt. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  runs: z.number().int().min(0),
  billedInputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** Only when a run's durable checkpoint reported provider cost. */
  billedCost: z.number().finite().optional(),
  /** Output tokens per model — only for runs whose receipt recorded one. */
  byModel: z.record(z.string().min(1), z.number().int().min(0)).optional(),
  /** Billed thinking tokens recorded that day (subset of output). */
  reasoningTokens: z.number().int().min(0).optional(),
  /** Peak per-step context input recorded that day (max across runs). */
  peakInputTokens: z.number().int().min(0).optional(),
  /** Raw model context window in effect that day (latest reported). */
  contextWindow: z.number().int().min(0).optional()
})
export type HomeActivityDay = z.infer<typeof HomeActivityDaySchema>

/** Per-workspace usage slice — only included for multi-workspace requests. */
export const HomeActivityWorkspaceSchema = z.object({
  path: z.string().min(1),
  runs: z.number().int().min(0),
  billedInputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  billedCost: z.number().finite().optional()
})
export type HomeActivityWorkspace = z.infer<typeof HomeActivityWorkspaceSchema>

/** Compact 7-day activity for the Home tab — all values from real receipts. */
export const HomeActivityResultSchema = z.object({
  /** Only days that have data, ascending; the renderer fills the sparse axis. */
  days: z.array(HomeActivityDaySchema),
  /** Days with any activity in the window (streak/cadence signal). */
  activeDays: z.number().int().min(0).optional(),
  /** Requested window in local days (echoes the request; default 7). */
  windowDays: z.number().int().min(1).max(30).optional(),
  /** Per-workspace usage slices — only for multi-workspace requests. */
  workspaces: z.array(HomeActivityWorkspaceSchema).optional(),
  /**
   * Attention signals from receipts — present only when receipts report them.
   * unverifiedRuns counts parent runs whose files were mutated after the last
   * check; topTools aggregates per-tool ok/failed across window receipts.
   */
  attention: z
    .object({
      unverifiedRuns: z.number().int().min(0),
      /** Sessions that ended in error — newest first, max 3 (attention digest). */
      errorRuns: z
        .array(
          z.object({
            runId: z.string().min(1),
            /** Owning workspace — lets Home open the run directly. */
            workspacePath: z.string().min(1),
            goal: z.string().optional()
          })
        )
        .optional(),
      topTools: z
        .array(
          z.object({
            name: z.string().min(1),
            ok: z.number().int().min(0),
            failed: z.number().int().min(0)
          })
        )
        .optional()
    })
    .optional(),
  outcomes: z.object({
    done: z.number().int().min(0),
    error: z.number().int().min(0),
    cancelled: z.number().int().min(0),
    running: z.number().int().min(0)
  }),
  totals: z.object({
    runs: z.number().int().min(0),
    billedInputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    billedCost: z.number().finite().optional(),
    cachedInputTokens: z.number().int().min(0).optional(),
    /** Billed thinking tokens in the window (subset of output). */
    reasoningTokens: z.number().int().min(0).optional(),
    /** Peak per-step context input in the window (max across runs). */
    peakInputTokens: z.number().int().min(0).optional(),
    /** Raw model context window (latest reported in the window). */
    contextWindow: z.number().int().min(0).optional(),
    /** Token total (input+output) of the prior equal-length window, when > 0. */
    previousTokens: z.number().int().min(0).optional()
  }),
  generatedAt: z.string().min(1)
})
export type HomeActivityResult = z.infer<typeof HomeActivityResultSchema>

export const RunReceiptSchema = z.object({
  version: z.literal(RUN_RECEIPT_VERSION),
  writtenAt: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(['running', 'cancelled', 'error', 'done']),
  step: z.number().int().min(0),
  /** Longest run of back-to-back failed tool calls in message order (weakness signal). */
  maxConsecutiveToolFailures: z.number().int().min(0).optional(),
  /** ChatStart invoke that produced this receipt (aligns with status.invokeId). */
  invokeId: z.number().int().min(1).optional(),
  goal: z.string().optional(),
  mode: z.string().optional(),
  /** Provider that served this run — forward-looking usage tagging. */
  provider: z.string().min(1).optional(),
  /** Model that served this run — forward-looking usage tagging. */
  model: z.string().min(1).optional(),
  /**
   * Provider-reported cumulative cost for the run, carried from the durable
   * usage totals at final receipt write. Absent on interim receipts and runs
   * whose provider never reported a cost field — never a fake 0.
   */
  billedCost: z.number().finite().optional(),
  /** Raw model context window in effect at the final step (context pressure). */
  contextWindow: z.number().int().min(0).optional(),
  /** First persisted event timestamp — run start (duration = writtenAt − this). */
  startedAt: z.string().optional(),
  statusError: z.string().optional(),
  incomplete: z
    .object({
      reason: IncompleteReasonSchema,
      message: z.string().optional()
    })
    .optional(),
  tokenUsage: RunTokenUsageSchema.optional(),
  compactionCount: z.number().int().min(0),
  toolStats: z.object({
    totalCalls: z.number().int().min(0),
    ok: z.number().int().min(0),
    failed: z.number().int().min(0),
    byName: z.record(z.string(), RunReceiptToolStatSchema)
  }),
  failureClusters: z.array(
    z.object({
      key: z.string(),
      count: z.number().int().min(1)
    })
  ),
  unreadEditPaths: z.array(z.string()),
  wroteFiles: z.array(z.string()),
  diagnostics: z.object({
    calls: z.number().int().min(0),
    ok: z.number().int().min(0),
    clean: z.number().int().min(0).default(0)
  }),
  /** run_tests aggregate: call counts plus the latest parsed pass/fail summary. */
  tests: z
    .object({
      calls: z.number().int().min(0),
      ok: z.number().int().min(0),
      failed: z.number().int().min(0),
      lastPassed: z.number().int().min(0).optional(),
      lastFailed: z.number().int().min(0).optional()
    })
    .optional(),
  /** Was the work verified? Last successful check vs last file mutation. */
  verification: z
    .object({
      lastMutationAt: z.string().optional(),
      lastCheckAt: z.string().optional(),
      verifiedAfterLastMutation: z.boolean()
    })
    .optional(),
  contractExcerpt: z.string()
})
export type RunReceipt = z.infer<typeof RunReceiptSchema>

export const HarnessReviewRequestSchema = z.object({
  workspacePath: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional()
})
export type HarnessReviewRequest = z.infer<typeof HarnessReviewRequestSchema>

export const HarnessReviewResultSchema = z.object({
  proposalPath: z.string().min(1),
  relativePath: z.string().min(1),
  receiptCount: z.number().int().min(0),
  summary: z.string()
})
export type HarnessReviewResult = z.infer<typeof HarnessReviewResultSchema>

export const HarnessPreviewApplyRequestSchema = z.object({
  workspacePath: z.string().min(1),
  proposalPath: z.string().min(1).optional()
})
export type HarnessPreviewApplyRequest = z.infer<typeof HarnessPreviewApplyRequestSchema>

export const HarnessPreviewApplyResultSchema = z.object({
  proposalPath: z.string().min(1),
  relativePath: z.string().min(1),
  current: z.string(),
  proposed: z.string(),
  changed: z.boolean()
})
export type HarnessPreviewApplyResult = z.infer<typeof HarnessPreviewApplyResultSchema>

export const HarnessApplyRequestSchema = z.object({
  workspacePath: z.string().min(1),
  proposalPath: z.string().min(1).optional(),
  /** Must be true — accidental applies are rejected. */
  confirm: z.literal(true)
})
export type HarnessApplyRequest = z.infer<typeof HarnessApplyRequestSchema>

export const HarnessApplyResultSchema = z.object({
  applied: z.boolean(),
  proposalPath: z.string().min(1),
  relativePath: z.string().min(1),
  harnessPath: z.string().min(1),
  validationOk: z.boolean(),
  validationOutput: z.string(),
  reverted: z.boolean()
})
export type HarnessApplyResult = z.infer<typeof HarnessApplyResultSchema>

export const ReadRunArtifactRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: RunIdSchema,
  name: RunArtifactNameSchema
})
export type ReadRunArtifactRequest = z.infer<typeof ReadRunArtifactRequestSchema>

export const ReadRunArtifactResultSchema = z.object({
  name: RunArtifactNameSchema,
  exists: z.boolean(),
  content: z.string().nullable()
})
export type ReadRunArtifactResult = z.infer<typeof ReadRunArtifactResultSchema>

export const SetGoalStatusRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: RunIdSchema,
  action: z.enum(['pause', 'resume', 'complete']),
  objective: z.string().min(1).optional()
})
export type SetGoalStatusRequest = z.infer<typeof SetGoalStatusRequestSchema>

export const SetGoalStatusResultSchema = z.object({
  goal: RunGoalSchema.nullable()
})
export type SetGoalStatusResult = z.infer<typeof SetGoalStatusResultSchema>

export const SetLoopRequestSchema = z
  .object({
    workspacePath: z.string().min(1),
    runId: RunIdSchema,
    action: z.enum(['arm', 'stop']),
    intervalMs: z.number().int().min(LOOP_INTERVAL_MIN_MS).max(LOOP_INTERVAL_MAX_MS).optional(),
    prompt: z.string().min(1).optional()
  })
  .superRefine((val, ctx) => {
    if (val.action === 'arm') {
      if (val.intervalMs == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'arm requires intervalMs',
          path: ['intervalMs']
        })
      }
      if (!(val.prompt && val.prompt.trim())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'arm requires prompt',
          path: ['prompt']
        })
      }
    }
  })
export type SetLoopRequest = z.infer<typeof SetLoopRequestSchema>

export const SetLoopResultSchema = z.object({
  loop: RunLoopSchema.nullable()
})
export type SetLoopResult = z.infer<typeof SetLoopResultSchema>

/**
 * A gated tool call waiting on the user. The loop is parked on this request, so
 * the renderer must either answer it or cancel the run.
 */
export const ToolApprovalRequestSchema = z.object({
  requestId: z.string().min(1),
  runId: z.string().min(1),
  toolCallId: z.string().min(1),
  name: z.string().min(1),
  summary: z.string(),
  /** Raw arguments so the card can show exactly what would run. */
  argsPreview: z.string(),
  /** False for approval-exempt tools; true for mutating tools, web_fetch, and MCP. */
  mutating: z.boolean()
})
export type ToolApprovalRequest = z.infer<typeof ToolApprovalRequestSchema>

export const ToolApprovalDecisionSchema = z.enum(['once', 'session', 'always', 'deny'])
export type ToolApprovalDecision = z.infer<typeof ToolApprovalDecisionSchema>

export const ToolApprovalResponseSchema = z.object({
  requestId: z.string().min(1),
  runId: z.string().min(1),
  decision: ToolApprovalDecisionSchema
})
export type ToolApprovalResponse = z.infer<typeof ToolApprovalResponseSchema>

export const ListPendingToolApprovalsRequestSchema = z.object({
  runId: RunIdSchema
})
export type ListPendingToolApprovalsRequest = z.infer<
  typeof ListPendingToolApprovalsRequestSchema
>

export const AgentQuestionTypeSchema = z.enum(['single', 'multi', 'boolean', 'text'])

export const AgentQuestionItemSchema = z
  .object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    type: AgentQuestionTypeSchema,
    options: z.array(z.string().min(1)).optional(),
    allowCustom: z.boolean().optional()
  })
  .superRefine((item, ctx) => {
    if (item.type === 'single' || item.type === 'multi') {
      if (!item.options || item.options.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${item.type} requires at least 2 options`,
          path: ['options']
        })
      }
    }
  })

/**
 * A structured question form waiting on the user. The loop is parked on this
 * request, so the renderer must answer it or cancel the run.
 */
export const AgentQuestionRequestSchema = z.object({
  requestId: z.string().min(1),
  runId: z.string().min(1),
  toolCallId: z.string().min(1),
  title: z.string().min(1).optional(),
  questions: z.array(AgentQuestionItemSchema).min(1)
})
export type AgentQuestionRequest = z.infer<typeof AgentQuestionRequestSchema>
export type AgentQuestionItem = z.infer<typeof AgentQuestionItemSchema>

export const AgentQuestionAnswerSchema = z.object({
  questionId: z.string().min(1),
  values: z.array(z.string())
})
export type AgentQuestionAnswer = z.infer<typeof AgentQuestionAnswerSchema>

export const AgentQuestionResponseSchema = z.object({
  requestId: z.string().min(1),
  runId: z.string().min(1),
  answers: z.array(AgentQuestionAnswerSchema)
})
export type AgentQuestionResponse = z.infer<typeof AgentQuestionResponseSchema>

/** Preload → main when a question payload fails Zod validation (fail fast, no 15m wait). */
export const AgentQuestionRejectSchema = z
  .object({
    requestId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    reason: z.string().min(1).optional()
  })
  .refine((v) => Boolean(v.requestId || v.runId), {
    message: 'requestId or runId required'
  })
export type AgentQuestionReject = z.infer<typeof AgentQuestionRejectSchema>

export const ListPendingAgentQuestionsRequestSchema = z.object({
  runId: RunIdSchema
})
export type ListPendingAgentQuestionsRequest = z.infer<
  typeof ListPendingAgentQuestionsRequestSchema
>

export const ListRunsRequestSchema = z.object({
  workspacePath: z.string().min(1)
})

export const LoadRunRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: RunIdSchema
})

export const LoadRunPendingFollowUpSchema = z.object({
  id: z.string().min(1),
  preview: z.string(),
  ready: z.boolean().optional()
})

export const LoadRunResultSchema = z.object({
  runId: RunIdSchema,
  messages: z.array(ChatMessageSchema),
  pendingFollowUps: z.array(LoadRunPendingFollowUpSchema).default([]),
  status: z.enum(['running', 'cancelled', 'error', 'done']).optional(),
  resumable: z.literal(true).optional(),
  error: z.string().optional()
})
export type LoadRunResult = z.infer<typeof LoadRunResultSchema>

export const LoadToolResultRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: RunIdSchema,
  toolCallId: z.string().min(1)
})
export type LoadToolResultRequest = z.infer<typeof LoadToolResultRequestSchema>

export const LoadToolResultResultSchema = z.object({
  content: z.string()
})
export type LoadToolResultResult = z.infer<typeof LoadToolResultResultSchema>

export const DeleteRunRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: RunIdSchema
})
export type DeleteRunRequest = z.infer<typeof DeleteRunRequestSchema>

export const ExportRunRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: RunIdSchema
})
export type ExportRunRequest = z.infer<typeof ExportRunRequestSchema>

export const ExportRunResultSchema = z.object({
  saved: z.boolean(),
  /** Absolute path of the written file when saved. */
  path: z.string().optional()
})
export type ExportRunResult = z.infer<typeof ExportRunResultSchema>

export const RenameRunRequestSchema = z.object({
  workspacePath: z.string().min(1),
  runId: RunIdSchema,
  goal: z.string().min(1)
})
export type RenameRunRequest = z.infer<typeof RenameRunRequestSchema>

export const ActiveRunSchema = z.object({
  runId: z.string(),
  workspacePath: z.string(),
  invokeId: z.number().int().min(1),
  pendingFollowUps: z
    .array(
      z.object({
        id: z.string().min(1),
        preview: z.string()
      })
    )
    .default([])
})
export type ActiveRun = z.infer<typeof ActiveRunSchema>

export const ActiveRunsResultSchema = z.array(ActiveRunSchema)
export type ActiveRunsResult = z.infer<typeof ActiveRunsResultSchema>

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

export function fail(error: string, code?: string): IpcResult<never> {
  return code ? { ok: false, error, code } : { ok: false, error }
}

export function contentDisplayText(content: MessageContent): string {
  if (typeof content === 'string') return content
  return content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim()
}

export function contentImages(content: MessageContent): string[] {
  if (typeof content === 'string') return []
  return content.filter((p) => p.type === 'image_url').map((p) => p.url)
}

export type AttachedFile = Extract<ContentPart, { type: 'file' }>
export type AttachedAudio = Extract<ContentPart, { type: 'audio' }>
export type AttachedNativeFile = Extract<ContentPart, { type: 'file_native' }>

export function contentAudios(content: MessageContent): AttachedAudio[] {
  if (typeof content === 'string') return []
  return content.filter((p): p is AttachedAudio => p.type === 'audio')
}

export function contentNativeFiles(content: MessageContent): AttachedNativeFile[] {
  if (typeof content === 'string') return []
  return content.filter((p): p is AttachedNativeFile => p.type === 'file_native')
}

/** Renderer hands raw bytes to main, which owns the parsers and the caps. */
export const ExtractAttachmentRequestSchema = z.object({
  name: z.string().min(1).max(400),
  mime: z.string().max(200).default(''),
  /** Base64 of the file bytes, capped at `MAX_ATTACHMENT_BYTES` once decoded. */
  data: z.string().min(1).max(MAX_ATTACHMENT_DATA_CHARS)
})
export type ExtractAttachmentRequest = z.infer<typeof ExtractAttachmentRequestSchema>

export const ExtractAttachmentResultSchema = z.object({
  name: z.string(),
  mime: z.string(),
  text: z.string(),
  /** True when the document was longer than `MAX_ATTACHMENT_CHARS`. */
  truncated: z.boolean()
})
export type ExtractAttachmentResult = z.infer<typeof ExtractAttachmentResultSchema>

/**
 * Cloud audio payload (compressed) hard limit — matches the OpenAI / OpenRouter
 * Transcriptions API 25 MiB limit. Cloud callers are rejected at upload time
 * (`transcribe.ts`) once decoded bytes exceed this.
 */
export const MAX_DICTATION_BYTES = 25 * 1024 * 1024
/** Base64 of `MAX_DICTATION_BYTES`, rejected before main allocates the buffer. */
export const MAX_DICTATION_DATA_CHARS = Math.ceil(MAX_DICTATION_BYTES * (4 / 3)) + 128

/**
 * Local engines do not upload and process audio on-device, so they are not
 * bound by the 25 MiB cloud limit. Allow long recordings (up to ~60 min of
 * 16 kHz mono Int16 PCM ≈ 115 MiB) so dictation never silently truncates.
 */
export const MAX_LOCAL_AUDIO_BYTES = 120 * 1024 * 1024
export const MAX_LOCAL_AUDIO_DATA_CHARS = Math.ceil(MAX_LOCAL_AUDIO_BYTES * (4 / 3)) + 128

/**
 * UX auto-stop. Local engines chunk/process the whole clip, so we let them run
 * up to an hour. Cloud engines share the same generous window; their true
 * ceiling is the 25 MiB byte guard checked at upload time, not a duration cap.
 */
export const MAX_DICTATION_MS = 60 * 60 * 1000
export const MAX_LOCAL_DICTATION_MS = 60 * 60 * 1000

export const DictationTranscribeRequestSchema = z.object({
  requestId: z.string().min(1).max(100).optional(),
  mime: z.string().max(200).default('audio/webm'),
  /**
   * Base64 of the recording bytes. Cloud callers stay under `MAX_DICTATION_BYTES`
   * (OpenAI limit, enforced in `transcribe.ts`); local callers may be larger and
   * are bounded by `MAX_LOCAL_AUDIO_BYTES` in `local.ts`.
   */
  data: z.string().min(1).max(MAX_LOCAL_AUDIO_DATA_CHARS),
  /**
   * Optional 16 kHz mono little-endian Int16 PCM (base64). Required when
   * `settings.dictation.engine === 'local'`. Cloud callers omit it.
   */
  pcm16k: z.string().min(1).max(MAX_LOCAL_AUDIO_DATA_CHARS).optional()
})
export type DictationTranscribeRequest = z.infer<typeof DictationTranscribeRequestSchema>

export const DictationCancelRequestSchema = z.object({
  requestId: z.string().min(1).max(100)
})
export type DictationCancelRequest = z.infer<typeof DictationCancelRequestSchema>

export const DictationTranscribeResultSchema = z.object({
  text: z.string()
})
export type DictationTranscribeResult = z.infer<typeof DictationTranscribeResultSchema>

export const WorkspaceSuggestPathsRequestSchema = z.object({
  workspacePath: z.string().min(1),
  query: z.string().optional(),
  maxResults: z.number().int().min(1).max(100).optional()
})
export type WorkspaceSuggestPathsRequest = z.infer<typeof WorkspaceSuggestPathsRequestSchema>

export const WorkspaceSuggestPathsResultSchema = z.object({
  paths: z.array(z.string()),
  /** Total matches before slicing to maxResults. */
  total: z.number().int().min(0)
})
export type WorkspaceSuggestPathsResult = z.infer<typeof WorkspaceSuggestPathsResultSchema>

export const WorkspaceReadTextRequestSchema = z.object({
  workspacePath: z.string().min(1),
  path: z.string().min(1)
})
export type WorkspaceReadTextRequest = z.infer<typeof WorkspaceReadTextRequestSchema>

export const WorkspaceReadTextResultSchema = z.object({
  name: z.string(),
  mime: z.string(),
  text: z.string().max(MAX_ATTACHMENT_CHARS),
  truncated: z.boolean()
})
export type WorkspaceReadTextResult = z.infer<typeof WorkspaceReadTextResultSchema>

export const WorkspaceListDocsRequestSchema = z.object({
  workspacePath: z.string().min(1),
  query: z.string().optional(),
  maxResults: z.number().int().min(1).max(100).optional()
})
export type WorkspaceListDocsRequest = z.infer<typeof WorkspaceListDocsRequestSchema>

export const WorkspaceListDocsResultSchema = z.object({
  paths: z.array(z.string())
})
export type WorkspaceListDocsResult = z.infer<typeof WorkspaceListDocsResultSchema>

export const WorkspaceListRulesRequestSchema = z.object({
  workspacePath: z.string().min(1)
})
export type WorkspaceListRulesRequest = z.infer<typeof WorkspaceListRulesRequestSchema>

export const WorkspaceListRulesResultSchema = z.object({
  rules: z.array(
    z.object({
      path: z.string(),
      description: z.string().optional(),
      alwaysApply: z.boolean()
    })
  )
})
export type WorkspaceListRulesResult = z.infer<typeof WorkspaceListRulesResultSchema>

export const WorkspaceAgentContextRequestSchema = z.object({
  workspacePath: z.string().min(1)
})
export type WorkspaceAgentContextRequest = z.infer<typeof WorkspaceAgentContextRequestSchema>

export const WorkspaceAgentContextResultSchema = z.object({
  workspaceName: z.string().min(1),
  branch: z.string().nullable(),
  rules: z.object({
    agentsMd: z.boolean(),
    cursorrules: z.boolean(),
    vyotiqRulesCount: z.number().int().nonnegative()
  }),
  memoryNotes: z.number().int().nonnegative(),
  codeIndex: z.object({
    state: z.enum(['ready', 'building', 'degraded', 'off'])
  })
})
export type WorkspaceAgentContextResult = z.infer<typeof WorkspaceAgentContextResultSchema>

export const WorkspaceDiagnosticsRequestSchema = z.object({
  workspacePath: z.string().min(1),
  kind: z.enum(['typecheck', 'lint']).optional()
})
export type WorkspaceDiagnosticsRequest = z.infer<typeof WorkspaceDiagnosticsRequestSchema>

export const WorkspaceDiagnosticsResultSchema = z.object({
  ok: z.boolean(),
  content: z.string(),
  kind: z.enum(['typecheck', 'lint'])
})
export type WorkspaceDiagnosticsResult = z.infer<typeof WorkspaceDiagnosticsResultSchema>

export function contentFiles(content: MessageContent): AttachedFile[] {
  if (typeof content === 'string') return []
  return content.filter((p): p is AttachedFile => p.type === 'file')
}

/** Render an attachment the way the model should read it: named, then quoted. */
export function attachedFileToText(file: AttachedFile): string {
  return `<attachment name="${file.name}" type="${file.mime || 'text/plain'}">\n${file.text}\n</attachment>`
}

/**
 * Collapse text-extracted attachments into plain text parts.
 * Native file / audio parts are left intact for capability-aware assemble.
 */
export function flattenFileParts(content: MessageContent): MessageContent {
  if (typeof content === 'string') return content
  if (!content.some((p) => p.type === 'file')) return content
  const parts: ContentPart[] = content.map((part) =>
    part.type === 'file' ? { type: 'text' as const, text: attachedFileToText(part) } : part
  )
  return parts
}

/** Wire shapes providers may understand beyond text. */
export type ProviderContentPart =
  | Extract<ContentPart, { type: 'text' }>
  | Extract<ContentPart, { type: 'image_url' }>
  | Extract<ContentPart, { type: 'audio' }>
  | Extract<ContentPart, { type: 'file_native' }>

export type ProviderWireCaps = {
  image?: boolean
  audio?: boolean
  fileNative?: boolean
}

/**
 * Provider-facing view of a content array.
 * Text `file` parts are always inlined; audio/native kept only when caps allow.
 */
export function providerContentParts(
  content: ContentPart[],
  caps: ProviderWireCaps = { image: true }
): ProviderContentPart[] {
  const out: ProviderContentPart[] = []
  for (const part of content) {
    if (part.type === 'text') {
      out.push(part)
      continue
    }
    if (part.type === 'file') {
      out.push({ type: 'text', text: attachedFileToText(part) })
      continue
    }
    if (part.type === 'image_url') {
      if (caps.image !== false) out.push(part)
      else out.push({ type: 'text', text: '[image omitted: model does not support vision]' })
      continue
    }
    if (part.type === 'audio') {
      if (caps.audio) out.push(part)
      else out.push({ type: 'text', text: '[audio omitted: model or provider does not support audio input]' })
      continue
    }
    if (part.type === 'file_native') {
      if (caps.fileNative) out.push(part)
      else
        out.push({
          type: 'text',
          text: `[file omitted: native file "${part.name}" not supported on this provider — re-attach for text extraction]`
        })
    }
  }
  return out
}

export function contentToText(content: MessageContent): string {
  if (typeof content === 'string') return content
  const text = contentDisplayText(content)
  const files = contentFiles(content)
  const natives = contentNativeFiles(content)
  const audios = contentAudios(content)
  const imageCount = contentImages(content).length
  const markers: string[] = []
  for (const file of files) markers.push(attachedFileToText(file))
  for (const file of natives) markers.push(`[file:${file.name}]`)
  if (audios.length) markers.push(audios.length === 1 ? '[audio]' : `[${audios.length} audio]`)
  if (imageCount) markers.push(imageCount === 1 ? '[image]' : `[${imageCount} images]`)
  if (!markers.length) return text
  return [text, ...markers].filter(Boolean).join('\n').trim()
}

export function contentHasImage(content: MessageContent): boolean {
  if (typeof content === 'string') return false
  return content.some((p) => p.type === 'image_url')
}

export type ComposerSendExtras = {
  audio?: AttachedAudio[]
  nativeFiles?: AttachedNativeFile[]
}

export function buildUserContent(
  text: string,
  images?: string[],
  files?: AttachedFile[],
  extras?: { audio?: AttachedAudio[]; nativeFiles?: AttachedNativeFile[] }
): MessageContent {
  const trimmed = text.trim()
  const validImages = images?.filter((url) => url) ?? []
  const validFiles = files?.filter((file) => file.name && file.text) ?? []
  const validAudio = extras?.audio?.filter((a) => a.url) ?? []
  const validNative = extras?.nativeFiles?.filter((f) => f.name && f.data) ?? []
  if (!validImages.length && !validFiles.length && !validAudio.length && !validNative.length) {
    return trimmed
  }
  const parts: ContentPart[] = []
  if (trimmed) parts.push({ type: 'text', text: trimmed })
  for (const file of validFiles) {
    parts.push({ type: 'file', name: file.name, mime: file.mime, text: file.text })
  }
  for (const native of validNative) {
    parts.push({
      type: 'file_native',
      name: native.name,
      mime: native.mime,
      data: native.data
    })
  }
  for (const audio of validAudio) {
    parts.push({ type: 'audio', url: audio.url, ...(audio.mime ? { mime: audio.mime } : {}) })
  }
  for (const url of validImages) {
    parts.push({ type: 'image_url', url })
  }
  return parts
}
