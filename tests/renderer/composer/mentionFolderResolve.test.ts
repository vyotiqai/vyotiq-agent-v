/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, createRef } from 'react'
import { render } from '@testing-library/react'
import { resolveComposerMentions } from '@renderer/features/chat/components/composer/resolveMentions'
import {
  ComposerMentionInput,
  type ComposerMentionInputHandle
} from '@renderer/features/chat/components/composer/ComposerMentionInput'
import { mentionMarker } from '@renderer/features/chat/components/composer/mentionModel'
import { folderIconUrl } from '@renderer/lib/fileIcons'

/**
 * A folder mention resolves to a listing of the directory. Every way that can
 * fail must reach the caller as an error, not as a silently empty context
 * block that reads like an empty folder.
 */

function entry(path: string, kind: 'file' | 'directory' = 'file') {
  return {
    name: path.split('/').pop() ?? path,
    path,
    kind,
    size: 1,
    mtimeMs: 0,
    hidden: false,
    symlinkTargetInsideWorkspace: null
  }
}

const FOLDER_DRAFT = `Review ${mentionMarker({ kind: 'folder', path: 'src/features' })}`

describe('folder mention resolve', () => {
  beforeEach(() => {
    window.vyotiq = {
      workspaceReadText: vi.fn(async ({ path }: { path: string }) => ({
        ok: true as const,
        data: {
          name: path,
          mime: 'text/plain',
          text: 'body',
          truncated: false
        }
      })),
      workspaceFileList: vi.fn(async () => ({
        ok: true as const,
        data: {
          path: 'src/features',
          entries: [
            entry('src/features/chat', 'directory'),
            entry('src/features/tasks')
          ],
          total: 2,
          nextOffset: null,
          truncated: false
        }
      }))
    } as unknown as typeof window.vyotiq
  })

  it('lists the directory entries, marking sub-directories with a slash', async () => {
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft: FOLDER_DRAFT,
      existingFiles: []
    })
    expect(result.text).toContain('## Referenced folder')
    expect(result.text).toContain('Path: src/features')
    expect(result.text).toContain('Entries: 2 shown of 2')
    expect(result.text).toContain('- src/features/chat/')
    expect(result.text).toContain('- src/features/tasks')
    expect(result.error).toBeNull()
    // Nothing is attached: a folder is context, not a file.
    expect(result.files).toEqual([])
  })

  it('never reads the folder as a file', async () => {
    await resolveComposerMentions({
      workspacePath: '/ws',
      draft: FOLDER_DRAFT,
      existingFiles: []
    })
    expect(window.vyotiq.workspaceReadText).not.toHaveBeenCalled()
  })

  it('says so when there is no workspace to list', async () => {
    const result = await resolveComposerMentions({
      workspacePath: null,
      draft: FOLDER_DRAFT,
      existingFiles: []
    })
    expect(result.error).toBe('Cannot list folder src/features (no workspace)')
    expect(result.text).not.toContain('Referenced folder')
    expect(window.vyotiq.workspaceFileList).not.toHaveBeenCalled()
  })

  it('passes a failed listing through instead of an empty block', async () => {
    ;(window.vyotiq.workspaceFileList as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: 'Workspace is not open'
    })
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft: FOLDER_DRAFT,
      existingFiles: []
    })
    expect(result.error).toBe('Workspace is not open')
    expect(result.text).not.toContain('Referenced folder')
  })

  it('passes a thrown listing through with its message', async () => {
    ;(window.vyotiq.workspaceFileList as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('IPC channel closed')
    )
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft: FOLDER_DRAFT,
      existingFiles: []
    })
    expect(result.error).toBe('Cannot list folder src/features: IPC channel closed')
    expect(result.text).not.toContain('Referenced folder')
  })

  it('reports an empty folder as empty rather than failing', async () => {
    ;(window.vyotiq.workspaceFileList as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: {
        path: 'src/features',
        entries: [],
        total: 0,
        nextOffset: null,
        truncated: false
      }
    })
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft: FOLDER_DRAFT,
      existingFiles: []
    })
    expect(result.text).toContain('Entries: 0 shown of 0')
    expect(result.text).toContain('(empty folder)')
    expect(result.error).toBeNull()
  })

  it('flags a truncated listing so a partial list is not read as the whole folder', async () => {
    ;(window.vyotiq.workspaceFileList as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: {
        path: 'src/features',
        entries: [entry('src/features/a.ts')],
        total: 900,
        nextOffset: 1,
        truncated: true
      }
    })
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft: FOLDER_DRAFT,
      existingFiles: []
    })
    expect(result.text).toContain('Entries: 1 shown of 900 (truncated)')
  })

  it('caps the listing rows it pastes in', async () => {
    const entries = Array.from({ length: 60 }, (_, i) => entry(`src/features/f${i}.ts`))
    ;(window.vyotiq.workspaceFileList as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      data: {
        path: 'src/features',
        entries,
        total: entries.length,
        nextOffset: null,
        truncated: false
      }
    })
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft: FOLDER_DRAFT,
      existingFiles: []
    })
    expect(result.text).toContain('Entries: 60 shown of 60')
    expect(result.text).toContain('- src/features/f0.ts')
    expect(result.text).not.toContain('- src/features/f59.ts')
    expect(result.text).toContain('…')
  })

  it('rejects a folder path that escapes the workspace', async () => {
    // decode drops an unsafe folder payload, so resolve never sees it.
    const unsafe = await resolveComposerMentions({
      workspacePath: '/ws',
      draft: '\uFFF9folder:../secret\uFFFA',
      existingFiles: []
    })
    expect(unsafe.files).toEqual([])
    expect(window.vyotiq.workspaceFileList).not.toHaveBeenCalled()
  })
})

describe('folder mention chip', () => {
  it('draws a folder chip with its folder image and its basename', () => {
    const ref = createRef<ComposerMentionInputHandle>()
    const value = mentionMarker({ kind: 'folder', path: 'src/components/composer' })
    // createElement, not JSX: this file is .ts, and its name is fixed.
    render(
      createElement(ComposerMentionInput, {
        ref,
        value,
        onChange: vi.fn(),
        onKeyDown: vi.fn()
      })
    )
    const chip = ref.current!.el!.querySelector<HTMLElement>('[data-mention-kind="folder"]')!
    expect(chip).toBeTruthy()
    expect(chip.textContent).toBe('composer')
    // The folder icon set, not the file one.
    const img = chip.querySelector('img')
    expect(img).toBeTruthy()
    expect(img!.getAttribute('src')).toBe(folderIconUrl('src/components/composer'))
    expect(img!.getAttribute('aria-hidden')).toBe('true')
    expect(chip.dataset.mention).toBe('folder:src/components/composer')
  })
})
