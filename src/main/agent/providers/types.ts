import type { ChatMessage, ModelInfo, ProviderId } from '../../../shared/ipc'
import type { ProviderReasoningState, ThinkingConfig } from '../../../shared/reasoning'
import type { ServiceTier } from '../../../shared/ipc/schemas/providers'

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface TokenUsage {
  inputTokens?: number
  /** Whether the provider's inputTokens already includes cached input tokens. */
  inputTokensIncludesCache?: boolean
  outputTokens?: number
  totalTokens?: number
  /** Input tokens served from provider prompt cache (OpenAI, DeepSeek, Groq, Anthropic, Gemini). */
  cachedInputTokens?: number
  /** Input tokens written into the prompt cache this step (Anthropic cache_creation). */
  cacheCreationInputTokens?: number
  /** Reasoning / thinking tokens billed as output (provider-specific). */
  reasoningTokens?: number
  /** Provider-reported account charge in USD (e.g. OpenRouter `usage.cost`). */
  billedCost?: number
  /** Provider-reported cache cost effect (e.g. OpenRouter `cache_discount`; may be negative). */
  billedCostSaved?: number
}

/**
 * Why the provider stopped generating. `length` means the output token limit cut
 * the turn short, which is otherwise indistinguishable from a clean finish.
 */
export type StopReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'unknown'

export interface StreamChunk {
  type:
    | 'text'
    | 'thinking_delta'
    | 'thinking_done'
    | 'tool_call_delta'
    | 'tool_call'
    | 'done'
    | 'error'
  text?: string
  toolCall?: ToolCall
  toolCallDelta?: { index: number; id?: string; name?: string; arguments?: string }
  error?: string
  /** Structured failure code for `error` chunks (e.g. PROVIDER_HTTP vs PROVIDER_STREAM). */
  errorCode?: string
  /** HTTP status for `PROVIDER_HTTP` error chunks — drives status-aware stream retry. */
  httpStatus?: number
  usage?: TokenUsage
  /** Anthropic server-side compaction summary (not user-visible assistant text). */
  compaction?: string
  /** Provider reasoning replay state captured during the stream. */
  reasoningState?: ProviderReasoningState
  /** Set on `done` chunks so the loop can tell a truncated turn from a finished one. */
  stopReason?: StopReason
  /**
   * SSE JSON frames the provider parser could not decode (corrupted upstream
   * stream). Non-zero on `done` means the turn may be missing text — the loop
   * classifies it as incomplete instead of trusting a short answer.
   */
  droppedFrames?: number
}

export interface ListModelsRequest {
  apiKey?: string | null
  baseUrl?: string
  signal?: AbortSignal
}

export interface ResponseFormat {
  type: 'json_schema'
  name: string
  schema: Record<string, unknown>
  strict?: boolean
}

export interface ProviderChatRequest {
  model: string
  messages: ChatMessage[]
  tools: ToolDefinition[]
  system?: string
  /**
   * Stable/volatile system split for prompt caching.
   * - Anthropic: stable gets `cache_control`; volatile is unmarked in system blocks.
   * - OpenAI-compatible chat / DeepSeek: stable is the leading system instruction;
   *   volatile is appended after history.
   * - OpenAI Responses / Gemini Interactions: stable seeds stateful transport;
   *   volatile is resent on every continuation step.
   * When set, preferred over a single combined `system` string.
   */
  systemStable?: string
  systemVolatile?: string
  signal: AbortSignal
  apiKey?: string | null
  baseUrl?: string
  /** Optional max output tokens from model metadata. */
  maxOutputTokens?: number
  /** Sampling temperature. Unset leaves the provider default. */
  temperature?: number
  /** Stop sequences (provider-capped). */
  stop?: string[]
  responseFormat?: ResponseFormat
  toolChoice?: 'auto' | 'none' | 'required'
  parallelToolCalls?: boolean
  /** OpenAI prompt-cache routing key (stable per run). */
  promptCacheKey?: string
  /** Extended thinking configuration from user settings. */
  thinking?: ThinkingConfig
  /** Prior-step reasoning replay state for multi-turn tool loops. */
  reasoningState?: ProviderReasoningState
  /** Resolved model metadata for routing (Responses vs Completions, etc.). */
  modelInfo?: ModelInfo
  /** API service tier (`flex` / `priority`). UI labels `priority` as Fast (OpenAI Fast mode). */
  serviceTier?: ServiceTier
}

export interface LlmProvider {
  id: ProviderId
  streamChat(req: ProviderChatRequest): AsyncGenerator<StreamChunk>
  listModels(req: ListModelsRequest): Promise<ModelInfo[]>
}
