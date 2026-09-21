/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AgentMemoryListResult, AgentProfile } from '@shared/ipc'

const pushToastMock = vi.hoisted(() => vi.fn())
vi.mock('@renderer/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/ui')>()),
  pushToast: pushToastMock
}))

import { TeammateMemory } from '@renderer/features/teammates/TeammateMemory'
import { resetTeammateMemoryForTests } from '@renderer/lib/hooks/useTeammateMemory'

/**
 * The memory panel.
 *
 * `.vyotiq/agents/<id>/memory/` is what the feature is sold on and had no
 * surface at all — it could not be read, edited or cleared from inside the
 * app, while deleting a teammate deliberately preserved it.
 */

const profile: AgentProfile = {
  id: 'scout',
  name: 'Scout',
  scope: 'global',
  createdAt: '2026-09-18T00:00:00.000Z',
  updatedAt: '2026-09-18T00:00:00.000Z'
} as AgentProfile

let listing: AgentMemoryListResult
let files: Record<string, string>
let writes: { path: string | null; contents?: string }[]

function renderPanel(workspacePath: string | null = '/ws-a'): ReturnType<typeof render> {
  return render(<TeammateMemory profile={profile} workspacePath={workspacePath} />)
}

beforeEach(() => {
  resetTeammateMemoryForTests()
  listing = {
    workspacePath: '/ws-a',
    profileId: 'scout',
    notes: ['arch.md', 'stray.md'],
    indexedNotes: ['arch.md'],
    hasState: true,
    exists: true
  }
  files = {
    'index.md': '# Memory index\n\n- notes/arch.md\n',
    'state.md': 'Halfway through the migration.\n',
    'notes/arch.md': '# Arch\n',
    'notes/stray.md': '# Stray\n'
  }
  writes = []
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
  // @ts-expect-error test bridge
  window.vyotiq = {
    agentMemoryList: vi.fn(async () => ({ ok: true as const, data: listing })),
    agentMemoryRead: vi.fn(async ({ path }: { path: string }) => ({
      ok: true as const,
      data: { path, contents: files[path] ?? '' }
    })),
    agentMemoryWrite: vi.fn(
      async (req: { path: string | null; contents?: string }) => {
        writes.push({ path: req.path, contents: req.contents })
        if (req.path === null) {
          listing = { ...listing, notes: [], indexedNotes: [], hasState: false, exists: false }
        } else if (req.contents !== undefined) {
          files[req.path] = req.contents
        }
        return { ok: true as const, data: listing }
      }
    )
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('teammate memory panel', () => {
  it('lists the fixed files and every note', async () => {
    renderPanel()
    await waitFor(() => expect(screen.getByRole('button', { name: 'index.md' })).toBeTruthy())
    expect(screen.getByRole('button', { name: 'state.md' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'notes/arch.md' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'notes/stray.md' })).toBeTruthy()
  })

  it('flags notes the index does not point at', async () => {
    // index.md is the map the teammate retrieves through, so a note missing
    // from it is on disk but invisible to the run.
    renderPanel()
    await waitFor(() => expect(screen.getByText('1 note not in index.md')).toBeTruthy())
  })

  it('opens index.md first and reads it through', async () => {
    renderPanel()
    await waitFor(() => expect(screen.getByText(/Memory index/)).toBeTruthy())
    expect(window.vyotiq.agentMemoryRead).toHaveBeenCalledWith({
      workspacePath: '/ws-a',
      profileId: 'scout',
      path: 'index.md'
    })
  })

  it('edits and saves one file', async () => {
    renderPanel()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit index.md' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Edit index.md' }))
    fireEvent.change(screen.getByLabelText('index.md contents'), {
      target: { value: '# Rewritten\n' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save index.md' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toEqual({ path: 'index.md', contents: '# Rewritten\n' })
  })

  it('will not save an untouched draft', async () => {
    renderPanel()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit index.md' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Edit index.md' }))

    expect(
      (screen.getByRole('button', { name: 'Save index.md' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('clears the whole namespace behind a confirmation', async () => {
    renderPanel()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear memory' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Clear memory' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear memory' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    // `path: null` is the clear, mirroring the override channel rather than a
    // second destructive channel of its own.
    expect(writes[0]).toEqual({ path: null, contents: undefined })
    await waitFor(() => expect(screen.getByText('Nothing remembered yet')).toBeTruthy())
  })

  it('writes nothing when the confirmation is declined', async () => {
    renderPanel()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear memory' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Clear memory' }))

    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(writes).toHaveLength(0)
  })

  it('says a teammate that has never run has nothing yet, and offers a re-check', async () => {
    listing = { ...listing, notes: [], indexedNotes: [], hasState: false, exists: false }
    renderPanel()
    await waitFor(() => expect(screen.getByText('Nothing remembered yet')).toBeTruthy())
    // The panel has no push channel, so a run writing its first note while
    // this is on screen would otherwise leave it saying "nothing" forever.
    fireEvent.click(screen.getByTestId('teammate-memory-refresh'))
    await waitFor(() => expect(window.vyotiq.agentMemoryList).toHaveBeenCalledTimes(2))
    // Nothing to read, so nothing is requested — the panel must not invent a
    // layout for a namespace that was never written.
    expect(window.vyotiq.agentMemoryRead).not.toHaveBeenCalled()
  })

  it('shows why a save failed instead of reporting silence as success', async () => {
    // The store published the reason and nothing read it, so a refused write
    // looked exactly like a successful one.
    renderPanel()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit index.md' })).toBeTruthy())
    window.vyotiq.agentMemoryWrite = vi.fn(async () => ({
      ok: false as const,
      error: 'Memory is read-only in this project'
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Edit index.md' }))
    fireEvent.change(screen.getByLabelText('index.md contents'), {
      target: { value: '# Rewritten\n' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save index.md' }))

    await waitFor(() =>
      expect(screen.getByText('Memory is read-only in this project')).toBeTruthy()
    )
    expect(pushToastMock).not.toHaveBeenCalled()
  })

  it('reports a failed listing instead of loading forever', async () => {
    window.vyotiq.agentMemoryList = vi.fn(async () => ({
      ok: false as const,
      error: 'Workspace is not open'
    }))
    renderPanel()

    await waitFor(() => expect(screen.getByText('Workspace is not open')).toBeTruthy())
    expect(screen.queryByText('Loading memory…')).toBeNull()
  })

  it('re-reads from disk on demand, the only escape from the per-key cache', async () => {
    renderPanel()
    await waitFor(() => expect(screen.getByText(/Memory index/)).toBeTruthy())
    expect(window.vyotiq.agentMemoryList).toHaveBeenCalledTimes(1)

    // A run that writes memory while this panel is open has no push channel to
    // announce it, so without this the panel shows stale content indefinitely.
    listing = { ...listing, notes: ['arch.md', 'stray.md', 'fresh.md'] }
    fireEvent.click(screen.getByTestId('teammate-memory-refresh'))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'notes/fresh.md' })).toBeTruthy()
    )
    expect(window.vyotiq.agentMemoryList).toHaveBeenCalledTimes(2)
  })

  it('explains itself when no project is open, because memory is per project', () => {
    renderPanel(null)
    expect(screen.getByText('Open a project to see this memory')).toBeTruthy()
    expect(window.vyotiq.agentMemoryList).not.toHaveBeenCalled()
  })
})
