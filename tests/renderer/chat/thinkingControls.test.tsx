/**
 * The effort ladder the task options offer: which models show it and which
 * steps it has. The composer's model picker renders these helpers.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildModes,
  modeIndex,
  modelShowsThinkingControls,
  resolveThinkingUiMeta
} from '@renderer/features/chat/components/composer/ThinkingControls'
import { seedModelsFor } from '@shared/providers'
import type { ModelInfo } from '@shared/ipc/schemas/providers'
import type { ProviderId } from '@shared/ipc'
import { loadOpenCodeGoCatalog } from '@shared/domain/opencodeGoCatalog'

/** The ladder's short labels, in the order the Effort control lists them. */
function ladder(provider: ProviderId, model: string, meta?: ModelInfo | null): string[] {
  const ui = resolveThinkingUiMeta(provider, model, meta)
  return buildModes(ui.supportedThinkingEfforts, ui.thinkingCanDisable, ui.thinkingMode, ui.thinkingDefaultEffort).map(
    (m) => m.short
  )
}

function meta(id: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsVision: false,
    ...extra
  }
}

describe('effort ladder', () => {
  it('is hidden for non-thinking models and shown for thinking ones', () => {
    expect(modelShowsThinkingControls('openai', 'gpt-4o')).toBe(false)
    expect(modelShowsThinkingControls('openai', 'gpt-5.6')).toBe(true)
  })

  it('offers Off then every effort when the catalog says nothing', () => {
    expect(ladder('openai', 'gpt-5.6')).toEqual(['Off', 'Min', 'Low', 'Med', 'High', 'XHigh', 'Max'])
  })

  it('finds the current step, falling back to the first effort when the saved one is gone', () => {
    const modes = buildModes(['low', 'high'], true, undefined)
    expect(modeIndex(modes, false, 'medium')).toBe(0)
    expect(modes[modeIndex(modes, true, 'high')]?.short).toBe('High')
    expect(modes[modeIndex(modes, true, 'medium')]?.short).toBe('Low')
  })

  it('shows when the catalog marks supportsThinking even if the id heuristic would miss', () => {
    const m = meta('some-vendor/custom-reasoner-v2', {
      supportsThinking: true,
      supportedThinkingEfforts: ['low', 'medium', 'high'],
      thinkingCanDisable: true
    })
    expect(modelShowsThinkingControls('openrouter', m.id, m)).toBe(true)
    expect(ladder('openrouter', m.id, m)).toEqual(['Off', 'Low', 'Med', 'High'])
  })

  it('shows for a known DeepSeek reasoner even when the catalog says it does not think', () => {
    const id = 'deepseek-ai/DeepSeek-V4-Flash-0731'
    expect(modelShowsThinkingControls('custom', id, meta(id, { supportsThinking: false }))).toBe(true)
  })

  it('hides for unknown ids the catalog says do not think', () => {
    const id = 'some-vendor/plain-chat-v1'
    expect(modelShowsThinkingControls('custom', id, meta(id, { supportsThinking: false }))).toBe(false)
  })

  it('drops Off when thinking cannot be disabled', () => {
    const m = meta('grok-4.5', {
      supportsThinking: true,
      supportedThinkingEfforts: ['low', 'medium', 'high'],
      thinkingCanDisable: false,
      thinkingDefaultEffort: 'high'
    })
    expect(ladder('xai', m.id, m)).toEqual(['Low', 'Med', 'High'])
  })

  it('lists only catalog-supported efforts', () => {
    const m = meta('google/gemini-3-pro', { supportsThinking: true, supportedThinkingEfforts: ['low', 'high'] })
    expect(ladder('openrouter', m.id, m)).toEqual(['Off', 'Low', 'High'])
  })

  it('hides Ollama effort only when the catalog confirms supportsThinking false', () => {
    for (const id of ['glm-5.2', 'gemma4:31b-cloud', 'minimax-m2.5:cloud'] as const) {
      expect(modelShowsThinkingControls('ollama', id, meta(id, { supportsThinking: false }))).toBe(false)
      expect(modelShowsThinkingControls('ollama', id)).toBe(true)
      expect(modelShowsThinkingControls('ollama', id, meta(id))).toBe(true)
    }
  })

  it('shows Off/Low/Med/High/Max for Ollama when the catalog returns thinking capabilities', () => {
    const m = meta('deepseek-v3.1:671b-cloud', {
      supportsThinking: true,
      thinkingMode: 'effort',
      thinkingCanDisable: true,
      supportedThinkingEfforts: ['low', 'medium', 'high', 'max'],
      thinkingDefaultEffort: 'medium'
    })
    expect(ladder('ollama', m.id, m)).toEqual(['Off', 'Low', 'Med', 'High', 'Max'])
  })

  it('gives Ollama GPT-OSS low/medium/high without Off or max, before and after the catalog', () => {
    const m = meta('gpt-oss:120b-cloud', {
      supportsThinking: true,
      thinkingMode: 'effort',
      thinkingCanDisable: false,
      supportedThinkingEfforts: ['low', 'medium', 'high'],
      thinkingDefaultEffort: 'medium'
    })
    expect(ladder('ollama', m.id, m)).toEqual(['Low', 'Med', 'High'])
    expect(ladder('ollama', m.id)).toEqual(['Low', 'Med', 'High'])
  })

  describe('OpenCode Go (opencode)', () => {
    // The Go catalog (ids + effort ladders) resolves live from models.dev with a
    // module-level cache that is EMPTY in a fresh vitest process. Seed it before
    // reading seedModelsFor, and build goMeta after seeding — collection-time
    // evaluation would capture an empty model list (documented pitfall; see
    // seedModelsPlaceholder.test.ts / opencodeProvider.test.ts).
    let goMeta: Map<string, ModelInfo>
    beforeAll(async () => {
      await loadOpenCodeGoCatalog()
      goMeta = new Map(seedModelsFor('opencode').map((m) => [m.id, m]))
    }, 30_000)

    it('shows the ladder for every seeded Go model via catalog meta', () => {
      for (const id of goMeta.keys()) {
        expect(modelShowsThinkingControls('opencode', id, goMeta.get(id)!)).toBe(true)
      }
    })

    it('shows the ladder even while catalog meta is still loading', () => {
      for (const id of goMeta.keys()) {
        expect(modelShowsThinkingControls('opencode', id, null)).toBe(true)
      }
    })

    it('stops the chat-transport ladder at High', () => {
      const steps = ladder('opencode', 'longcat-2.0', goMeta.get('longcat-2.0'))
      expect(steps.at(-1)).toBe('High')
      expect(steps).not.toContain('XHigh')
      expect(steps).not.toContain('Max')
    })

    it('includes max on the messages-transport ladder for MiniMax', () => {
      expect(ladder('opencode', 'minimax-m3', goMeta.get('minimax-m3'))).toContain('Max')
    })
  })
})
