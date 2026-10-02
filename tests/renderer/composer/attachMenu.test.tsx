/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { Composer } from '@renderer/features/chat/components/composer'
import { browserSnapshotArtifactName } from '@renderer/features/chat/components/composer/AttachMenu'
import { DEFAULT_SETTINGS, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import { resetWorkspaceHotUiStoreForTests, setWorkspaceHotComposerDraft } from '@renderer/lib/hooks/workspaceHotUiStore'
import { resetComposerAttachmentStoreForTests } from '@renderer/lib/hooks/composerAttachmentStore'

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

  it('leaves the capture to say when this workspace has no page, while another one has', async () => {
    // The panel's state can be another workspace's page: only the capture knows this one's.
    window.vyotiq.browserTakeScreenshot = vi.fn(async () => ({ ok: false as const, error: 'No browser page open' })) as never
    renderLine({ workspacePath: '/ws/blank', activeRunId: 'run-2' })
    await waitFor(() => expect(window.vyotiq.browserGetState).toHaveBeenCalled())
    openAttach()
    const item = await screen.findByRole('menuitem', { name: 'Screenshot of the Browser tab' })
    expect((item as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(item)
    expect(await screen.findByText('No page is open in the Browser tab.')).toBeTruthy()
    expect(window.vyotiq.readRunArtifact).not.toHaveBeenCalled()
  })

  it('lists the screenshot as unavailable, with why, when the Browser tab has no page at all', async () => {
    let push: ((state: { open: boolean; url: string; title: string }) => void) | null = null
    window.vyotiq.browserGetState = vi.fn(async () => ({ ok: true as const, data: { open: false, url: '', title: '' } })) as never
    window.vyotiq.onBrowserState = vi.fn((handler) => {
      push = handler as typeof push
      return () => {}
    }) as never
    renderLine({ workspacePath: '/ws/none', activeRunId: 'run-3' })
    await waitFor(() => expect(window.vyotiq.browserGetState).toHaveBeenCalled())
    openAttach()
    const item = (await screen.findByRole('menuitem', { name: 'Screenshot of the Browser tab' })) as HTMLButtonElement
    await waitFor(() => expect(item.disabled).toBe(true))
    expect(item.title).toBe('Open a page in the Browser tab first')
    fireEvent.click(item)
    expect(window.vyotiq.browserTakeScreenshot).not.toHaveBeenCalled()

    // A page opens: the entry is choosable again.
    act(() => push!({ open: true, url: 'https://example.com/', title: 'Example' }))
    await waitFor(() =>
      expect((screen.getByRole('menuitem', { name: 'Screenshot of the Browser tab' }) as HTMLButtonElement).disabled).toBe(false)
    )
  })

  /** The real parent keeps the draft in the hot store and hands it back. */
  function renderWithDraft(): ReturnType<typeof vi.fn> {
    const WS = '/ws/mention'
    window.vyotiq.workspaceSuggestPaths = vi.fn(async () => ({
      ok: true as const,
      data: { paths: ['src/main.ts'], dirs: [], total: 1 }
    })) as never
    window.vyotiq.gitStatus = vi.fn(async () => ({ ok: true as const, data: { kind: 'not_repo' as const } })) as never
    const onDraftChange = vi.fn()
    function Harness() {
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

  it('ends with Mention a file, which types @ in the box and opens the mention menu', async () => {
    const onDraftChange = renderWithDraft()
    openAttach()
    const menu = await screen.findByRole('menu', { name: 'Attach' })
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'))
    const mention = screen.getByRole('menuitem', { name: 'Mention a file' })
    expect(items[items.length - 1]).toBe(mention)
    // The key that does the same, as a keycap — seen, not part of the name.
    expect(mention.querySelector('kbd')?.textContent).toBe('@')
    fireEvent.click(mention)

    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith('@'))
    const listbox = await screen.findByRole('listbox', { name: 'Mentions' }, { timeout: 4000 })
    await waitFor(() => within(listbox).getByRole('option', { name: /main\.ts/ }), { timeout: 4000 })
    const box = screen.getByRole('combobox', { name: 'Instruction' })
    expect(box.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(box)
  })

  it('puts a space before the @ when the caret is right after a word', async () => {
    const onDraftChange = renderWithDraft()
    const box = screen.getByRole('combobox', { name: 'Instruction' })
    box.textContent = 'Fix'
    box.focus()
    const caret = document.createRange()
    caret.selectNodeContents(box)
    caret.collapse(false)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(caret)
    fireEvent.input(box)
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith('Fix'))

    openAttach()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mention a file' }))
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith('Fix @'))
    expect(await screen.findByRole('listbox', { name: 'Mentions' }, { timeout: 4000 })).toBeTruthy()
  })

  it('names the run artifact from the saved path, whichever separator it uses', () => {
    expect(browserSnapshotArtifactName('/u/runs/r/browser/snapshot-12-3.jpg')).toBe('browser/snapshot-12-3.jpg')
    expect(browserSnapshotArtifactName('C:\\u\\browser\\snapshot-9-1.jpg')).toBe('browser/snapshot-9-1.jpg')
    expect(browserSnapshotArtifactName('C:\\u\\browser\\odd name.png')).toBe('browser/snapshot.jpg')
  })
})
