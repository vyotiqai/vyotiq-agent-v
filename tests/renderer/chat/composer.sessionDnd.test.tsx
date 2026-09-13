/**
 * @vitest-environment jsdom
 *
 * Regression: a sidebar session drag hovering/dropping over the composer's
 * attachment surface must never open the attachment picker or attach files.
 * The composer bails via isSessionDragEvent() before the Files branch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEvent, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer/Composer'
import {
  SESSION_DRAG_MIME,
  markSessionDragEnd,
  markSessionDragStart,
  writeSessionDragPayload,
  type SessionDragPayload
} from '@renderer/lib/chat/chatPaneLayout'
import {
  composerAttachmentKey,
  getComposerAttachments,
  resetComposerAttachmentStoreForTests
} from '@renderer/lib/hooks/composerAttachmentStore'
import { emptySecretStatus } from '@shared/ipc/types/secrets'

const WORKSPACE = '/ws/a'
const RUN_ID = 'run-1'
const ATTACH_KEY = composerAttachmentKey(WORKSPACE, RUN_ID)!

const PAYLOAD: SessionDragPayload = { workspacePath: '/ws/b', runId: 'run-b' }
const PAYLOAD_RAW = JSON.stringify(PAYLOAD)

const CHAT_SETTINGS = {
  provider: 'anthropic' as const,
  model: 'test-model',
  ollamaBaseUrl: '',
  customOpenAiBaseUrl: '',
  keepRecentTurns: 20,
  autoCompactThresholdRatio: 0.8,
  thinkingEnabled: false,
  thinkingEffort: 'medium' as const,
  showThinking: false,
  toolApproval: 'ask' as const,
  agentPersona: 'engineer' as const,
  agentTone: 'concise' as const,
  responseLanguage: 'en' as const,
  responseVerbosity: 'normal' as const
}

function makeImageFile(): File {
  return new File(['hello'], 'pic.png', { type: 'image/png' })
}

/** DataTransfer stub in the chatPaneHost.drop.test.tsx style, plus files + setData support. */
function makeDataTransfer(init: {
  types: string[]
  payload?: string
  files?: File[]
}): DataTransfer {
  const store = new Map<string, string>()
  if (init.payload !== undefined) {
    store.set('text/plain', init.payload)
    store.set(SESSION_DRAG_MIME, init.payload)
  }
  const stub = {
    types: init.types,
    files: init.files ?? [],
    items: [],
    effectAllowed: 'copy',
    dropEffect: 'move',
    getData: (type: string): string => store.get(type) ?? '',
    setData: (type: string, value: string): void => {
      store.set(type, value)
    }
  }
  return stub as unknown as DataTransfer
}

function renderComposer(): { shell: HTMLElement } {
  render(
    <Composer
      provider={CHAT_SETTINGS.provider}
      model={CHAT_SETTINGS.model}
      running={false}
      secrets={emptySecretStatus()}
      onProviderModel={() => {}}
      chatSettings={CHAT_SETTINGS}
      onChatSettingsChange={() => {}}
      onSend={() => true}
      onStop={() => {}}
      workspacePath={WORKSPACE}
      activeRunId={RUN_ID}
    />
  )
  const shell = document.querySelector('[data-composer-shell]')
  if (!shell) throw new Error('composer shell not rendered')
  return { shell: shell as HTMLElement }
}

function fireDragOver(shell: HTMLElement, dt: DataTransfer): Event {
  const event = createEvent.dragOver(shell, { dataTransfer: dt })
  fireEvent(shell, event)
  return event
}

function fireDrop(shell: HTMLElement, dt: DataTransfer): Event {
  const event = createEvent.drop(shell, { dataTransfer: dt })
  fireEvent(shell, event)
  return event
}

function attachmentSnapshot(): {
  images: string[]
  files: unknown[]
  nativeFiles: unknown[]
} {
  const a = getComposerAttachments(ATTACH_KEY)
  return { images: a.images, files: a.files, nativeFiles: a.nativeFiles }
}

const EMPTY_SNAPSHOT = { images: [], files: [], nativeFiles: [] }

describe('Composer × session drag-and-drop', () => {
  beforeEach(() => {
    // jsdom has no preload bridge — fake the surface (dictation guards typeof).
    ;(window as unknown as { vyotiq: Record<string, unknown> }).vyotiq = {}
  })

  afterEach(() => {
    cleanup()
    markSessionDragEnd()
    resetComposerAttachmentStoreForTests()
    window.localStorage.clear()
  })

  it('never attaches while a session drag is active (flag + custom MIME payload)', () => {
    const { shell } = renderComposer()
    markSessionDragStart()

    const dt = makeDataTransfer({
      types: [SESSION_DRAG_MIME, 'text/plain'],
      payload: PAYLOAD_RAW
    })
    writeSessionDragPayload(dt, PAYLOAD)

    const over = fireDragOver(shell, dt)
    expect(over.defaultPrevented).toBe(false)
    expect(dt.dropEffect).not.toBe('copy')

    const drop = fireDrop(shell, dt)
    expect(drop.defaultPrevented).toBe(false)
    expect(attachmentSnapshot()).toEqual(EMPTY_SNAPSHOT)

    // dragleave cleanup leaves no state behind either.
    fireEvent.dragLeave(shell, { dataTransfer: dt })
    expect(attachmentSnapshot()).toEqual(EMPTY_SNAPSHOT)
  })

  it('never attaches with only the custom session MIME present, flag cleared', () => {
    markSessionDragEnd()
    const { shell } = renderComposer()

    const dt = makeDataTransfer({ types: [SESSION_DRAG_MIME], payload: PAYLOAD_RAW })
    writeSessionDragPayload(dt, PAYLOAD)

    const over = fireDragOver(shell, dt)
    expect(over.defaultPrevented).toBe(false)

    const drop = fireDrop(shell, dt)
    expect(drop.defaultPrevented).toBe(false)
    expect(attachmentSnapshot()).toEqual(EMPTY_SNAPSHOT)
  })

  it('bails on the session payload before the Files branch (Electron quirk)', () => {
    markSessionDragStart()
    const { shell } = renderComposer()

    // types carries Files + text/plain only — the custom MIME is hidden by the
    // Electron dragover quirk, but the active flag + text/plain still bails.
    const dt = makeDataTransfer({
      types: ['Files', 'text/plain'],
      payload: PAYLOAD_RAW,
      files: [makeImageFile()]
    })
    writeSessionDragPayload(dt, PAYLOAD)

    const over = fireDragOver(shell, dt)
    expect(over.defaultPrevented).toBe(false)

    const drop = fireDrop(shell, dt)
    expect(drop.defaultPrevented).toBe(false)
    expect(attachmentSnapshot()).toEqual(EMPTY_SNAPSHOT)
  })

  it('control: Files drop with no session payload attaches the file', async () => {
    const { shell } = renderComposer()

    const dt = makeDataTransfer({ types: ['Files'], files: [makeImageFile()] })
    const over = fireDragOver(shell, dt)
    expect(over.defaultPrevented).toBe(true)
    expect(dt.dropEffect).toBe('copy')

    const drop = fireDrop(shell, dt)
    expect(drop.defaultPrevented).toBe(true)

    await waitFor(() => {
      expect(getComposerAttachments(ATTACH_KEY).images).toHaveLength(1)
    })
  })
})
