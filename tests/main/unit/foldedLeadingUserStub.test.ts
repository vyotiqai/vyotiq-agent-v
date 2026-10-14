import { describe, expect, it } from 'vitest'
import {
  assembleContext,
  clearSystemPromptCache,
  FOLDED_HISTORY_USER_STUB,
  OMITTED_HISTORY_USER_STUB,
  withLeadingUserTurn
} from '@main/agent/context/assemble'
import {
  countUserTurns,
  ensureSubstantialFold,
  forceCompactKeepTail,
  manualKeepRecentTurns,
  preserveRecentMessagesAsync
} from '@main/agent/context/compact'
import { applyFoldedMessagesWatermark } from '@main/agent/context/foldWatermark'
import { buildAnthropicBody } from '@main/agent/providers/anthropic'
import { buildGeminiBody } from '@main/agent/providers/gemini'
import { toOpenAiMessages } from '@main/agent/providers/openai'
import type { ProviderChatRequest } from '@main/agent/providers/types'
import type { ChatMessage, ModelInfo } from '@shared/ipc'

const model: ModelInfo = {
  id: 'test',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsTools: true,
  supportsVision: false,
  contextWindow: 200_000
}

/** One user prompt, then assistant(tool_call) / tool pairs — the common agent-run shape. */
function agenticRun(pairs: number): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'user', content: 'Fix the auth bug' }]
  for (let i = 0; i < pairs; i++) {
    out.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `c${i}`, name: 'read', arguments: JSON.stringify({ path: `src/f${i}.ts` }) }]
    })
    out.push({ role: 'tool', toolCallId: `c${i}`, toolName: 'read', content: `body ${i}` })
  }
  return out
}

/** The working set the loop holds after an auto-fold (compactRun.planCompact keep math). */
async function postFoldWorkingSet(): Promise<ChatMessage[]> {
  const working = agenticRun(50)
  const keepRecent = manualKeepRecentTurns(countUserTurns(working), 12)
  let kept = await preserveRecentMessagesAsync(working, keepRecent)
  if (kept.length >= working.length) kept = forceCompactKeepTail(working)
  kept = ensureSubstantialFold(working, kept)
  return applyFoldedMessagesWatermark(working, working.length - kept.length).messages
}

async function assembleFolded(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const result = await assembleContext({
    harness: '## Role\nAgent',
    messages,
    workspacePath: null,
    goal: 'Fix the auth bug',
    model,
    toolsJsonEstimate: 50,
    providerId: 'ollama',
    priorCompaction: {
      summary: '## Session Intent\nFix the auth bug.',
      createdAt: '2026-01-01T00:00:00.000Z',
      tokenEstimate: 10
    }
  })
  return result.messages
}

function request(messages: ChatMessage[]): ProviderChatRequest {
  return {
    model: 'm',
    messages,
    tools: [{ name: 'read', description: 'r', parameters: { type: 'object', properties: {} } }],
    systemStable: 'STABLE',
    systemVolatile: 'VOLATILE',
    signal: new AbortController().signal
  } as ProviderChatRequest
}

describe('a folded working set opens on a user turn on the wire', () => {
  it('prepends the stub when the fold left an assistant tool-call turn first', async () => {
    const working = await postFoldWorkingSet()
    expect(working[0]!.role).toBe('assistant')
    expect(working.some((m) => m.role === 'user')).toBe(false)

    const wire = await assembleFolded(working)
    expect(wire[0]).toEqual({ role: 'user', content: FOLDED_HISTORY_USER_STUB })
    expect(wire.slice(1)).toEqual(working)
    // Wire-only: the caller's working set is not modified.
    expect(working[0]!.role).toBe('assistant')
  })

  it('is byte-stable across steps: same text at the same position', async () => {
    const working = await postFoldWorkingSet()
    clearSystemPromptCache()
    const stepA = await assembleFolded(working)
    const grown = [
      ...working,
      { role: 'assistant' as const, content: 'next', toolCalls: [{ id: 'n', name: 'read', arguments: '{}' }] },
      { role: 'tool' as const, toolCallId: 'n', toolName: 'read', content: 'x' }
    ]
    const stepB = await assembleFolded(grown)
    expect(JSON.stringify(stepB.slice(0, stepA.length))).toBe(JSON.stringify(stepA))
  })

  it('gives Gemini, Anthropic and OpenAI-compat a user first turn', async () => {
    const wire = await assembleFolded(await postFoldWorkingSet())

    const gemini = buildGeminiBody(request(wire)).contents as Array<{ role: string }>
    expect(gemini[0]!.role).toBe('user')
    expect(gemini[1]!.role).toBe('model')

    const anthropic = buildAnthropicBody(request(wire)).messages as Array<{ role: string }>
    expect(anthropic[0]!.role).toBe('user')
    expect(anthropic[1]!.role).toBe('assistant')

    const openai = toOpenAiMessages(wire, undefined, {
      systemStable: 'STABLE',
      systemVolatile: 'VOLATILE'
    }) as Array<{ role: string }>
    const firstNonSystem = openai.find((m) => m.role !== 'system' && m.role !== 'developer')
    expect(firstNonSystem?.role).toBe('user')
  })

  it('leaves a working set that already opens on the user alone', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]
    expect(withLeadingUserTurn(messages, true)).toBe(messages)
  })

  it('says nothing about <prior_session> when there is no fold summary', () => {
    const out = withLeadingUserTurn([{ role: 'assistant', content: 'a' }], false)
    expect(out[0]).toEqual({ role: 'user', content: OMITTED_HISTORY_USER_STUB })
  })
})
