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
  it('says to open a workspace when there is none', () => {
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
      />
    )

    expect(screen.getByText('Open a workspace to start a task')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Instruction' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('picks the model from the options popover, not a select', async () => {
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
      />
    )

    expect(document.querySelector('select')).toBeNull()
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-model-picker]')!)
    const models = await screen.findByRole('listbox', { name: 'Models' })
    await waitFor(() => {
      expect(within(models).getByText('llama3.2')).toBeTruthy()
    })
    fireEvent.click(within(models).getByText('llama3.2'))
    expect(onProviderModel).toHaveBeenCalledWith('ollama', 'llama3.2')
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Models' })).toBeNull())
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
      />
    )

    const ta = screen.getByRole('combobox', { name: 'Instruction' })
    ta.textContent = 'keep me'
    fireEvent.input(ta)
    fireEvent.keyDown(ta, { key: 'Enter' })

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('keep me', undefined, undefined, undefined)
    })
    await waitFor(() => {
      expect(ta.textContent).toBe('keep me')
    })
  })

  it('leaves focus in a dialog the send opened', async () => {
    // The first send without an approval choice opens a question and reports
    // the send as not done: the composer must not take focus back from it.
    let dialogButton: HTMLButtonElement | null = null
    const onSend = vi.fn(async () => {
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      dialogButton = document.createElement('button')
      dialogButton.textContent = 'Edits and commands'
      dialog.appendChild(dialogButton)
      document.body.appendChild(dialog)
      dialogButton.focus()
      return false
    })
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
      />
    )

    const ta = screen.getByRole('combobox', { name: 'Instruction' })
    ta.focus()
    ta.textContent = 'first task'
    fireEvent.input(ta)
    fireEvent.keyDown(ta, { key: 'Enter' })

    await waitFor(() => expect(onSend).toHaveBeenCalled())
    await waitFor(() => expect(ta.textContent).toBe('first task'))
    // Past the composer's two-frame refocus.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.activeElement).toBe(dialogButton)
    ;(dialogButton as HTMLButtonElement | null)?.closest('[role="dialog"]')?.remove()
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
      />
    )

    const ta = screen.getByRole('combobox', { name: 'Instruction' })
    ta.textContent = '\n\n\n\n\n\n\n\n\n\n'
    fireEvent.input(ta)

    // Whitespace-only input normalizes to an empty draft — the controlled DOM
    // re-renders empty so invisible blank lines never stretch the composer body.
    await waitFor(() => {
      expect(ta.textContent).toBe('')
    })
    // No key for any engine yet: the mic offers setup rather than a take.
    expect(screen.getByRole('button', { name: 'Set up dictation' })).toBeTruthy()
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
      />
    )

    const ta = screen.getByRole('combobox', { name: 'Instruction' })
    ta.textContent = 'first message'
    fireEvent.input(ta)
    fireEvent.keyDown(ta, { key: 'Enter' })
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
      />
    )

    fireEvent.submit(screen.getByRole('combobox', { name: 'Instruction' }).closest('form')!)

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
      />
    )

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['pixels'], 'shot.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    fireEvent.change(fileInput)

    await waitFor(() => {
      expect(screen.getByAltText(/Image 1/i)).toBeTruthy()
    })

    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-model-picker]')!)
    await waitFor(() => {
      const listbox = screen.getByRole('listbox', { name: 'Models' })
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
      />
    )

    const ta = screen.getByRole('combobox', { name: 'Instruction' })
    ta.textContent = 'read the attachment'
    fireEvent.input(ta)
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['pending'], 'pending.md', { type: 'text/markdown' })
    Object.defineProperty(fileInput, 'files', { value: [file] })
    fireEvent.change(fileInput)
    await waitFor(() => expect(window.vyotiq.extractAttachment).toHaveBeenCalled())

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

    fireEvent.submit(document.querySelector('[data-composer-shell]')!)
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

  it('keeps the line editable while a run is in progress, with no Send or Stop button', () => {
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
      />
    )

    const ta = screen.getByRole('combobox', { name: 'Instruction' })
    expect(ta.getAttribute('contenteditable')).toBe('true')
    expect(screen.queryByRole('button', { name: /^Stop$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Send$/i })).toBeNull()
  })

  it('keeps mode and model controls enabled while a run is in progress', async () => {
    const onAgentModeChange = vi.fn()
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
        onSend={vi.fn()}
      />
    )

    // Mode is its own switch in the control row; a live run leaves it settable.
    const modes = screen.getByRole('radiogroup', { name: 'Mode' })
    fireEvent.click(within(modes).getByRole('radio', { name: 'Ask' }))
    expect(onAgentModeChange).toHaveBeenCalledWith('ask')

    const picker = document.querySelector<HTMLButtonElement>('[data-model-picker]')!
    expect(picker).toHaveProperty('disabled', false)
    fireEvent.click(picker)
    const dialog = await screen.findByRole('dialog', { name: 'Model and effort' })
    // The model rows load after the list opens; a busy suite catches the gap.
    fireEvent.click(await within(dialog).findByText('llama3.2'))
    expect(onProviderModel).toHaveBeenCalledWith('ollama', 'llama3.2')
  })

  it('focuses an inline composer when it mounts for prompt editing', () => {
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        hasWorkspace
        variant="inline"
        draft="Edit this prompt"
        onDraftChange={vi.fn()}
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onCancelEdit={vi.fn()}
      />
    )

    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Instruction' }))
  })

  it('cancels inline edit on Escape when no menu consumed it', () => {
    const onCancelEdit = vi.fn()
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        hasWorkspace
        variant="inline"
        draft="Edit this prompt about SessionChatColumn file open wiring"
        onDraftChange={vi.fn()}
        secrets={testSecrets}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
        onCancelEdit={onCancelEdit}
      />
    )

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Instruction' }), { key: 'Escape' })
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
      />
    )

    const ta = screen.getByRole('combobox', { name: 'Instruction' })
    ta.textContent = 'steer left'
    fireEvent.input(ta)
    fireEvent.keyDown(ta, { key: 'Enter', code: 'Enter' })

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('steer left', undefined, undefined, undefined)
    })
  })

  it('shows queued instructions with edit, send now, and remove', async () => {
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
        pendingFollowUps={[
          { id: 'fu-1', itemId: 'item-1', preview: 'Steer left', text: 'Steer left' }
        ]}
        onRemoveFollowUp={onRemoveFollowUp}
        onEditFollowUp={onEditFollowUp}
        onSendFollowUpNow={onSendFollowUpNow}
      />
    )

    expect(screen.getByText('Steer left')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Edit queued instruction$/i }))
    const editor = screen.getByRole('textbox', { name: /^Edit queued instruction$/i })
    fireEvent.change(editor, { target: { value: 'Steer right' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save queued instruction edit$/i }))
    await waitFor(() => {
      expect(onEditFollowUp).toHaveBeenCalledWith('fu-1', 'Steer right')
    })

    fireEvent.click(screen.getByRole('button', { name: /^Send queued instruction now$/i }))
    expect(onSendFollowUpNow).toHaveBeenCalledWith('fu-1')

    fireEvent.click(screen.getByRole('button', { name: /^Remove queued instruction$/i }))
    expect(onRemoveFollowUp).toHaveBeenCalledWith('fu-1')
  })

  it('keeps the queued instruction editor open when save fails', async () => {
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
        pendingFollowUps={[
          { id: 'fu-1', itemId: 'item-1', preview: 'Steer left', text: 'Steer left' }
        ]}
        onEditFollowUp={onEditFollowUp}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Edit queued instruction$/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Save queued instruction edit$/i }))
    await waitFor(() => {
      expect(onEditFollowUp).toHaveBeenCalledWith('fu-1', 'Steer left')
    })
    expect(screen.getByRole('textbox', { name: /^Edit queued instruction$/i })).toBeTruthy()
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
      />
    )

    expect(screen.queryByText(/Reconnecting/i)).toBeNull()
  })

  it('sends the per-run hot draft even if the draft prop is empty', async () => {
    setWorkspaceHotComposerDraft('/ws/demo', 'run-1', 'I have a typed message')
    const onSend = vi.fn(async () => true)
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
        onSend={onSend}
      />
    )

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Instruction' }), { key: 'Enter' })
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith('I have a typed message', undefined, undefined, undefined)
    })
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
