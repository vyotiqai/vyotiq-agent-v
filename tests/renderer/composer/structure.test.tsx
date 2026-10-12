/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { DEFAULT_SETTINGS, emptySecretStatus, type PromptStructureResult } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import { resetWorkspaceHotUiStoreForTests } from '@renderer/lib/hooks/workspaceHotUiStore'

afterEach(() => {
  cleanup()
  resetWorkspaceHotUiStoreForTests()
})

const chatSettings = {
  provider: 'ollama',
  model: 'qwen2.5',
  keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
  thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
  thinkingEffort: DEFAULT_SETTINGS.thinkingEffort,
  showThinking: DEFAULT_SETTINGS.showThinking
} as EffectiveChatSettings

const promptStructure = vi.fn()
const promptStructureCancel = vi.fn(async () => ({ ok: true as const, data: { cancelled: true } }))

beforeEach(() => {
  promptStructure.mockReset()
  promptStructureCancel.mockClear()
  window.vyotiq = {
    listModels: vi.fn(async () => ({
      ok: true as const,
      data: {
        models: [{ id: 'qwen2.5', inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsVision: false }],
        warning: null
      }
    })),
    promptStructure,
    promptStructureCancel
  } as unknown as typeof window.vyotiq
})

function result(data: PromptStructureResult) {
  return { ok: true as const, data }
}

function renderLine(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const props = {
    provider: 'ollama' as const,
    model: 'qwen2.5',
    running: false,
    hasWorkspace: true,
    workspacePath: '/ws',
    secrets: emptySecretStatus(),
    chatSettings,
    onChatSettingsChange: vi.fn(),
    onProviderModel: vi.fn(),
    onSend: vi.fn(async () => true),
    onStop: vi.fn(),
    variant: 'line' as const,
    ...overrides
  }
  return { props, ...render(<Composer {...props} />) }
}

function type(text: string): HTMLElement {
  const line = screen.getByRole('combobox', { name: 'Instruction' })
  line.textContent = text
  fireEvent.input(line)
  return line
}

const structureButton = (): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>('[data-composer-structure]')!

describe('Structure in the composer', () => {
  it('is off until there is an instruction to structure', async () => {
    renderLine()
    expect(structureButton().disabled).toBe(true)
    type('yes')
    await waitFor(() => expect(structureButton().getAttribute('aria-label')).toMatch(/Write what you want done first/))
    expect(structureButton().disabled).toBe(true)
    type('audit the whole app')
    await waitFor(() => expect(structureButton().disabled).toBe(false))
  })

  it('replaces the draft with the brief; Undo puts the words back', async () => {
    promptStructure.mockResolvedValue(result({ kind: 'brief', taskType: 'audit', brief: 'Audit the app.\n\n## Deliverable\n- A report' }))
    renderLine({ agentMode: 'ask' })
    const line = type('audit the whole app')
    await waitFor(() => expect(structureButton().disabled).toBe(false))
    fireEvent.click(structureButton())
    await waitFor(() => expect(line.textContent).toContain('Audit the app.'))
    expect(promptStructure).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: '/ws', text: 'audit the whole app', mode: 'ask', provider: 'ollama', model: 'qwen2.5', mentions: [] })
    )
    const strip = document.querySelector<HTMLElement>('[data-structure-done]')!
    expect(strip.textContent).toContain('Structured')
    expect(strip.textContent).toContain('audit brief')
    fireEvent.click(within(strip).getByRole('button', { name: /Undo/ }))
    await waitFor(() => expect(line.textContent).toBe('audit the whole app'))
    expect(document.querySelector('[data-structure-done]')).toBeNull()
  })

  it('offers no checks on the instruction line: only New task has them', async () => {
    promptStructure.mockResolvedValue(result({ kind: 'brief', taskType: 'bug', brief: 'Fix it.\n\n## Done when\n- It works' }))
    renderLine()
    type('fix the login crash')
    await waitFor(() => expect(structureButton().disabled).toBe(false))
    fireEvent.click(structureButton())
    await waitFor(() => expect(document.querySelector('[data-structure-done]')).not.toBeNull())
    expect(document.querySelector('[data-structure-move-checks]')).toBeNull()
  })

  it('sends the brief with the words it replaced, for the record', async () => {
    promptStructure.mockResolvedValue(result({ kind: 'brief', taskType: 'bug', brief: 'Fix the login crash.' }))
    const { props } = renderLine()
    type('fix the login crash')
    await waitFor(() => expect(structureButton().disabled).toBe(false))
    fireEvent.click(structureButton())
    await waitFor(() => expect(document.querySelector('[data-structure-done]')).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
    const [text, , , extras] = vi.mocked(props.onSend).mock.calls[0]!
    expect(text).toBe('Fix the login crash.')
    expect(extras).toEqual({ structuredFrom: 'fix the login crash' })
    await waitFor(() => expect(document.querySelector('[data-structure-done]')).toBeNull())
  })

  it('runs from Ctrl+Shift+Enter, holds the field and Send while it works, and Esc cancels', async () => {
    let resolve: (v: unknown) => void = () => undefined
    promptStructure.mockImplementation(() => new Promise((r) => (resolve = r)))
    const { props } = renderLine()
    const line = type('add a dark mode toggle')
    fireEvent.keyDown(line, { key: 'Enter', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(document.querySelector('[data-structure-working]')).not.toBeNull())
    expect(screen.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true)
    fireEvent.keyDown(line, { key: 'Enter' })
    expect(props.onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('[data-structure-working]')).toBeNull())
    expect(promptStructureCancel).toHaveBeenCalledWith({ requestId: expect.stringMatching(/^structure-/) })
    // A late answer to the cancelled call changes nothing.
    resolve(result({ kind: 'brief', taskType: 'feature', brief: 'Late brief' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(line.textContent).toBe('add a dark mode toggle')
  })

  it('asks first when it needs to, then writes the brief with the answers', async () => {
    promptStructure
      .mockResolvedValueOnce(
        result({
          kind: 'questions',
          taskType: 'bug',
          questions: [{ id: 'q1', question: 'Which login flow?', options: ['Email', 'GitHub'], multi: false }]
        })
      )
      .mockResolvedValueOnce(result({ kind: 'brief', taskType: 'bug', brief: 'Fix the GitHub login.' }))
    renderLine()
    const line = type('fix the login please')
    await waitFor(() => expect(structureButton().disabled).toBe(false))
    fireEvent.click(structureButton())
    const panel = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-structure-questions]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(panel.textContent).toContain('Which login flow?')
    fireEvent.click(within(panel).getByRole('radio', { name: 'GitHub' }))
    fireEvent.click(within(panel).getByRole('button', { name: /Write the brief/ }))
    await waitFor(() => expect(line.textContent).toBe('Fix the GitHub login.'))
    expect(promptStructure.mock.calls[1]![0]).toMatchObject({
      text: 'fix the login please',
      answers: [{ question: 'Which login flow?', answer: 'GitHub' }]
    })
  })

  it('says why when it could not, and leaves the draft alone', async () => {
    promptStructure.mockResolvedValue(result({ kind: 'unavailable', reason: 'No API key configured for openai' }))
    renderLine()
    const line = type('refactor the settings page')
    await waitFor(() => expect(structureButton().disabled).toBe(false))
    fireEvent.click(structureButton())
    const strip = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-structure-error]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(strip.textContent).toContain('No API key configured for openai')
    expect(line.textContent).toBe('refactor the settings page')
  })
})
