import { randomUUID } from 'crypto'
import type { CreateMessageRequest, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js'
import type { AgentQuestionAnswer, AgentQuestionRequest, ChatMessage, Settings } from '../../../shared/ipc'
import { AGENT_QUESTION_MAX_PROMPT_CHARS, AGENT_QUESTION_MAX_TITLE_CHARS } from '../../../shared/utils/agentQuestionForm'
import { logger } from '../../../shared/logger'
import type { TokenUsage } from '../providers/types'

/**
 * MCP sampling: a server asks the client's model to answer something (a
 * summary, a classification) on its behalf. Each request is put to the
 * person first, on the task's question card, with the server's own system
 * prompt and its last message shown; only a yes spends a model call. The
 * answer uses the utility model when one is set, else the task's model, with
 * no tools, and is counted in Usage as a side call.
 */

export const SAMPLING_MAX_OUTPUT_TOKENS = 4_096
const SAMPLING_TIMEOUT_MS = 120_000
const ALLOW = 'Allow once'
const DENY = 'Deny'

export type SamplingAsker = {
  runId: string
  toolCallId: string
  signal: AbortSignal
  ask: (request: AgentQuestionRequest, signal: AbortSignal) => Promise<AgentQuestionAnswer[]>
  onWaiting: (waiting: boolean) => void
}

/** What the model call needs, resolved for the task's workspace; replaced in tests. */
export type SamplingModel = {
  complete: (req: {
    system?: string
    messages: ChatMessage[]
    maxOutputTokens: number
    signal: AbortSignal
  }) => Promise<{ text: string; model: string; usage?: TokenUsage; stopReason: 'endTurn' | 'maxTokens' }>
}

type SamplingMessage = CreateMessageRequest['params']['messages'][number]

/** The text of one sampling message; non-text blocks are named, not sent. */
export function samplingMessageText(message: SamplingMessage): string {
  const blocks = Array.isArray(message.content) ? message.content : [message.content]
  return blocks
    .map((block) => {
      const b = block as { type: string; text?: string }
      return b.type === 'text' ? (b.text ?? '') : `[${b.type} omitted]`
    })
    .join('\n')
    .trim()
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export async function answerSampling(
  serverName: string,
  asker: SamplingAsker,
  params: CreateMessageRequest['params'],
  model: SamplingModel | null,
  decline: (reason: string) => never | CreateMessageResult
): Promise<CreateMessageResult> {
  if (!model) return decline('no model is set up for this workspace')
  const messages: ChatMessage[] = params.messages
    .map((m) => ({ role: m.role, content: samplingMessageText(m) }) as ChatMessage)
    .filter((m) => typeof m.content === 'string' && m.content.length > 0)
  if (messages.length === 0) return decline('the request has no text to answer')
  const last = messages[messages.length - 1]!
  const system = params.systemPrompt?.trim() || undefined
  const maxOutputTokens = Math.max(1, Math.min(params.maxTokens || SAMPLING_MAX_OUTPUT_TOKENS, SAMPLING_MAX_OUTPUT_TOKENS))
  const preview = [
    system ? `Its instructions: ${clip(system, 400)}` : '',
    `It asks: ${clip(String(last.content), 900)}`,
    `Up to ${maxOutputTokens.toLocaleString()} tokens of answer, no tools.`
  ]
    .filter(Boolean)
    .join('\n\n')
  const title = `${serverName} asks your model to answer something`
  asker.onWaiting(true)
  let allowed = false
  try {
    const answers = await asker.ask(
      {
        requestId: randomUUID(),
        runId: asker.runId,
        toolCallId: asker.toolCallId,
        title: clip(title, AGENT_QUESTION_MAX_TITLE_CHARS),
        questions: [{ id: 'sample', prompt: clip(preview, AGENT_QUESTION_MAX_PROMPT_CHARS), type: 'single', options: [ALLOW, DENY] }]
      },
      asker.signal
    )
    allowed = answers.find((a) => a.questionId === 'sample')?.values[0] === ALLOW
  } catch {
    allowed = false
  } finally {
    asker.onWaiting(false)
  }
  if (!allowed) return decline('the person did not allow it')
  const signal = AbortSignal.any([asker.signal, AbortSignal.timeout(SAMPLING_TIMEOUT_MS)])
  const done = await model.complete({ system, messages, maxOutputTokens, signal })
  logger.info('MCP sampling answered', { scope: 'mcp', serverId: serverName, model: done.model })
  return { role: 'assistant', content: { type: 'text', text: done.text }, model: done.model, stopReason: done.stopReason }
}

/** A model for sampling, from the workspace's chat settings (the utility model first). */
export function samplingModelFor(deps: {
  settings: Settings
  getSecret: (provider: string) => string | null
  resolveBaseUrl: (settings: Settings, apiKey: string | null) => string | undefined
  needsKey: (settings: Settings, baseUrl: string | undefined) => boolean
  stream: (settings: Settings, req: Parameters<SamplingModel['complete']>[0] & { apiKey: string | null; baseUrl?: string }) => AsyncIterable<{
    type: string
    text?: string
    usage?: TokenUsage
    stopReason?: string
    error?: string
  }>
  recordUsage?: (settings: Settings, baseUrl: string | undefined, usage: TokenUsage) => void
}): SamplingModel | null {
  const { settings } = deps
  const apiKey = deps.getSecret(settings.provider)
  const baseUrl = deps.resolveBaseUrl(settings, apiKey)
  if (deps.needsKey(settings, baseUrl) && !apiKey?.trim()) return null
  return {
    complete: async (req) => {
      let text = ''
      let usage: TokenUsage | undefined
      let stopReason: 'endTurn' | 'maxTokens' = 'endTurn'
      for await (const chunk of deps.stream(settings, { ...req, apiKey, baseUrl })) {
        if (chunk.type === 'text' && chunk.text) text += chunk.text
        if (chunk.type === 'error') throw new Error(chunk.error || 'The model returned an error')
        if (chunk.type === 'done') {
          usage = chunk.usage
          if (chunk.stopReason === 'length' || chunk.stopReason === 'max_tokens') stopReason = 'maxTokens'
        }
      }
      if (usage) deps.recordUsage?.(settings, baseUrl, usage)
      return { text: text.trim(), model: settings.model, usage, stopReason }
    }
  }
}
