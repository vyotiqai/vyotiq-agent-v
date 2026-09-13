import { describe, expect, it } from 'vitest'
import type { LlmProvider } from '@main/agent/providers/types'

const mockProvider: LlmProvider = {
  id: 'ollama',
  listModels: async () => [],
  streamChat: async function* () {
    yield { type: 'done' }
  }
}

describe('assembleContext overflow trim', () => {
  it('flags hard overflow without LLM compaction', async () => {
    const { assembleContext } = await import('@main/agent/context/assemble')

    const foldedMarker = 'FOLDED_PREFIX_UNIQUE_MARKER_ZZZ'
    const keptMarker = 'KEPT_RECENT_UNIQUE_MARKER_YYY'
    const history: import('@shared/ipc').ChatMessage[] = []
    for (let i = 0; i < 40; i++) {
      history.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `${foldedMarker} turn ${i} ${'x'.repeat(800)}`
      })
    }
    for (let i = 0; i < 4; i++) {
      history.push({
        role: 'user',
        content: `${keptMarker} user ${i}`
      })
      history.push({
        role: 'assistant',
        content: `${keptMarker} assistant ${i}`
      })
    }

    const result = await assembleContext({
      harness: 'harness',
      messages: history,
      workspacePath: null,
      goal: 'hi',
      model: {
        id: 'test',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false,
        contextWindow: 8_000
      },
      toolsJsonEstimate: 20_000,
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal,
      keepRecentTurns: 4
    })

    expect(result.compaction).toBeNull()
    expect(result.overflow).toBe(true)
    const wireText = result.messages.map((m) => String(m.content ?? '')).join('\n')
    expect(wireText).toContain(keptMarker)
    expect(wireText).toContain(foldedMarker)
  })
})
