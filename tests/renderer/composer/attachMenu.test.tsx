/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { browserSnapshotArtifactName } from '@renderer/features/chat/components/composer/AttachMenu'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import { resetWorkspaceHotUiStoreForTests } from '@renderer/lib/hooks/workspaceHotUiStore'
import { resetComposerAttachmentStoreForTests } from '@renderer/lib/hooks/composerAttachmentStore'

// Only the fields the composer reads; the rest of the settings are not its business.
const chatSettings = {
  provider: 'ollama',
  model: 'qwen2.5',
  keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
  thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
  thinkingEffort: DEFAULT_SETTINGS.thinkingEffort,
  showThinking: DEFAULT_SETTINGS.showThinking
} as EffectiveChatSettings

const SHOT = 'data:image/jpeg;base64,/9j/AAAA'

let browserUrl = 'https://example.com/'

beforeEach(() => {
  browserUrl = 'https://example.com/'
  window.vyotiq = {
    listModels: vi.fn(async () => ({
      ok: true as const,
      data: {
        models: [{ id: 'qwen2.5', inputModalities: ['text', 'image'], outputModalities: ['text'], supportsTools: true, supportsVision: true }],
        warning: null
      }
    })),
    browserGetState: vi.fn(async () => ({ ok: true as const, data: { open: true, url: browserUrl, title: 'Example' } })),
    browserTakeScreenshot: vi.fn(async () => ({
      ok: true as const,
      data: { path: 'C:\\data\\sessions\\run-1\\browser\\snapshot-1700000000000-1.jpg' }
    })),
    readRunArtifact: vi.fn(async (payload: { name: string }) => ({
      ok: true as const,
      data: { name: payload.name, exists: true, content: SHOT }
    }))
  } as unknown as typeof window.vyotiq
})

afterEach(() => {
  cleanup()
  resetWorkspaceHotUiStoreForTests()
  resetComposerAttachmentStoreForTests()
})

function renderLine(props: { workspacePath?: string; activeRunId?: string } = {}) {
  return render(
    <Composer
      provider="ollama"
      model="qwen2.5"
      running={false}
      hasWorkspace
      secrets={emptySecretStatus()}
      chatSettings={chatSettings}
      onChatSettingsChange={vi.fn()}
      onProviderModel={vi.fn()}
      onSend={vi.fn()}
      {...props}
    />
  )
}

const openAttach = (): void => {
  fireEvent.click(screen.getByRole('button', { name: /^Attach files/ }))
}

describe('Attach menu', () => {
  it('opens a menu of Files and Image, each on its own picker', async () => {
    renderLine()
    const [files, images] = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'))
    expect(files!.accept).toContain('.pdf')
    expect(images!.accept).toBe('image/*')
    const filesClick = vi.spyOn(files!, 'click').mockImplementation(() => {})
    const imagesClick = vi.spyOn(images!, 'click').mockImplementation(() => {})

    openAttach()
    const menu = await screen.findByRole('menu', { name: 'Attach' })
    expect(menu.textContent).toContain('Files…')
    expect(menu.textContent).toContain('Image…')
    // No run to keep a capture with: no screenshot entry.
    expect(screen.queryByRole('menuitem', { name: /Browser tab/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Files…' }))
    expect(filesClick).toHaveBeenCalledTimes(1)

    openAttach()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Image…' }))
    expect(imagesClick).toHaveBeenCalledTimes(1)
  })

  it('attaches a screenshot of the Browser tab, saved with the run and read back', async () => {
    renderLine({ workspacePath: '/ws/shot', activeRunId: 'run-1' })
    openAttach()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Screenshot of the Browser tab' }))

    await waitFor(() =>
      expect(window.vyotiq.readRunArtifact).toHaveBeenCalledWith({
        workspacePath: '/ws/shot',
        runId: 'run-1',
        name: 'browser/snapshot-1700000000000-1.jpg'
      })
    )
    expect(window.vyotiq.browserTakeScreenshot).toHaveBeenCalledWith({ workspacePath: '/ws/shot', runId: 'run-1' })
    expect((await screen.findByRole('img', { name: 'Image 1' })).getAttribute('src')).toBe(SHOT)
  })

  it('asks nothing before the capture, and says so when this workspace has no page', async () => {
    // The panel's state can be another workspace's page: only the capture knows this one's.
    window.vyotiq.browserTakeScreenshot = vi.fn(async () => ({ ok: false as const, error: 'No browser page open' })) as never
    renderLine({ workspacePath: '/ws/blank', activeRunId: 'run-2' })
    openAttach()
    const item = await screen.findByRole('menuitem', { name: 'Screenshot of the Browser tab' })
    expect((item as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(item)
    expect(await screen.findByText('No page is open in the Browser tab.')).toBeTruthy()
    expect(window.vyotiq.browserGetState).not.toHaveBeenCalled()
    expect(window.vyotiq.readRunArtifact).not.toHaveBeenCalled()
  })

  it('names the run artifact from the saved path, whichever separator it uses', () => {
    expect(browserSnapshotArtifactName('/u/runs/r/browser/snapshot-12-3.jpg')).toBe('browser/snapshot-12-3.jpg')
    expect(browserSnapshotArtifactName('C:\\u\\browser\\snapshot-9-1.jpg')).toBe('browser/snapshot-9-1.jpg')
    expect(browserSnapshotArtifactName('C:\\u\\browser\\odd name.png')).toBe('browser/snapshot.jpg')
  })
})
