/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, within, waitFor, act } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { mentionMarker } from '@renderer/features/chat/components/composer/mentionModel'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import {
  resetWorkspaceHotUiStoreForTests,
  setWorkspaceHotComposerDraft
} from '@renderer/lib/hooks/workspaceHotUiStore'

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
          {
            id: 'qwen2.5',
            inputModalities: ['text'],
            outputModalities: ['text'],
            supportsTools: true,
            supportsVision: false
          },
          {
            id: 'llama3.2',
            inputModalities: ['text'],
            outputModalities: ['text'],
            supportsTools: true,
            supportsVision: false
          }
        ],
        warning: null
      }
    }))
  }
})

const testSecrets = emptySecretStatus()

describe('Composer', () => {
  it('explains why Send is disabled when no workspace is available', () => {
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        disabled
        hasWorkspace={false}
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )

    expect(screen.getByTitle('Open a workspace to send a message.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Send$/i }).getAttribute('aria-disabled')).toBe(
      'true'
    )
  })

  it('uses custom model menu not select', async () => {
    const onProviderModel = vi.fn()
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        secrets={testSecrets}
        chatSettings={{ ...chatSettings, provider: 'ollama', model: 'qwen2.5' }}
        onChatSettingsChange={vi.fn()}
        onProviderModel={onProviderModel}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )

    expect(document.querySelector('select')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    await waitFor(() => {
      expect(within(screen.getByRole('listbox')).getByText('llama3.2')).toBeTruthy()
    })
    fireEvent.click(within(screen.getByRole('listbox')).getByText('llama3.2'))
    expect(onProviderModel).toHaveBeenCalledWith('ollama', 'llama3.2')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('restores composer draft when send reports failure', async () => {
    const onSend = vi.fn(async () => false)
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />
    )

    const ta = screen.getByRole('combobox', { name: /^Message$/i })
    ta.textContent = 'keep me'
    fireEvent.input(ta)
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('keep me', undefined, undefined, undefined)
    })
    await waitFor(() => {
      expect(ta.textContent).toBe('keep me')
    })
  })

  it('normalizes whitespace-only drafts so the composer stays one line', async () => {
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )

    const ta = screen.getByRole('combobox', { name: /^Message$/i })
    ta.textContent = '\n\n\n\n\n\n\n\n\n\n'
    fireEvent.input(ta)

    // Whitespace-only input normalizes to an empty draft — the controlled DOM
    // re-renders empty so invisible blank lines never stretch the composer body.
    await waitFor(() => {
      expect(ta.textContent).toBe('')
    })
    expect(screen.getByRole('button', { name: /^Dictate$/i })).toBeTruthy()
  })

  it('does not overwrite a newer draft when an earlier send fails', async () => {
    let finishSend: ((ok: boolean) => void) | undefined
    const onSend = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSend = resolve
        })
    )
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />
    )

    const ta = screen.getByRole('combobox', { name: /^Message$/i })
    ta.textContent = 'first message'
    fireEvent.input(ta)
    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))

    ta.textContent = 'newer draft'
    fireEvent.input(ta)
    await act(async () => finishSend?.(false))

    await waitFor(() => expect(ta.textContent).toBe('newer draft'))
  })

  it('does not send partial text when a referenced mention cannot be resolved', async () => {
    window.vyotiq.workspaceReadText = vi.fn(async () => ({
      ok: false as const,
      error: 'Referenced file no longer exists'
    }))
    const onSend = vi.fn()
    const onDraftChange = vi.fn()
    const draft = `Review ${mentionMarker({ kind: 'file', path: 'src/missing.ts' })}`
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        hasWorkspace
        workspacePath="/ws"
        draft={draft}
        onDraftChange={onDraftChange}
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />
    )

    fireEvent.submit(screen.getByRole('combobox', { name: /^Message$/i }).closest('form')!)

    expect((await screen.findByRole('alert')).textContent).toMatch(/no longer exists/i)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('filters live model menu for vision when images are attached', async () => {
    // @ts-expect-error test bridge
    window.vyotiq.listModels = vi.fn(async () => ({
      ok: true as const,
      data: {
        models: [
          {
            id: 'gpt-5.6',
            inputModalities: ['text', 'image'],
            outputModalities: ['text'],
            supportsTools: true,
            supportsVision: true
          },
          {
            id: 'gpt-5.6-terra',
            inputModalities: ['text', 'image'],
            outputModalities: ['text'],
            supportsTools: true,
            supportsVision: true
          },
          {
            id: 'text-only',
            inputModalities: ['text'],
            outputModalities: ['text'],
            supportsTools: true,
            supportsVision: false
          }
        ],
        warning: null
      }
    }))
    render(
      <Composer
        provider="openai"
        model="gpt-5.6"
        running={false}
        hasWorkspace
        secrets={{ ...testSecrets, openai: true }}
        chatSettings={{ ...chatSettings, provider: 'openai', model: 'gpt-5.6' }}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['pixels'], 'shot.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    fireEvent.change(fileInput)

    await waitFor(() => {
      expect(screen.getByAltText(/Image 1/i)).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    await waitFor(() => {
      const listbox = screen.getByRole('listbox')
      expect(within(listbox).getByText('gpt-5.6')).toBeTruthy()
      expect(within(listbox).getByText('gpt-5.6-terra')).toBeTruthy()
      expect(within(listbox).queryByText('text-only')).toBeNull()
    })
  })

  it('blocks send while a selected attachment is still being extracted', async () => {
    let finishExtract:
      | ((value: {
          ok: true
          data: { name: string; mime: string; text: string; truncated: false }
        }) => void)
      | undefined
    // @ts-expect-error test bridge
    window.vyotiq.extractAttachment = vi.fn(
      () =>
        new Promise((resolve) => {
          finishExtract = resolve
        })
    )
    const onSend = vi.fn()
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />
    )

    const ta = screen.getByRole('combobox', { name: /^Message$/i })
    ta.textContent = 'read the attachment'
    fireEvent.input(ta)
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['pending'], 'pending.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    fireEvent.change(fileInput)
    await waitFor(() => expect(window.vyotiq.extractAttachment).toHaveBeenCalled())

    expect(screen.getByRole('button', { name: /^Send$/i }).getAttribute('aria-disabled')).toBe(
      'true'
    )
    fireEvent.keyDown(ta, { key: 'Enter', code: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()

    await act(async () => {
      finishExtract?.({
        ok: true,
        data: {
          name: 'pending.md',
          mime: 'text/markdown',
          text: 'pending',
          truncated: false
        }
      })
    })
    await waitFor(() => expect(screen.getByText('pending.md')).toBeTruthy())
  })

  it('attaches a document and sends its extracted text', async () => {
    const extractAttachment = vi.fn(async () => ({
      ok: true as const,
      data: { name: 'spec.md', mime: 'text/markdown', text: 'rules here', truncated: false }
    }))
    window.vyotiq.extractAttachment = extractAttachment
    const onSend = vi.fn()
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />
    )

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['rules here'], 'spec.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    fireEvent.change(fileInput)

    await waitFor(() => {
      expect(screen.getByText('spec.md')).toBeTruthy()
    })
    expect(extractAttachment).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /^Send$/i }))
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(
        '',
        undefined,
        [{ type: 'file', name: 'spec.md', mime: 'text/markdown', text: 'rules here' }],
        undefined
      )
    })
  })

  it('surfaces the reason a document could not be read', async () => {
    window.vyotiq.extractAttachment = vi.fn(async () => ({
      ok: false as const,
      error: 'scan.pdf has no extractable text (it may be a scan)'
    }))
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    fireEvent.change(fileInput)

    await waitFor(() => {
      expect(screen.getByText(/no extractable text/i)).toBeTruthy()
    })
  })

  it('keeps composer editable while a run is in progress and shows Stop only', () => {
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running
        hasWorkspace
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )

    const ta = screen.getByRole('combobox', { name: /^Message$/i })
    expect(ta.getAttribute('contenteditable')).toBe('true')
    expect(screen.getByRole('button', { name: /^Stop$/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Send follow-up$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Send$/i })).toBeNull()
  })

  it('keeps mode, teammate, and model controls enabled while a run is in progress', async () => {
    const onAgentModeChange = vi.fn()
    const onAgentProfileChange = vi.fn()
    const onProviderModel = vi.fn()
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running
        hasWorkspace
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={onProviderModel}
        onAgentModeChange={onAgentModeChange}
        onAgentProfileChange={onAgentProfileChange}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )

    const mode = screen.getByRole('button', { name: /Agent mode/i })
    const teammate = screen.getByRole('button', { name: 'Teammate' })
    const modelPicker = screen.getByRole('button', { name: 'Select model' })
    expect(mode).toHaveProperty('disabled', false)
    expect(teammate).toHaveProperty('disabled', false)
    expect(modelPicker).toHaveProperty('disabled', false)

    fireEvent.click(mode)
    expect(onAgentModeChange).toHaveBeenCalledWith('ask')

    fireEvent.click(teammate)
    await waitFor(() => {
      expect(screen.getByRole('listbox', { name: 'Teammate' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('option', { name: /No teammate \(default agent\)/i }))
    expect(onAgentProfileChange).toHaveBeenCalledWith(null)

    fireEvent.click(modelPicker)
    await waitFor(() => {
      expect(screen.getByRole('listbox', { name: 'Select model' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('option', { name: /llama3.2 Tools/i }))
    expect(onProviderModel).toHaveBeenCalledWith('ollama', 'llama3.2')
  })

  it('focuses an inline composer when it mounts for prompt editing', () => {
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        hasWorkspace
        hasTranscript
        variant="inline"
        draft="Edit this prompt"
        onDraftChange={vi.fn()}
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onCancelEdit={vi.fn()}
      />
    )

    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: /^Message$/i }))
  })

  it('cancels inline edit on Escape when no menu consumed it', () => {
    const onCancelEdit = vi.fn()
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        hasWorkspace
        hasTranscript
        variant="inline"
        draft="Edit this prompt about SessionChatColumn file open wiring"
        onDraftChange={vi.fn()}
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onCancelEdit={onCancelEdit}
      />
    )

    fireEvent.keyDown(screen.getByRole('combobox', { name: /^Message$/i }), { key: 'Escape' })
    expect(onCancelEdit).toHaveBeenCalledTimes(1)
  })

  it('queues follow-ups via Enter while running without a Send button', async () => {
    const onSend = vi.fn(async () => true)
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running
        hasWorkspace
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
      />
    )

    const ta = screen.getByRole('combobox', { name: /^Message$/i })
    ta.textContent = 'steer left'
    fireEvent.input(ta)
    fireEvent.keyDown(ta, { key: 'Enter', code: 'Enter' })

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('steer left', undefined, undefined, undefined)
    })
  })

  it('shows queued follow-ups with edit, send now, and remove', async () => {
    const onRemoveFollowUp = vi.fn()
    const onEditFollowUp = vi.fn().mockResolvedValue(true)
    const onSendFollowUpNow = vi.fn()
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running
        hasWorkspace
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        pendingFollowUps={[
          { id: 'fu-1', itemId: 'item-1', preview: 'Steer left', text: 'Steer left' }
        ]}
        onRemoveFollowUp={onRemoveFollowUp}
        onEditFollowUp={onEditFollowUp}
        onSendFollowUpNow={onSendFollowUpNow}
      />
    )

    expect(screen.getByText('Steer left')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Edit queued follow-up$/i }))
    const editor = screen.getByRole('textbox', { name: /^Edit queued follow-up$/i })
    fireEvent.change(editor, { target: { value: 'Steer right' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save queued follow-up edit$/i }))
    await waitFor(() => {
      expect(onEditFollowUp).toHaveBeenCalledWith('fu-1', 'Steer right')
    })

    fireEvent.click(screen.getByRole('button', { name: /^Send queued follow-up now$/i }))
    expect(onSendFollowUpNow).toHaveBeenCalledWith('fu-1')

    fireEvent.click(screen.getByRole('button', { name: /^Remove queued follow-up$/i }))
    expect(onRemoveFollowUp).toHaveBeenCalledWith('fu-1')
  })

  it('keeps queued follow-up editor open when save fails', async () => {
    const onEditFollowUp = vi.fn().mockResolvedValue(false)
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running
        hasWorkspace
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
        pendingFollowUps={[
          { id: 'fu-1', itemId: 'item-1', preview: 'Steer left', text: 'Steer left' }
        ]}
        onEditFollowUp={onEditFollowUp}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Edit queued follow-up$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Save queued follow-up edit$/i }))
    await waitFor(() => {
      expect(onEditFollowUp).toHaveBeenCalledWith('fu-1', 'Steer left')
    })
    expect(screen.getByRole('textbox', { name: /^Edit queued follow-up$/i })).toBeTruthy()
  })

  it('does not show reconnecting status below the composer while running with network_wait', () => {
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running
        hasWorkspace
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )

    expect(screen.queryByText(/Reconnecting/i)).toBeNull()
  })

  it('enables send when per-run hot draft has content even if draft prop is empty', () => {
    setWorkspaceHotComposerDraft('/ws/demo', 'run-1', 'I have a typed message')
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        hasWorkspace
        workspacePath="/ws/demo"
        activeRunId="run-1"
        draft=""
        onDraftChange={vi.fn()}
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )

    const send = screen.getByRole('button', { name: 'Send' })
    expect(send.hasAttribute('disabled')).toBe(false)
  })

  it('attaches a dropped image on the composer shell', async () => {
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onStop={vi.fn()}
      />
    )
    const shell = document.querySelector('[data-composer-shell]')
    expect(shell).toBeTruthy()
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
    fireEvent.drop(shell as Element, {
      dataTransfer: {
        files: [file],
        items: [],
        types: ['Files']
      }
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Remove image/i })).toBeTruthy()
    })
  })
})
