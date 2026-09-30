/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { Composer } from '@renderer/features/chat/components/composer'
import { mentionMarker } from '@renderer/features/chat/components/composer/mentionModel'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import {
  resetWorkspaceHotUiStoreForTests,
  setWorkspaceHotComposerDraft
} from '@renderer/lib/hooks/workspaceHotUiStore'

const WS = '/ws'
const FILE_PATH = 'src/main.ts'

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

const testSecrets = emptySecretStatus()

beforeEach(() => {
  window.vyotiq = {
    listModels: vi.fn(async () => ({
      ok: true as const,
      data: { models: [{ id: 'qwen2.5', inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsVision: false }], warning: null }
    })),
    workspaceSuggestPaths: vi.fn(async () => ({
      ok: true as const,
      data: { paths: [FILE_PATH], dirs: [], total: 1 }
    })),
    gitStatus: vi.fn(async () => ({ ok: true as const, data: { kind: 'not_repo' as const } })),
    listRuns: vi.fn(async () => ({ ok: true as const, data: { runs: [] } }))
  } as unknown as typeof window.vyotiq
})

/**
 * Mirrors the real parent: the dock composer reads its draft from the hot UI
 * store (Composer.tsx:254-256) and the parent writes the hot store on every
 * draft change (useWorkspaceManager.ts:2509 setComposerDraftForPane).
 */
function Harness({ onDraftChange }: { onDraftChange: (draft: string) => void }) {
  const [draft, setDraft] = useState('')
  return (
    <Composer
      provider="ollama"
      model="qwen2.5"
      running={false}
      hasWorkspace
      workspacePath={WS}
      draft={draft}
      onDraftChange={(next) => {
        setDraft(next)
        setWorkspaceHotComposerDraft(WS, null, next)
        onDraftChange(next)
      }}
      secrets={testSecrets}
      chatSettings={chatSettings}
      onChatSettingsChange={vi.fn()}
      onProviderModel={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
    />
  )
}

/** Type into the contentEditable field the way a user would, then let React see it. */
function typeIntoComposer(value: string): void {
  const field = screen.getByRole('combobox', { name: 'Instruction' })
  field.textContent = value
  fireEvent.input(field)
}

describe('@ menu file row selection', () => {
  it('picks a file row with the mouse and writes the file chip into the draft', async () => {
    const onDraftChange = vi.fn()
    render(<Harness onDraftChange={onDraftChange} />)

    typeIntoComposer('@ma')

    const listbox = await screen.findByRole('listbox', { name: 'Mentions' }, { timeout: 4000 })
    const row = await waitFor(
      () => within(listbox).getByRole('option', { name: /main\.ts/ }),
      { timeout: 4000 }
    )
    fireEvent.click(row)

    await waitFor(() => expect(onDraftChange).toHaveBeenCalled())
    const last = onDraftChange.mock.calls.at(-1)![0] as string
    expect(last).toContain(mentionMarker({ kind: 'file', path: FILE_PATH }))
  })

  it('picks a file row with the real pointer sequence (mousedown, mouseup, click)', async () => {
    const onDraftChange = vi.fn()
    render(<Harness onDraftChange={onDraftChange} />)

    typeIntoComposer('@ma')
    const listbox = await screen.findByRole('listbox', { name: 'Mentions' }, { timeout: 4000 })
    const row = await waitFor(
      () => within(listbox).getByRole('option', { name: /main\.ts/ }),
      { timeout: 4000 }
    )

    // What a real mouse sends, in order. The row preventDefaults mousedown to
    // hold focus in the field, and useDropdownMenu closes on a document mousedown
    // that lands outside the panel.
    fireEvent.mouseDown(row)
    fireEvent.mouseUp(row)
    fireEvent.click(row)

    await waitFor(() => expect(onDraftChange).toHaveBeenCalled())
    expect(onDraftChange.mock.calls.at(-1)![0] as string).toContain(
      mentionMarker({ kind: 'file', path: FILE_PATH })
    )
  })

  it('shows the reason and no file row when the suggest call fails', async () => {
    ;(window.vyotiq as unknown as { workspaceSuggestPaths: unknown }).workspaceSuggestPaths =
      vi.fn(async () => ({ ok: false as const, error: 'Workspace is not open' }))

    const onDraftChange = vi.fn()
    render(<Harness onDraftChange={onDraftChange} />)

    typeIntoComposer('@')
    const listbox = await screen.findByRole('listbox', { name: 'Mentions' }, { timeout: 4000 })
    // Typing itself is a draft change; only what follows the menu is of interest.
    onDraftChange.mockClear()

    // Into Files and folders: the search runs there and fails. The menu says
    // why rather than reading as "No files match", and offers nothing to pick.
    fireEvent.click(within(listbox).getByRole('option', { name: /Files and folders/ }))
    await waitFor(() => within(listbox).getByText('Workspace is not open'), { timeout: 4000 })
    expect(within(listbox).queryByText('No files match')).toBeNull()
    expect(within(listbox).queryAllByRole('option')).toHaveLength(0)
    expect(onDraftChange).not.toHaveBeenCalled()
  })

  it('searches on a bare @ and lists what it finds, before anything is typed', async () => {
    const onDraftChange = vi.fn()
    render(<Harness onDraftChange={onDraftChange} />)

    typeIntoComposer('@')
    const listbox = await screen.findByRole('listbox', { name: 'Mentions' }, { timeout: 4000 })

    // An empty query is the top of the tree, so a cold composer has real rows.
    await waitFor(() => within(listbox).getByRole('option', { name: /main\.ts/ }), { timeout: 4000 })
    expect(window.vyotiq.workspaceSuggestPaths).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: WS, query: '' })
    )
  })

  it('picks a folder main matched as a folder chip', async () => {
    ;(window.vyotiq as unknown as { workspaceSuggestPaths: unknown }).workspaceSuggestPaths =
      vi.fn(async () => ({
        ok: true as const,
        data: { paths: [], dirs: ['src/components/composer'], total: 0 }
      }))

    const onDraftChange = vi.fn()
    render(<Harness onDraftChange={onDraftChange} />)

    typeIntoComposer('@comp')
    const listbox = await screen.findByRole('listbox', { name: 'Mentions' }, { timeout: 4000 })
    const row = await waitFor(
      () => within(listbox).getByRole('option', { name: /composer/ }),
      { timeout: 4000 }
    )

    fireEvent.click(row)
    await waitFor(() => expect(onDraftChange).toHaveBeenCalled())
    expect(onDraftChange.mock.calls.at(-1)![0] as string).toContain(
      mentionMarker({ kind: 'folder', path: 'src/components/composer' })
    )
  })

  it('picks the active file row with Enter', async () => {
    const onDraftChange = vi.fn()
    render(<Harness onDraftChange={onDraftChange} />)

    typeIntoComposer('@ma')
    const listbox = await screen.findByRole('listbox', { name: 'Mentions' }, { timeout: 4000 })
    await waitFor(() => within(listbox).getByRole('option', { name: /main\.ts/ }), { timeout: 4000 })

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Instruction' }), { key: 'Enter' })

    await waitFor(() => expect(onDraftChange).toHaveBeenCalled())
    expect(onDraftChange.mock.calls.at(-1)![0] as string).toContain(
      mentionMarker({ kind: 'file', path: FILE_PATH })
    )
  })

  it('picks a file row inside the Files and folders view', async () => {
    const onDraftChange = vi.fn()
    render(<Harness onDraftChange={onDraftChange} />)

    typeIntoComposer('@')
    const listbox = await screen.findByRole('listbox', { name: 'Mentions' }, { timeout: 4000 })
    fireEvent.click(within(listbox).getByRole('option', { name: /Files and folders/ }))

    await waitFor(
      () => expect(within(listbox).getByText('Files and folders', { selector: 'span' })).toBeTruthy(),
      { timeout: 4000 }
    )
    const row = await waitFor(
      () => within(listbox).getByRole('option', { name: /main\.ts/ }),
      { timeout: 4000 }
    )
    fireEvent.click(row)

    await waitFor(() => expect(onDraftChange).toHaveBeenCalled())
    expect(onDraftChange.mock.calls.at(-1)![0] as string).toContain(
      mentionMarker({ kind: 'file', path: FILE_PATH })
    )
  })
})
