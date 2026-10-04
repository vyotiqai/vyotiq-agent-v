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
    variant: 'line' as const,
    ...overrides
  }
  return { props, ...render(<Composer {...props} />) }
}

describe('resolveLinePlaceholder', () => {
  it('follows the task: live, failed, stopped, settled, and Ask', () => {
    const base = { hasWorkspace: true, agentMode: 'agent' as const }
    expect(resolveLinePlaceholder({ ...base, running: true })).toBe('Steer it, or queue what comes next…')
    // Live wins over how the run before it ended.
    expect(resolveLinePlaceholder({ ...base, running: true, outcome: 'failed' })).toBe('Steer it, or queue what comes next…')
    expect(resolveLinePlaceholder({ ...base, running: false, outcome: 'failed' })).toBe('Tell it what to do differently…')
    expect(resolveLinePlaceholder({ ...base, running: false, outcome: 'stopped' })).toBe('Say what to change before it carries on…')
    expect(resolveLinePlaceholder({ ...base, running: false })).toBe('Ask for a change, or a follow-up…')
    expect(resolveLinePlaceholder({ ...base, running: false, agentMode: 'ask', outcome: 'failed' })).toBe(
      'Ask about the code — it reads, and changes nothing'
    )
    expect(resolveLinePlaceholder({ ...base, hasWorkspace: false, running: false })).toBe('Open a workspace to start a task')
  })
})

describe('instruction line', () => {
  it('is the field over one control row: mode, model, attach, mic, Send — no Stop while idle', () => {
    renderLine()
    const shell = document.querySelector<HTMLElement>('[data-composer-line] [data-composer-shell]')!
    expect(shell).toBeTruthy()
    const field = within(shell).getByRole('combobox', { name: 'Instruction' })
    const row = shell.querySelector<HTMLElement>('[data-composer-controls]')!
    // The field comes first; the controls sit under it, never beside it.
    expect(field.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const controls = within(row)
    expect(controls.getByRole('radiogroup', { name: 'Mode' })).toBeTruthy()
    expect(row.querySelector('[data-model-picker]')?.textContent).toContain('qwen2.5')
    expect(controls.getByRole('button', { name: 'Attach files — or type @ for context' })).toBeTruthy()
    // No key for any engine: the mic says it needs setting up, in its label.
    expect(controls.getByRole('button', { name: 'Set up dictation' })).toBeTruthy()
    // Nothing to send yet: Send is there, and says so by being off.
    expect(controls.getByRole('button', { name: 'Send' })).toHaveProperty('disabled', true)
    // Stop lives in the composer's own row, beside Send, and only while a run is live.
    expect(screen.queryByRole('button', { name: /^Stop$/ })).toBeNull()
    // The decorative prompt glyph is gone.
    expect(shell.textContent).not.toContain('›')
  })

  it('is one box on the record’s column, and its placeholder follows how the run ended', () => {
    const { rerender, props } = renderLine({ lineOutcome: 'failed' })
    const line = document.querySelector<HTMLElement>('[data-composer-line]')!
    const shell = line.querySelector<HTMLElement>('[data-composer-shell]')!
    expect(shell.classList.contains('border')).toBe(true)
    expect(shell.classList.contains('rounded-lg')).toBe(true)
    // No rule across the pane: the box is the edge.
    expect(line.classList.contains('border-t')).toBe(false)
    // The record's scroll reserves its 8px gutter; the composer reserves the same
    // width as padding, so both columns centre on one axis.
    const gutter = line.querySelector<HTMLElement>('[data-composer-gutter]')!
    expect(gutter.classList.contains('pr-2')).toBe(true)
    const column = line.querySelector<HTMLElement>('[data-composer-column]')!
    expect(column.classList.contains('max-w-[780px]')).toBe(true)
    // The box is the record's card: it bleeds 8px past the column's padding,
    // and stays the column's own child.
    expect(shell.classList.contains('-mx-2')).toBe(true)
    expect(shell.parentElement).toBe(column)
    expect(column.parentElement).toBe(gutter)
    expect(line.textContent).toContain('Tell it what to do differently…')
    rerender(<Composer {...props} lineOutcome="stopped" />)
    expect(line.textContent).toContain('Say what to change before it carries on…')
    rerender(<Composer {...props} running lineOutcome="stopped" />)
    expect(line.textContent).toContain('Steer it, or queue what comes next…')
  })

  it('sends from the Send button, as Enter does', async () => {
    const { props } = renderLine({ onSend: vi.fn(async () => true) })
    const line = screen.getByRole('combobox', { name: 'Instruction' })
    line.textContent = 'Add a regression test'
    fireEvent.input(line)
    const send = screen.getByRole('button', { name: 'Send' })
    await waitFor(() => expect(send).toHaveProperty('disabled', false))
    fireEvent.click(send)
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
    expect(vi.mocked(props.onSend).mock.calls[0]![0]).toBe('Add a regression test')
    expect(vi.mocked(props.onSend).mock.calls[0]![3]).toBeUndefined()
  })

  it('reads Queue while a run is live, with Send now beside it once there is text', async () => {
    const { props } = renderLine({ running: true, onSend: vi.fn(async () => true) })
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Queue' })).toHaveProperty('disabled', true)
    // Send now only once there is something to send.
    expect(screen.queryByRole('button', { name: 'Send now' })).toBeNull()
    const line = screen.getByRole('combobox', { name: 'Instruction' })
    line.textContent = 'Use the other API'
    fireEvent.input(line)
    fireEvent.click(await screen.findByRole('button', { name: 'Send now' }))
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
    expect(vi.mocked(props.onSend).mock.calls[0]![3]).toEqual({ steer: true })
  })

  it('puts Stop in the control row before the action while a run is live', () => {
    const onStop = vi.fn()
    const { props, rerender } = renderLine({ running: true, onStop })
    const row = document.querySelector<HTMLElement>('[data-composer-line] [data-composer-controls]')!
    const stop = within(row).getByRole('button', { name: 'Stop' })
    // Same right edge as the action: Stop sits directly before it.
    expect(stop.nextElementSibling?.textContent).toContain('Queue')
    fireEvent.click(stop)
    expect(onStop).toHaveBeenCalledTimes(1)

    // Idle again, and nothing is left to stop.
    rerender(<Composer {...props} running={false} />)
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('keeps Stop out of the New task brief', () => {
    const onStop = vi.fn()
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running
        hasWorkspace
        secrets={emptySecretStatus()}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={onStop}
        variant="brief"
      />
    )
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('shows the context used beside the controls once there is a reading', () => {
    renderLine({
      contextUsage: {
        step: 3,
        used: 4000,
        estimatedTokens: 4000,
        inputTokens: 4000,
        window: 32768,
        contentWindow: 27852,
        compactionTrigger: 27852,
        source: 'provider',
        layers: { system: 1000, history: 3000, tools: 0, buffer: 0 },
        stepUsage: {
          inputTokens: 4000,
          billedInputTokens: 9000,
          peakInputTokens: 4000,
          outputTokens: 120,
          cachedInputTokens: 0,
          billedCachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningTokens: 0,
          steps: 3,
          stepsWithCacheReport: 0,
          billedCost: 0,
          billedCostSaved: 0,
          stepsWithCostReport: 0,
          estimatedCost: 0,
          stepsWithEstimate: 0,
          generationMs: 0
        },
        updatedAt: '2026-01-01T12:00:00.000Z'
      }
    })
    const meter = document.querySelector<HTMLButtonElement>('[data-composer-controls] [data-context-meter]')!
    expect(meter).toBeTruthy()
    expect(meter.textContent).toMatch(/\d+%/)
  })

  it('steers with Shift+Enter while a run is live, and only then; Enter still queues', async () => {
    const { props } = renderLine({ running: true, onSend: vi.fn(async () => true) })
    const line = screen.getByRole('combobox', { name: 'Instruction' })
    line.textContent = 'Stop and use the other API'
    fireEvent.input(line)
    fireEvent.keyDown(line, { key: 'Enter', shiftKey: true })
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
    expect(vi.mocked(props.onSend).mock.calls[0]![0]).toBe('Stop and use the other API')
    expect(vi.mocked(props.onSend).mock.calls[0]![3]).toEqual({ steer: true })

    line.textContent = 'Then check the docs'
    fireEvent.input(line)
    fireEvent.keyDown(line, { key: 'Enter' })
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(2))
    // Queued for the turn's end, as before.
    expect(vi.mocked(props.onSend).mock.calls[1]![3]).toBeUndefined()
  })

  it('does not steer when no run is live — Shift+Enter is not a send then', async () => {
    const { props } = renderLine({ running: false, onSend: vi.fn(async () => true) })
    const line = screen.getByRole('combobox', { name: 'Instruction' })
    line.textContent = 'hello'
    fireEvent.input(line)
    fireEvent.keyDown(line, { key: 'Enter', shiftKey: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(props.onSend).not.toHaveBeenCalled()
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
    fireEvent.click(within(queue).getByRole('button', { name: 'Send queued instruction now' }))
    expect(onSendFollowUpNow).toHaveBeenCalledWith('f1')
    fireEvent.click(within(queue).getByRole('button', { name: 'Remove queued instruction' }))
    expect(onRemoveFollowUp).toHaveBeenCalledWith('f1')
    fireEvent.click(within(queue).getByRole('button', { name: 'Edit queued instruction' }))
    expect(screen.getByRole('textbox', { name: 'Edit queued instruction' })).toBeTruthy()
  })

  it('shows an instruction queued offline as such, with edit and remove but no send now', () => {
    const onRemoveFollowUp = vi.fn()
    renderLine({
      pendingFollowUps: [
        { id: 'o1', itemId: 'o1', preview: 'Run the tests again', text: 'Run the tests again', offline: true }
      ],
      onSendFollowUpNow: vi.fn(),
      onRemoveFollowUp,
      onEditFollowUp: vi.fn(async () => true)
    })
    const queue = screen.getByRole('list', { name: 'Queued instructions' })
    expect(within(queue).getByText('Queued · offline')).toBeTruthy()
    expect(queue.querySelector('[data-follow-up-offline]')).not.toBeNull()
    expect(within(queue).queryByRole('button', { name: 'Send queued instruction now' })).toBeNull()
    expect(within(queue).getByRole('button', { name: 'Edit queued instruction' })).toBeTruthy()
    fireEvent.click(within(queue).getByRole('button', { name: 'Remove queued instruction' }))
    expect(onRemoveFollowUp).toHaveBeenCalledWith('o1')
  })

  it('switches mode in one press, Agent first', () => {
    const onAgentModeChange = vi.fn()
    renderLine({ onAgentModeChange })
    const modes = screen.getByRole('radiogroup', { name: 'Mode' })
    const radios = within(modes).getAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(['Agent', 'Ask'])
    expect(radios[0]!.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(modes).getByRole('radio', { name: 'Ask' }))
    expect(onAgentModeChange).toHaveBeenCalledWith('ask')
  })

  it('picks the model from its own popover', async () => {
    const onProviderModel = vi.fn()
    renderLine({ onProviderModel })
    const picker = document.querySelector<HTMLButtonElement>('[data-model-picker]')!
    expect(picker.textContent).toContain('qwen2.5')
    fireEvent.click(picker)
    const dialog = await screen.findByRole('dialog', { name: 'Model and effort' })
    // Mode is not in here any more — it has its own switch.
    expect(within(dialog).queryByRole('radiogroup', { name: 'Mode' })).toBeNull()
    await waitFor(() => expect(within(dialog).getByText('llama3.2')).toBeTruthy())
    // The model in use reads as selected by weight and a check — no accent tint,
    // which is reserved for Needs you.
    const current = within(dialog).getByRole('option', { selected: true })
    expect(current.textContent).toContain('qwen2.5')
    expect(current.className).not.toContain('bg-accent-soft')
    expect(current.querySelector('svg')).toBeTruthy()
    fireEvent.click(within(dialog).getByText('llama3.2'))
    expect(onProviderModel).toHaveBeenCalledWith('ollama', 'llama3.2')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Model and effort' })).toBeNull())
  })

  it('searches every provider from the popover', async () => {
    renderLine()
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-model-picker]')!)
    const dialog = await screen.findByRole('dialog', { name: 'Model and effort' })
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
