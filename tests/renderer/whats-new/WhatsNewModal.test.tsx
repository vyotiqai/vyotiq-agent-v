/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WhatsNewModal } from '@renderer/features/whats-new/WhatsNewModal'
import { compareVersions } from '@renderer/features/whats-new/useWhatsNew'
import {
  LAST_SEEN_UPDATE_VERSION_KEY,
  PENDING_NOTES_KEY
} from '@renderer/features/updates/useUpdater'
import type { ReleaseNotesSection } from '@shared/ipc/schemas/updater'

interface PendingNotesPayload {
  version: string
  notesText: string
  notesSections: ReleaseNotesSection[]
}

function installBridge(version: string): {
  getAppInfo: ReturnType<typeof vi.fn>
  shellOpenExternal: ReturnType<typeof vi.fn>
} {
  const getAppInfo = vi.fn(async () => ({ ok: true as const, data: { version } }))
  const shellOpenExternal = vi.fn(async () => ({ ok: true as const, data: undefined }))
  ;(window as unknown as { vyotiq: unknown }).vyotiq = { getAppInfo, shellOpenExternal }
  return { getAppInfo, shellOpenExternal }
}

function setLastSeen(version: string | null): void {
  if (version == null) window.localStorage.removeItem(LAST_SEEN_UPDATE_VERSION_KEY)
  else window.localStorage.setItem(LAST_SEEN_UPDATE_VERSION_KEY, version)
}

function seedPendingNotes(payload: PendingNotesPayload | null): void {
  if (payload == null) window.localStorage.removeItem(PENDING_NOTES_KEY)
  else window.localStorage.setItem(PENDING_NOTES_KEY, JSON.stringify(payload))
}

const GITHUB_URL = 'https://github.com/vyotiqai/vyotiq-agent-v-releases/releases/tag/v1.2.0'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { vyotiq?: unknown }).vyotiq
})

describe('compareVersions', () => {
  it('orders dotted version strings', () => {
    expect(compareVersions('1.2.0', '1.1.0')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0)
    expect(compareVersions('1.1.0', '1.2.0')).toBeLessThan(0)
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0)
  })
})

describe('WhatsNewModal gate', () => {
  it('records the version on first run without showing the modal', async () => {
    const { getAppInfo } = installBridge('1.2.0')
    seedPendingNotes(null)
    render(<WhatsNewModal />)
    await waitFor(() =>
      expect(window.localStorage.getItem(LAST_SEEN_UPDATE_VERSION_KEY)).toBe('1.2.0')
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(getAppInfo).toHaveBeenCalledTimes(1)
  })

  it('shows nothing when the version is unchanged since the last run', async () => {
    setLastSeen('1.2.0')
    const { getAppInfo } = installBridge('1.2.0')
    render(<WhatsNewModal />)
    // Gate ran and deliberately chose not to open.
    await waitFor(() => expect(getAppInfo).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(window.localStorage.getItem(LAST_SEEN_UPDATE_VERSION_KEY)).toBe('1.2.0')
  })

  it('shows the modal with categorized sections when the app was updated', async () => {
    setLastSeen('1.1.0')
    seedPendingNotes({
      version: '1.2.0',
      notesText: '## Features\n- Faster streaming',
      notesSections: [
        { heading: 'Features', items: ['Faster streaming'] },
        { heading: 'Fixes', items: ['Scroll fix'] },
        { heading: 'Random heading', items: ['Something else'] }
      ]
    })
    const { shellOpenExternal } = installBridge('1.2.0')
    render(<WhatsNewModal />)

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(screen.getByText('Welcome to Vyotiq v1.2.0')).toBeTruthy()
    expect(screen.getByText(/since your last version \(v1\.1\.0\)/)).toBeTruthy()
    // Known categories map onto the canonical emoji headings…
    expect(screen.getByRole('heading', { name: '🚀 Features' })).toBeTruthy()
    expect(screen.getByText('Faster streaming')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '🛠️ Fixes & Stability' })).toBeTruthy()
    expect(screen.getByText('Scroll fix')).toBeTruthy()
    // …unknown headings pass through unchanged.
    expect(screen.getByRole('heading', { name: 'Random heading' })).toBeTruthy()
    expect(screen.getByText('Something else')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '⚡ Performance Improvements' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Full Release Notes on GitHub' }))
    await waitFor(() => expect(shellOpenExternal).toHaveBeenCalledWith(GITHUB_URL))
  })

  it('records the new version and clears pending notes on dismiss', async () => {
    setLastSeen('1.1.0')
    seedPendingNotes({
      version: '1.2.0',
      notesText: 'note',
      notesSections: [{ heading: 'Features', items: ['Faster streaming'] }]
    })
    installBridge('1.2.0')
    render(<WhatsNewModal />)

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() =>
      expect(window.localStorage.getItem(LAST_SEEN_UPDATE_VERSION_KEY)).toBe('1.2.0')
    )
    expect(window.localStorage.getItem(PENDING_NOTES_KEY)).toBeNull()
  })

  it('closes on Escape and records the version', async () => {
    setLastSeen('1.1.0')
    seedPendingNotes(null)
    installBridge('1.2.0')
    render(<WhatsNewModal />)

    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(document.activeElement).toBe(dialog))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() =>
      expect(window.localStorage.getItem(LAST_SEEN_UPDATE_VERSION_KEY)).toBe('1.2.0')
    )
  })
})

describe('WhatsNewModal pending notes', () => {
  it('falls back to a generic line when Stage A notes are absent', async () => {
    setLastSeen('1.1.0')
    seedPendingNotes(null)
    installBridge('1.2.0')
    render(<WhatsNewModal />)

    await screen.findByRole('dialog')
    expect(screen.getByText(/Vyotiq was updated to v1\.2\.0/)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Full Release Notes on GitHub' })
    ).toBeTruthy()
  })

  it('ignores pending notes stamped for a different version', async () => {
    setLastSeen('1.1.0')
    seedPendingNotes({
      version: '9.9.9',
      notesText: 'stale',
      notesSections: [{ heading: 'Features', items: ['stale item'] }]
    })
    installBridge('1.2.0')
    render(<WhatsNewModal />)

    await screen.findByRole('dialog')
    expect(screen.queryByText('stale item')).toBeNull()
    expect(screen.getByText(/Vyotiq was updated to v1\.2\.0/)).toBeTruthy()
  })

  it('consumes Stage A notes and clears the pending key after showing', async () => {
    setLastSeen('1.1.0')
    seedPendingNotes({
      version: '1.2.0',
      notesText: 'plain fallback body',
      notesSections: []
    })
    installBridge('1.2.0')
    render(<WhatsNewModal />)

    await screen.findByRole('dialog')
    // notesSections empty → plain-text notesText fallback panel.
    expect(screen.getByText('plain fallback body')).toBeTruthy()
    expect(window.localStorage.getItem(PENDING_NOTES_KEY)).toBeNull()
  })
})
