/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WhatsNewModal } from '@renderer/features/whats-new/WhatsNewModal'
import {
  compareVersions,
  LAST_SEEN_UPDATE_VERSION_KEY
} from '@renderer/features/whats-new/useWhatsNew'
import {
  ANNOUNCED_VERSION_KEY,
  PENDING_NOTES_KEY
} from '@renderer/features/updates/updaterStore'
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

  it('names the version, the one it replaced, and each item by its lead', async () => {
    setLastSeen('1.1.0')
    seedPendingNotes({
      version: '1.2.0',
      notesText: '## Added\n- **Faster streaming.** Tokens arrive as they are made.',
      notesSections: [
        { heading: 'Added', items: ['**Faster streaming.** Tokens arrive as they are made.'] },
        { heading: 'Fixed', items: ['Scroll fix.'] },
        { heading: 'Random heading', items: ['Something else'] }
      ]
    })
    const { shellOpenExternal } = installBridge('1.2.0')
    render(<WhatsNewModal />)

    const dialog = await screen.findByRole('dialog', { name: 'Agent V 1.2.0' })
    expect(dialog.textContent).toContain('What’s new')
    expect(screen.getByText('from 1.1.0')).toBeTruthy()
    // The release's own headings, Added read as New…
    expect(screen.getByRole('heading', { name: 'New' })).toBeTruthy()
    expect(screen.getByText('Faster streaming')).toBeTruthy()
    expect(screen.queryByText(/Tokens arrive/)).toBeNull()
    expect(screen.getByRole('heading', { name: 'Fixed' })).toBeTruthy()
    expect(screen.getByText('Scroll fix')).toBeTruthy()
    // …and one it does not know keeps its own words.
    expect(screen.getByRole('heading', { name: 'Random heading' })).toBeTruthy()
    expect(screen.getByText('Something else')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Full release notes' }))
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

    await screen.findByRole('dialog')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Got it' })))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() =>
      expect(window.localStorage.getItem(LAST_SEEN_UPDATE_VERSION_KEY)).toBe('1.2.0')
    )
  })

  // The old update card wrote the *available* version into this key when
  // dismissed, which is a different meaning from "version at the end of the
  // previous run". Installs carrying such a value must be repaired, not
  // silently left in a state where What's New never fires again.
  it('repairs a legacy key left by the old dismiss, without showing the modal', async () => {
    setLastSeen('1.9.0')
    seedPendingNotes(null)
    installBridge('1.2.0')
    render(<WhatsNewModal />)

    await waitFor(() =>
      expect(window.localStorage.getItem(LAST_SEEN_UPDATE_VERSION_KEY)).toBe('1.2.0')
    )
    // Handed to the updater store so the user is not re-prompted for the
    // version they already declined.
    expect(window.localStorage.getItem(ANNOUNCED_VERSION_KEY)).toBe('1.9.0')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not overwrite an announcement the updater store already recorded', async () => {
    setLastSeen('1.9.0')
    window.localStorage.setItem(ANNOUNCED_VERSION_KEY, '2.0.0')
    seedPendingNotes(null)
    installBridge('1.2.0')
    render(<WhatsNewModal />)

    await waitFor(() =>
      expect(window.localStorage.getItem(LAST_SEEN_UPDATE_VERSION_KEY)).toBe('1.2.0')
    )
    expect(window.localStorage.getItem(ANNOUNCED_VERSION_KEY)).toBe('2.0.0')
  })

  it('still shows What’s New after a real update once the key is repaired', async () => {
    // Post-repair state: the key means "previous run" again.
    setLastSeen('1.2.0')
    seedPendingNotes(null)
    installBridge('1.3.0')
    render(<WhatsNewModal />)

    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
})

describe('WhatsNewModal pending notes', () => {
  it('falls back to a generic line when Stage A notes are absent', async () => {
    setLastSeen('1.1.0')
    seedPendingNotes(null)
    installBridge('1.2.0')
    render(<WhatsNewModal />)

    await screen.findByRole('dialog')
    expect(screen.getByText(/Agent V was updated to 1\.2\.0/)).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Full release notes' })
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
    expect(screen.getByText(/Agent V was updated to 1\.2\.0/)).toBeTruthy()
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
