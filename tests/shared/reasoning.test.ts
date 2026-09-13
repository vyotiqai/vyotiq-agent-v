import { describe, expect, it } from 'vitest'
import {
  anthropicUsesAdaptiveThinking,
  anthropicUsesManualThinking,
  catalogThinkingAllowed,
  isDeepSeekNativeThinkingModel,
  isScriptCorruptedReasoning,
  modelSupportsThinking,
  quarantineReasoningState,
  thinkingApiFor,
  ProviderReasoningStateSchema,
  normalizeEffortForOpenAiResponses,
  normalizeEffortForGeminiInteractions,
  normalizeEffortForMistral,
  normalizeEffortForOllamaThink,
  findOllamaCatalogModel,
  ollamaModelFamily,
  ollamaThinkingHeuristicFields,
  thinkingFromReasoningState,
  trailingToolMessages,
  statefulContinuationMessages
} from '@shared/reasoning'

describe('reasoning', () => {
  it('detects thinking-capable models', () => {
    expect(modelSupportsThinking('gpt-5.6', 'openai')).toBe(true)
    expect(modelSupportsThinking('openai/gpt-5.6', 'openrouter')).toBe(true)
    expect(modelSupportsThinking('claude-sonnet-5', 'anthropic')).toBe(true)
    expect(modelSupportsThinking('gemini-3.5-flash', 'gemini')).toBe(true)
    expect(modelSupportsThinking('deepseek-v4-pro', 'deepseek')).toBe(true)
    expect(modelSupportsThinking('gpt-4o', 'openai')).toBe(false)
  })

  it('covers cross-provider heuristic matrix gaps', () => {
    expect(modelSupportsThinking('deepseek-v4-flash', 'custom')).toBe(true)
    expect(modelSupportsThinking('qwen3:8b', 'custom')).toBe(true)
    expect(modelSupportsThinking('llama3.2', 'custom')).toBe(false)
    expect(modelSupportsThinking('o1', 'openai')).toBe(true)
    expect(modelSupportsThinking('o1-mini', 'openai')).toBe(true)
    expect(modelSupportsThinking('o1-preview', 'openai')).toBe(true)
    expect(modelSupportsThinking('claude-3-7-sonnet-20250219', 'anthropic')).toBe(true)
    expect(modelSupportsThinking('deepseek-r1', 'deepseek')).toBe(true)
    expect(modelSupportsThinking('deepseek-v3.2', 'deepseek')).toBe(true)
    expect(modelSupportsThinking('openai/gpt-oss-120b', 'groq')).toBe(true)
    expect(modelSupportsThinking('qwen/qwen3-32b', 'groq')).toBe(true)
    expect(modelSupportsThinking('deepseek/deepseek-r1', 'openrouter')).toBe(true)
    expect(modelSupportsThinking('deepseek-v3.2:latest', 'ollama')).toBe(true)
    expect(modelSupportsThinking('kimi-k2', 'ollama')).toBe(true)
  })

  it('detects DeepSeek-native thinking SKUs for custom hosts', () => {
    expect(isDeepSeekNativeThinkingModel('deepseek-ai/DeepSeek-V4-Pro')).toBe(true)
    expect(isDeepSeekNativeThinkingModel('deepseek-v4-flash')).toBe(true)
    expect(isDeepSeekNativeThinkingModel('deepseek-r1')).toBe(true)
    expect(isDeepSeekNativeThinkingModel('deepseek-v3.2')).toBe(true)
    expect(isDeepSeekNativeThinkingModel('gpt-oss-120b')).toBe(false)
    expect(isDeepSeekNativeThinkingModel('qwen3:8b')).toBe(false)
  })

  it('softens catalog supportsThinking false for known reasoner families', () => {
    expect(
      catalogThinkingAllowed('deepseek-ai/DeepSeek-V4-Flash-0731', false)
    ).toBe(true)
    expect(catalogThinkingAllowed('deepseek-v4-flash', false)).toBe(true)
    expect(catalogThinkingAllowed('gpt-5.6', false)).toBe(true)
    expect(catalogThinkingAllowed('llama3.2', false)).toBe(false)
    expect(catalogThinkingAllowed('some-vendor/plain-chat', false)).toBe(false)
    expect(catalogThinkingAllowed('llama3.2', true)).toBe(true)
    expect(catalogThinkingAllowed('llama3.2', undefined)).toBe(true)
  })

  it('maps thinkingApi when catalog affirms despite heuristic miss', () => {
    // Catalog-only reasoner id — heuristic may miss, but affirmed skips re-gate.
    expect(thinkingApiFor('some-vendor/plain-model-v2', 'openrouter', { affirmed: true })).toBe(
      'chat_completions'
    )
    expect(thinkingApiFor('some-vendor/plain-model-v2', 'openrouter')).toBeUndefined()
  })

  it('detects Ollama thinking models including cloud IDs', () => {
    expect(ollamaModelFamily('gpt-oss:120b-cloud')).toBe('gpt-oss')
    expect(ollamaModelFamily('deepseek-v3.1:671b-cloud')).toBe('deepseek-v3.1')

    expect(modelSupportsThinking('gpt-oss:120b-cloud', 'ollama')).toBe(true)
    expect(modelSupportsThinking('gpt-oss:20b-cloud', 'ollama')).toBe(true)
    expect(modelSupportsThinking('gpt-oss:120b', 'ollama')).toBe(true)
    expect(modelSupportsThinking('deepseek-v3.1:671b-cloud', 'ollama')).toBe(true)
    expect(modelSupportsThinking('deepseek-r1:latest', 'ollama')).toBe(true)
    expect(modelSupportsThinking('qwen3:8b', 'ollama')).toBe(true)
    expect(modelSupportsThinking('qwen3-coder:480b-cloud', 'ollama')).toBe(true)
    expect(modelSupportsThinking('qwen2.5', 'ollama')).toBe(false)
    expect(modelSupportsThinking('llama3.2', 'ollama')).toBe(false)
    expect(modelSupportsThinking('glm-5.2', 'ollama')).toBe(true)
    expect(modelSupportsThinking('glm-5.1:cloud', 'ollama')).toBe(true)
    expect(modelSupportsThinking('gemma4:31b-cloud', 'ollama')).toBe(true)
    expect(modelSupportsThinking('gemma4:e4b', 'ollama')).toBe(true)
    expect(modelSupportsThinking('minimax-m2.5:cloud', 'ollama')).toBe(true)
    expect(modelSupportsThinking('gemma3:12b', 'ollama')).toBe(false)
  })

  it('detects Mistral reasoning models via reasoning_effort families', () => {
    expect(modelSupportsThinking('mistral-small-latest', 'mistral')).toBe(true)
    expect(modelSupportsThinking('mistral-medium-3-5', 'mistral')).toBe(true)
    expect(modelSupportsThinking('magistral-medium-latest', 'mistral')).toBe(true)
    expect(modelSupportsThinking('mistral-large-latest', 'mistral')).toBe(false)
    expect(thinkingApiFor('mistral-small-latest', 'mistral')).toBe('chat_completions')
  })

  it('aliases Cloud vs local pulled Ollama ids', () => {
    expect(findOllamaCatalogModel([{ id: 'gpt-oss:120b' }], 'gpt-oss:120b-cloud')?.id).toBe(
      'gpt-oss:120b'
    )
    expect(findOllamaCatalogModel([{ id: 'glm-5.2:cloud' }], 'glm-5.2')?.id).toBe('glm-5.2:cloud')
  })

  it('uses Ollama protocol effort ladder for offline seed heuristic', () => {
    const gptOss = ollamaThinkingHeuristicFields('gpt-oss:120b-cloud')
    expect(gptOss.thinkingMode).toBe('effort')
    expect(gptOss.thinkingCanDisable).toBe(false)
    expect(gptOss.supportedThinkingEfforts).toEqual(['low', 'medium', 'high'])

    const r1 = ollamaThinkingHeuristicFields('deepseek-r1')
    expect(r1.thinkingMode).toBe('effort')
    expect(r1.thinkingCanDisable).toBe(true)
    expect(r1.supportedThinkingEfforts).toEqual(['low', 'medium', 'high', 'max'])

    expect(normalizeEffortForOllamaThink('high', ['low', 'medium', 'high', 'max'])).toBe('high')
    expect(normalizeEffortForOllamaThink('minimal', ['low', 'medium', 'high', 'max'])).toBe('low')
    expect(normalizeEffortForOllamaThink('xhigh', ['low', 'medium', 'high', 'max'])).toBe('max')
  })

  it('maps thinking API per provider', () => {
    expect(thinkingApiFor('gpt-5.6', 'openai')).toBe('responses')
    expect(thinkingApiFor('gemini-3.5-flash', 'gemini')).toBe('interactions')
    expect(thinkingApiFor('claude-sonnet-5', 'anthropic')).toBe('messages')
    expect(thinkingApiFor('deepseek-v4-pro', 'deepseek')).toBe('chat_completions')
  })

  it('classifies Anthropic thinking modes', () => {
    expect(anthropicUsesAdaptiveThinking('claude-sonnet-5')).toBe(true)
    expect(anthropicUsesAdaptiveThinking('claude-opus-5')).toBe(true)
    expect(anthropicUsesAdaptiveThinking('claude-sonnet-4-6')).toBe(true)
    expect(anthropicUsesAdaptiveThinking('claude-opus-4.7')).toBe(true)
    expect(anthropicUsesManualThinking('claude-sonnet-4-6')).toBe(false)
    expect(anthropicUsesManualThinking('claude-sonnet-4-5')).toBe(true)
    expect(anthropicUsesManualThinking('claude-sonnet-5')).toBe(false)
    expect(anthropicUsesManualThinking('claude-opus-5')).toBe(false)
  })

  it('round-trips provider reasoning state', () => {
    const state = {
      kind: 'openai_compat' as const,
      reasoningContent: 'step 1',
      reasoningDetails: [{ type: 'reasoning.text', text: 'step 1' }]
    }
    expect(ProviderReasoningStateSchema.parse(state)).toEqual(state)
  })

  it('round-trips openai_compat ThinkChunks with signatures', () => {
    const state = {
      kind: 'openai_compat' as const,
      reasoningContent: 'ab',
      reasoningFormat: 'think_chunks' as const,
      thinkChunks: [
        { text: 'a', signature: 'sig-a', closed: true },
        { text: 'b', signature: 'sig-b', closed: true }
      ]
    }
    expect(ProviderReasoningStateSchema.parse(state)).toEqual(state)
  })

  it('round-trips openai_compat ThinkChunk inner parts', () => {
    const state = {
      kind: 'openai_compat' as const,
      reasoningContent: 'See ',
      reasoningFormat: 'think_chunks' as const,
      thinkChunks: [
        {
          text: 'See ',
          closed: true,
          thinking: [
            { type: 'text', text: 'See ' },
            {
              type: 'tool_reference',
              tool: 'web_search',
              title: 'Docs',
              url: 'https://example.com'
            },
            { type: 'reference', reference_ids: [1] }
          ]
        }
      ]
    }
    expect(ProviderReasoningStateSchema.parse(state)).toEqual(state)
  })

  it('normalizes effort for OpenAI Responses', () => {
    expect(normalizeEffortForOpenAiResponses('max')).toBe('xhigh')
    expect(normalizeEffortForOpenAiResponses('high')).toBe('high')
    expect(normalizeEffortForOpenAiResponses(undefined, false)).toBe('none')
  })

  it('normalizes effort for Gemini Interactions', () => {
    expect(normalizeEffortForGeminiInteractions('xhigh')).toBe('high')
    expect(normalizeEffortForGeminiInteractions('max')).toBe('high')
    expect(normalizeEffortForGeminiInteractions(undefined)).toBe('medium')
  })

  it('normalizes effort for Mistral reasoning_effort', () => {
    expect(normalizeEffortForMistral('high')).toBe('high')
    expect(normalizeEffortForMistral('max')).toBe('xhigh')
    expect(normalizeEffortForMistral('minimal')).toBe('minimal')
    expect(normalizeEffortForMistral(undefined)).toBe('medium')
  })

  it('collects trailing tool messages only', () => {
    const messages = [
      { role: 'user' as const, content: 'go' },
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      },
      { role: 'tool' as const, toolCallId: 'c1', toolName: 'read', content: 'ok' },
      { role: 'tool' as const, toolCallId: 'c2', toolName: 'edit', content: 'done' }
    ]
    expect(trailingToolMessages(messages)).toHaveLength(2)
    expect(trailingToolMessages(messages).every((m) => m.role === 'tool')).toBe(true)
  })

  it('keeps tool-only suffixes after the last reasoning assistant', () => {
    const messages = [
      { role: 'user' as const, content: 'go' },
      {
        role: 'assistant' as const,
        content: '',
        reasoningState: {
          kind: 'openai_responses' as const,
          responseId: 'resp_1',
          outputItems: []
        },
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      },
      { role: 'tool' as const, toolCallId: 'c1', toolName: 'read', content: 'ok' }
    ]
    expect(statefulContinuationMessages(messages)).toEqual([messages[2]])
  })

  it('includes a newer user turn after the last reasoning assistant', () => {
    const messages = [
      { role: 'user' as const, content: 'go' },
      {
        role: 'assistant' as const,
        content: 'done',
        reasoningState: {
          kind: 'openai_responses' as const,
          responseId: 'resp_1',
          outputItems: []
        }
      },
      { role: 'tool' as const, toolCallId: 'c1', toolName: 'read', content: 'ok' },
      { role: 'user' as const, content: 'now the next thing' }
    ]
    expect(trailingToolMessages(messages)).toEqual([])
    expect(statefulContinuationMessages(messages)).toEqual([messages[2], messages[3]])
  })
})

describe('thinkingFromReasoningState', () => {
  it('derives openai_compat display text from reasoningContent', () => {
    expect(
      thinkingFromReasoningState({
        kind: 'openai_compat',
        reasoningContent: 'step one, then step two',
        reasoningFormat: 'reasoning_content'
      })
    ).toBe('step one, then step two')
  })

  it('falls back to thinkChunks text when reasoningContent is absent', () => {
    expect(
      thinkingFromReasoningState({
        kind: 'openai_compat',
        reasoningFormat: 'think_chunks',
        thinkChunks: [
          { text: 'first thought, ', closed: true },
          { text: 'second thought', closed: true }
        ]
      })
    ).toBe('first thought, second thought')
  })

  it('derives anthropic display text from thinking blocks and skips redacted ones', () => {
    expect(
      thinkingFromReasoningState({
        kind: 'anthropic',
        blocks: [
          { type: 'thinking', thinking: 'block one' },
          { type: 'redacted_thinking', data: 'enc' },
          { type: 'thinking', thinking: 'block two' }
        ]
      })
    ).toBe('block one\n\nblock two')
  })

  it('returns undefined for opaque provider payloads', () => {
    expect(
      thinkingFromReasoningState({
        kind: 'openai_responses',
        responseId: 'resp_1',
        outputItems: []
      })
    ).toBeUndefined()
    expect(
      thinkingFromReasoningState({ kind: 'gemini_interactions', interactionId: 'int_1' })
    ).toBeUndefined()
  })

  it('returns undefined for empty or absent state', () => {
    expect(thinkingFromReasoningState(undefined)).toBeUndefined()
    expect(thinkingFromReasoningState({ kind: 'openai_compat' })).toBeUndefined()
    expect(
      thinkingFromReasoningState({
        kind: 'openai_compat',
        reasoningContent: '   ',
        thinkChunks: [{ text: '  ' }]
      })
    ).toBeUndefined()
  })
})

describe('isScriptCorruptedReasoning', () => {
  it('flags the measured glitch shape: CJK sutured onto ASCII path chars in a Latin stream', () => {
    // Real corruption from run 6265fa90 (2026-08-31), path chars glued to CJK.
    expect(
      isScriptCorruptedReasoning(
        'root: C:\\Users\\继续生存 30254-…] and update the garbled line "root: C:\\Users\\继续生存 line" into something clear. Also re-check volatile workspace state before acting.'
      )
    ).toBe(true)
  })

  it('flags kana and hangul sutures the same way', () => {
    expect(isScriptCorruptedReasoning('read the file C:\\data\\テスト and the C:\\data\\テスト2 path twice more here')).toBe(
      true
    )
    expect(
      isScriptCorruptedReasoning('the C:\\디렉터리 path, C:\\디렉터리2 path and C:\\디렉터리3 path')
    ).toBe(true)
  })

  it('never flags legitimate CJK-dominant reasoning', () => {
    expect(
      isScriptCorruptedReasoning(
        '用户要求分析代码库。我需要先读取 package.json，然后检查 landing 目录。'
      )
    ).toBe(false)
  })

  it('never flags CJK prose with spaced English words', () => {
    expect(
      isScriptCorruptedReasoning(
        '先运行 typecheck。The command is pnpm exec tsc。然后运行测试套件 vitest run 确认结果。'
      )
    ).toBe(false)
  })

  it('never flags pure-Latin reasoning', () => {
    expect(isScriptCorruptedReasoning('Read src/main/agent/loop.ts, then run the test suite.')).toBe(
      false
    )
  })

  it('returns false for empty or absent input', () => {
    expect(isScriptCorruptedReasoning(undefined)).toBe(false)
    expect(isScriptCorruptedReasoning(null)).toBe(false)
    expect(isScriptCorruptedReasoning('')).toBe(false)
  })

  it('requires multiple distinct suture points — one burst is not enough', () => {
    expect(isScriptCorruptedReasoning('a single glitch テスト point only')).toBe(false)
  })
})

describe('quarantineReasoningState', () => {
  it('replaces a corrupted openai_compat payload with a clean stub', () => {
    const state = {
      kind: 'openai_compat' as const,
      reasoningContent:
        'root: C:\\Users\\继续生存 30254-…] and update the garbled line "root: C:\\Users\\继续生存 line" into something clear.',
      reasoningFormat: 'reasoning_content' as const
    }
    const out = quarantineReasoningState(state)
    expect(out).toEqual({ kind: 'openai_compat' })
  })

  it('quarantines when corruption is inside a thinkChunk', () => {
    const state = {
      kind: 'openai_compat' as const,
      reasoningFormat: 'think_chunks' as const,
      thinkChunks: [
        { text: 'clean thought', closed: true },
        { text: 'path C:\\x\\テスト and C:\\x\\テスト2 and C:\\x\\テスト3', closed: true }
      ]
    }
    expect(quarantineReasoningState(state)).toEqual({ kind: 'openai_compat' })
  })

  it('passes clean openai_compat payloads through untouched', () => {
    const state = {
      kind: 'openai_compat' as const,
      reasoningContent: 'ordinary English reasoning about the task',
      reasoningFormat: 'reasoning_content' as const
    }
    expect(quarantineReasoningState(state)).toBe(state)
  })

  it('passes opaque and anthropic payloads through untouched', () => {
    const responses = {
      kind: 'openai_responses' as const,
      responseId: 'resp_1',
      outputItems: []
    }
    expect(quarantineReasoningState(responses)).toBe(responses)
    const anthropic = {
      kind: 'anthropic' as const,
      blocks: [{ type: 'thinking' as const, thinking: 'claude block' }]
    }
    expect(quarantineReasoningState(anthropic)).toBe(anthropic)
  })

  it('returns undefined for absent state', () => {
    expect(quarantineReasoningState(undefined)).toBeUndefined()
  })
})
