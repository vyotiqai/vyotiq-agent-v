/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { claudeEffortRequest, effortFootNote, effortNotes } from '@renderer/features/chat/components/composer/effortCost'
import { buildModes } from '@renderer/features/chat/components/composer/ThinkingControls'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import { resetWorkspaceHotUiStoreForTests } from '@renderer/lib/hooks/workspaceHotUiStore'

afterEach(() => {
  cleanup()
  resetWorkspaceHotUiStoreForTests()
})

describe('claudeEffortRequest', () => {
  it('reads a Claude request the way anthropicThinkingFields builds it, and nothing for other providers', () => {
    expect(claudeEffortRequest('anthropic', 'claude-sonnet-4-5', undefined, 'medium')).toEqual({ budget: 8_192 })
    expect(claudeEffortRequest('anthropic', 'claude-opus-5', undefined, 'minimal')).toEqual({ level: 'low' })
    expect(claudeEffortRequest('anthropic', 'claude-sonnet-4-5', { thinkingMode: 'adaptive' }, 'high')).toEqual({ level: 'high' })
    // The same fields ride Claude on Bedrock and Vertex.
    expect(claudeEffortRequest('bedrock', 'anthropic.claude-sonnet-4-5-v1:0', undefined, 'high')).toEqual({ budget: 16_384 })
    expect(claudeEffortRequest('vertex', 'anthropic/claude-sonnet-4-5', undefined, 'low')).toEqual({ budget: 2_048 })
    expect(claudeEffortRequest('vertex', 'gemini-3-pro', undefined, 'low')).toBeNull()
    expect(claudeEffortRequest('openai', 'gpt-5.6', undefined, 'high')).toBeNull()
  })
})

describe('effortNotes', () => {
  const ladder = buildModes(undefined, true, undefined)

  it('says the budget each level sends, and which levels send the same one', () => {
    const notes = effortNotes(ladder, { provider: 'anthropic', model: 'claude-sonnet-4-5', meta: undefined })
    expect(Object.fromEntries(ladder.map((m, i) => [m.short, notes[i]]))).toEqual({
      Off: 'No thinking before a step',
      Min: 'Up to 2,048 thinking tokens a step, the same as Low',
      Low: 'Up to 2,048 thinking tokens a step, the same as Minimal',
      Med: 'Up to 8,192 thinking tokens a step',
      High: 'Up to 16,384 thinking tokens a step',
      XHigh: 'Up to 32,768 thinking tokens a step, the same as Max',
      Max: 'Up to 32,768 thinking tokens a step, the same as Extra high'
    })
  })

  it('says a level an adaptive Claude model is sent as another, and nothing about one sent as itself', () => {
    const notes = effortNotes(ladder, { provider: 'anthropic', model: 'claude-opus-5', meta: undefined })
    expect(notes[1]).toBe('Sent as Low: the same request')
    expect(notes.slice(2)).toEqual([null, null, null, null, null])
  })

  it('claims nothing about a level another provider maps its own way', () => {
    const notes = effortNotes(ladder, { provider: 'gemini', model: 'gemini-3-pro', meta: undefined })
    expect(notes.slice(1)).toEqual([null, null, null, null, null, null])
  })
})

describe('effortFootNote', () => {
  it('calls the level a ceiling, and says thinking is billed only where the price table knows a price', () => {
    expect(effortFootNote('ollama', 'qwen2.5')).toBe(
      'The most it thinks on a step: a run of steps that only read or search thinks less.'
    )
    expect(effortFootNote('anthropic', 'claude-sonnet-4-5')).toMatch(/ Thinking tokens are billed\.$/)
  })
})

describe('Model popover effort note', () => {
  const chatSettings: EffectiveChatSettings = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
    thinkingEnabled: true,
    thinkingEffort: 'medium',
    showThinking: DEFAULT_SETTINGS.showThinking
  }

  beforeEach(() => {
    window.vyotiq = {
      listModels: vi.fn(async () => ({
        ok: true as const,
        data: {
          models: [
            {
              id: 'claude-sonnet-4-5',
              inputModalities: ['text'],
              outputModalities: ['text'],
              supportsTools: true,
              supportsVision: false,
              supportsThinking: true,
              supportedThinkingEfforts: ['low', 'medium', 'high'],
              thinkingMode: 'manual'
            }
          ],
          warning: null
        }
      }))
    } as unknown as typeof window.vyotiq
  })

  it('says what the set effort costs under the levels, and each level says it on hover', async () => {
    const secrets = { ...emptySecretStatus(), anthropic: true }
    render(
      <Composer
        provider="anthropic"
        model="claude-sonnet-4-5"
        running={false}
        hasWorkspace
        secrets={secrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
      />
    )
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-model-picker]')!)
    const dialog = await screen.findByRole('dialog', { name: 'Model and effort' })
    const note = dialog.querySelector('[data-effort-note]')
    expect(note?.textContent).toBe(
      `Medium: Up to 8,192 thinking tokens a step. ${effortFootNote('anthropic', 'claude-sonnet-4-5')}`
    )
    const effort = within(dialog).getByRole('radiogroup', { name: 'Effort' })
    expect(within(effort).getByRole('radio', { name: 'High' }).getAttribute('title')).toBe(
      'High: Up to 16,384 thinking tokens a step'
    )
  })
})
