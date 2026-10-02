/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { Composer } from '@renderer/features/chat/components/composer'
import {
  appendInstructionToDraft,
  draftIntoComposer
} from '@renderer/features/chat/components/composer/composerMentionEvent'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import { resetWorkspaceHotUiStoreForTests, setWorkspaceHotComposerDraft } from '@renderer/lib/hooks/workspaceHotUiStore'
import { resetComposerAttachmentStoreForTests } from '@renderer/lib/hooks/composerAttachmentStore'

/**
 * Review's "Ask it to cover this" drafts the instruction into the task's box,
 * to read and edit before it goes — never into another task's.
 */

// The fields the line composer reads; the rest of the effective settings never reach it here.
const chatSettings = {
  provider: 'ollama',
  model: 'qwen2.5',
  keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
  thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
  thinkingEffort: DEFAULT_SETTINGS.thinkingEffort,
  showThinking: DEFAULT_SETTINGS.showThinking
} as EffectiveChatSettings

const WS = '/ws/draft'

beforeEach(() => {
  window.vyotiq = {
    listModels: vi.fn(async () => ({ ok: true as const, data: { models: [], warning: null } })),
    gitStatus: vi.fn(async () => ({ ok: true as const, data: { kind: 'not_repo' as const } }))
  } as unknown as typeof window.vyotiq
})

afterEach(() => {
  cleanup()
  resetWorkspaceHotUiStoreForTests()
  resetComposerAttachmentStoreForTests()
})

function renderLine(initial = ''): ReturnType<typeof vi.fn> {
  const onDraftChange = vi.fn()
  function Harness() {
    const [draft, setDraft] = useState(initial)
    return (
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        hasWorkspace
        workspacePath={WS}
        activeRunId="r1"
        draft={draft}
        onDraftChange={(next) => {
          setDraft(next)
          setWorkspaceHotComposerDraft(WS, 'r1', next)
          onDraftChange(next)
        }}
        secrets={emptySecretStatus()}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={vi.fn()}
        onSend={vi.fn()}
      />
    )
  }
  render(<Harness />)
  return onDraftChange
}

describe('drafting into the composer', () => {
  it('puts the instruction in the task’s box and focuses it there', async () => {
    const onDraftChange = renderLine()
    let taken = false
    act(() => {
      taken = draftIntoComposer({ workspacePath: WS, runId: 'r1', text: 'Cover the empty body case.' })
    })
    expect(taken).toBe(true)
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith('Cover the empty body case.'))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Instruction' })))
  })

  it('keeps what was already typed, with the instruction after a blank line', async () => {
    const onDraftChange = renderLine('Also check the logs.')
    act(() => {
      draftIntoComposer({ workspacePath: WS, runId: 'r1', text: 'Cover the empty body case.' })
    })
    await waitFor(() =>
      expect(onDraftChange).toHaveBeenLastCalledWith('Also check the logs.\n\nCover the empty body case.')
    )
  })

  it('is not taken by another task’s box, so the caller can send it instead', () => {
    const onDraftChange = renderLine()
    let taken = true
    act(() => {
      taken = draftIntoComposer({ workspacePath: WS, runId: 'other', text: 'Cover it.' })
    })
    expect(taken).toBe(false)
    expect(onDraftChange).not.toHaveBeenCalled()
  })

  it('joins a draft and an instruction with one blank line', () => {
    expect(appendInstructionToDraft('', 'Do it.')).toBe('Do it.')
    expect(appendInstructionToDraft('First.\n\n', 'Do it.')).toBe('First.\n\nDo it.')
  })
})
