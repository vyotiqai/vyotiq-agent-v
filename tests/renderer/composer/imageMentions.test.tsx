/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { mentionMarker } from '@renderer/features/chat/components/composer/mentionModel'
import {
  draftHasImageMention,
  resolveComposerMentions
} from '@renderer/features/chat/components/composer/resolveMentions'
import { DEFAULT_SETTINGS, MAX_IMAGE_DATA_URL_CHARS, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import { resetWorkspaceHotUiStoreForTests } from '@renderer/lib/hooks/workspaceHotUiStore'

const file = (path: string) => mentionMarker({ kind: 'file', path })
const dataUrlFor = (path: string) => `data:image/png;base64,${btoa(path)}`

let readImage: ReturnType<typeof vi.fn>
let readText: ReturnType<typeof vi.fn>

beforeEach(() => {
  readImage = vi.fn(async ({ path }: { path: string }) => ({
    ok: true as const,
    data: { mime: 'image/png', dataUrl: dataUrlFor(path) }
  }))
  readText = vi.fn(async ({ path }: { path: string }) => ({
    ok: true as const,
    data: { name: path, mime: 'text/plain', text: `content of ${path}`, truncated: false }
  }))
  // @ts-expect-error partial test bridge
  window.vyotiq = { workspaceReadImage: readImage, workspaceReadText: readText }
})

afterEach(() => {
  cleanup()
  resetWorkspaceHotUiStoreForTests()
})

describe('@-mentioned workspace images', () => {
  it('go as images the model can see, named in the text', async () => {
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft: `What is wrong in ${file('docs/shot.png')}?`,
      existingFiles: []
    })
    expect(result.error).toBeNull()
    expect(readImage).toHaveBeenCalledWith({ workspacePath: '/ws', path: 'docs/shot.png' })
    expect(readText).not.toHaveBeenCalled()
    expect(result.images).toEqual([dataUrlFor('docs/shot.png')])
    expect(result.files).toEqual([])
    expect(result.text).toContain('Attached image: docs/shot.png')
  })

  it('join images already attached, once each, and name them all', async () => {
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft: `${file('a.png')} vs ${file('ui/b.JPG')} and again ${file('a.png')}`,
      existingFiles: [],
      existingImages: ['data:image/png;base64,pasted']
    })
    expect(result.images).toEqual(['data:image/png;base64,pasted', dataUrlFor('a.png'), dataUrlFor('ui/b.JPG')])
    expect(readImage).toHaveBeenCalledTimes(2)
    expect(result.text).toContain('Attached images:\n- a.png\n- ui/b.JPG')
  })

  it('keep the image limit a picked image has', async () => {
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft: `look ${file('five.png')}`,
      existingFiles: [],
      existingImages: ['i1', 'i2', 'i3', 'i4']
    })
    expect(readImage).not.toHaveBeenCalled()
    expect(result.images).toHaveLength(4)
    expect(result.error).toMatch(/Image limit \(4\) — skipped five\.png/)
  })

  it('refuse an image over the size cap, and say why a read failed', async () => {
    readImage.mockResolvedValueOnce({
      ok: true as const,
      data: { mime: 'image/png', dataUrl: `data:image/png;base64,${'A'.repeat(MAX_IMAGE_DATA_URL_CHARS)}` }
    })
    readImage.mockResolvedValueOnce({ ok: false as const, error: 'Path is outside the workspace' })
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft: `${file('huge.png')} ${file('gone.png')}`,
      existingFiles: []
    })
    expect(result.images).toEqual([])
    expect(result.error).toMatch(/huge\.png is over 12MB/)
    expect(result.error).toMatch(/Path is outside the workspace/)
  })

  it('leave SVG and source files as text attachments', async () => {
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft: `${file('icons/logo.svg')} ${file('src/a.ts')}`,
      existingFiles: []
    })
    expect(readImage).not.toHaveBeenCalled()
    expect(result.files.map((f) => f.name)).toEqual(['icons/logo.svg', 'src/a.ts'])
    expect(result.images).toEqual([])
  })

  it('are recognised in a draft', () => {
    expect(draftHasImageMention(`see ${file('a.webp')}`)).toBe(true)
    expect(draftHasImageMention(`see ${file('a.svg')} ${file('b.ts')}`)).toBe(false)
  })
})

describe('Composer with an @-mentioned image', () => {
  // Only what the composer reads; the rest of the effective settings do not matter here.
  const chatSettings = {
    provider: 'ollama',
    model: 'qwen2.5',
    keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
    thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
    thinkingEffort: DEFAULT_SETTINGS.thinkingEffort,
    showThinking: DEFAULT_SETTINGS.showThinking
  } as EffectiveChatSettings

  it('moves to a vision model and sends the image', async () => {
    // @ts-expect-error partial test bridge
    window.vyotiq.listModels = vi.fn(async () => ({
      ok: true as const,
      data: {
        models: [
          { id: 'qwen2.5', inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsVision: false },
          { id: 'llava', inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsVision: true }
        ],
        warning: null
      }
    }))
    const onProviderModel = vi.fn()
    const onSend = vi.fn(async () => true)
    render(
      <Composer
        provider="ollama"
        model="qwen2.5"
        running={false}
        hasWorkspace
        workspacePath="/ws"
        draft={`Fix this ${file('docs/shot.png')}`}
        onDraftChange={vi.fn()}
        secrets={emptySecretStatus()}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        onProviderModel={onProviderModel}
        onSend={onSend}
      />
    )

    await waitFor(() => expect(onProviderModel).toHaveBeenCalledWith('ollama', 'llava'))

    fireEvent.submit(screen.getByRole('combobox', { name: 'Instruction' }).closest('form')!)
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    const [text, images, files] = onSend.mock.calls[0] as unknown as [string, string[] | undefined, unknown]
    expect(images).toEqual([dataUrlFor('docs/shot.png')])
    expect(files).toBeUndefined()
    expect(text).toContain('Attached image: docs/shot.png')
  })
})
