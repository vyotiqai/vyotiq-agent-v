/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { resolveLinePlaceholder } from '@renderer/features/chat/components/composer/composerPlaceholder'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import { resetWorkspaceHotUiStoreForTests } from '@renderer/lib/hooks/workspaceHotUiStore'

afterEach(() => {
  cleanup()
  resetWorkspaceHotUiStoreForTests()
})

const chatSettings: EffectiveChatSettings = {
  provider: 'ollama',
  model: 'qwen2.5',
  keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
  thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
  thinkingEffort: DEFAULT_SETTINGS.thinkingEffort,
  showThinking: DEFAULT_SETTINGS.showThinking
}

beforeEach(() => {
  window.vyotiq = {
    listModels: vi.fn(async () => ({
      ok: true as const,
      data: {
        models: [
          { id: 'qwen2.5', inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsVision: false },
          { id: 'llama3.2', inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsVision: false }
        ],
        warning: null
      }
    }))
  }
})

function renderLine(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const props = {
    provider: 'ollama' as const,
    model: 'qwen2.5',
    running: false,
    hasWorkspace: true,
    secrets: emptySecretStatus(),
    chatSettings,
    onChatSettingsChange: vi.fn(),
    onProviderModel: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    variant: 'line' as const,
    ...overrides
  }
  return { props, ...render(<Composer {...props} />) }
}

describe('resolveLinePlaceholder', () => {
  it('says what sending does now', () => {
    const base = { hasWorkspace: true, agentMode: 'agent' as const, runCount: 0 }
    expect(resolveLinePlaceholder({ ...base, running: true })).toBe('Add an instruction — starts when this run ends')
    expect(resolveLinePlaceholder({ ...base, running: false, runCount: 2 })).toBe('Follow up — starts run 3')
    expect(resolveLinePlaceholder({ ...base, running: false })).toBe('Add an instruction')
    expect(resolveLinePlaceholder({ ...base, running: false, agentMode: 'ask' })).toBe('Add an instruction · won’t edit files')
  })
})

describe('instruction line', () => {
  it('is one row with no Send or Stop button — Enter sends, Esc stops', () => {
    renderLine({ running: true })
    expect(screen.getByRole('combobox', { name: 'Instruction' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Send$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Stop$/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Attach files — or type @ for context' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeTruthy()
    expect(document.querySelector('[data-composer-line] [data-composer-shell]')).toBeTruthy()
  })

  it('lists queued instructions with send now, edit and remove', () => {
    const onSendFollowUpNow = vi.fn()
    const onRemoveFollowUp = vi.fn()
    renderLine({
      running: true,
      pendingFollowUps: [{ id: 'f1', itemId: 'followup-f1', preview: 'Also check the docs', text: 'Also check the docs' }],
      onSendFollowUpNow,
      onRemoveFollowUp,
      onEditFollowUp: vi.fn(async () => true)
    })
    const queue = screen.getByRole('list', { name: 'Queued instructions' })
    expect(within(queue).getByText('Queued')).toBeTruthy()
    expect(within(queue).getByText('Also check the docs')).toBeTruthy()
    fireEvent.click(within(queue).getByRole('button', { name: 'Send queued follow-up now' }))
    expect(onSendFollowUpNow).toHaveBeenCalledWith('f1')
    fireEvent.click(within(queue).getByRole('button', { name: 'Remove queued follow-up' }))
    expect(onRemoveFollowUp).toHaveBeenCalledWith('f1')
    fireEvent.click(within(queue).getByRole('button', { name: 'Edit queued follow-up' }))
    expect(screen.getByRole('textbox', { name: 'Edit queued follow-up' })).toBeTruthy()
  })

  it('sets mode, model and effort from one token', async () => {
    const onProviderModel = vi.fn()
    const onAgentModeChange = vi.fn()
    renderLine({ onProviderModel, onAgentModeChange })
    const token = document.querySelector<HTMLButtonElement>('[data-task-options]')!
    expect(token.textContent).toContain('Agent · qwen2.5')
    fireEvent.click(token)
    const dialog = await screen.findByRole('dialog', { name: 'Mode, model and effort' })
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Ask' }))
    expect(onAgentModeChange).toHaveBeenCalledWith('ask')
    await waitFor(() => expect(within(dialog).getByText('llama3.2')).toBeTruthy())
    fireEvent.click(within(dialog).getByText('llama3.2'))
    expect(onProviderModel).toHaveBeenCalledWith('ollama', 'llama3.2')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Mode, model and effort' })).toBeNull())
  })

  it('searches every provider from the popover', async () => {
    renderLine()
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-task-options]')!)
    const dialog = await screen.findByRole('dialog', { name: 'Mode, model and effort' })
    await waitFor(() => expect(within(dialog).getByText('llama3.2')).toBeTruthy())
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Search models' }), { target: { value: 'llama' } })
    const list = within(dialog).getByRole('listbox', { name: 'Models' })
    expect(within(list).queryByText('qwen2.5')).toBeNull()
    expect(within(list).getByText('llama3.2')).toBeTruthy()
    // Nothing named "ollama": the provider's name finds its models.
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Search models' }), { target: { value: 'ollama' } })
    expect(within(list).getByText('qwen2.5')).toBeTruthy()
    expect(within(list).getByText('llama3.2')).toBeTruthy()
  })
})
