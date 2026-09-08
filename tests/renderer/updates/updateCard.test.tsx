/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UpdateCard } from '@renderer/features/updates/UpdateCard'
import {
  LAST_SEEN_UPDATE_VERSION_KEY,
} from '@renderer/features/updates/useUpdater'
import type {
  UpdateInfo,
  UpdaterBridge,
  UpdaterState
} from '@renderer/features/updates/types'

const INFO: UpdateInfo = {
  version: '1.2.0',
  releaseDate: '2026-09-01',
  releaseName: 'Autumn release',
  notesText: 'Autumn release\n- Faster chat streaming\n- Sidebar scroll fix',
  notesSections: [
    { heading: 'Highlights', items: ['Faster chat streaming', 'New command palette'] },
    { heading: 'Fixes', items: ['Sidebar scroll fix'] }
  ]
}

type StateListener = (s: UpdaterState) => void

function installBridge(initial?: UpdaterState): {
  bridge: UpdaterBridge
  emit: (s: UpdaterState) => void
  listenerCount: () => number
} {
  const listeners: StateListener[] = []
  const bridge: UpdaterBridge = {
    check: vi.fn(async () => ({ ok: true as const, data: initial?.info ?? null })),
    download: vi.fn(async () => ({ ok: true as const, data: undefined })),
    install: vi.fn(async () => ({ ok: true as const, data: undefined })),
    onState: vi.fn((cb: StateListener) => {
      listeners.push(cb)
      return () => {
        const index = listeners.indexOf(cb)
        if (index >= 0) listeners.splice(index, 1)
      }
    })
  }
  ;(window as unknown as { vyotiq: unknown }).vyotiq = { updater: bridge }
  return {
    bridge,
    emit: (s) => listeners.forEach((l) => l(s)),
    listenerCount: () => listeners.length
  }
}

function setLastSeen(version: string | null): void {
  if (version == null) window.localStorage.removeItem(LAST_SEEN_UPDATE_VERSION_KEY)
  else window.localStorage.setItem(LAST_SEEN_UPDATE_VERSION_KEY, version)
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { vyotiq?: unknown }).vyotiq
})

describe('UpdateCard', () => {
  it('is hidden for idle/checking/not-available/error states', async () => {
    const { emit } = installBridge()
    render(<UpdateCard />)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    for (const status of ['checking', 'not-available', 'error'] as const) {
      emit({ status, ...(status === 'error' ? { error: 'boom' } : {}) })
    }
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders version and notes sections when a new version is available', async () => {
    const { bridge, emit } = installBridge()
    render(<UpdateCard />)
    emit({ status: 'available', info: INFO })
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(screen.getByText('Autumn release')).toBeTruthy()
    expect(screen.getByText('v1.2.0')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Highlights' })).toBeTruthy()
    expect(screen.getByText('Faster chat streaming')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Fixes' })).toBeTruthy()
    expect(screen.getByText('Sidebar scroll fix')).toBeTruthy()
    expect(bridge.check).toHaveBeenCalledTimes(1)
    expect(bridge.onState).toHaveBeenCalledTimes(1)
  })

  it('unwraps the IpcResult envelope from check() without crashing', async () => {
    // Regression: check() resolves { ok, data } — storing the envelope as info
    // crashed on info.notesSections (the pre-fix production bug).
    const { bridge } = installBridge()
    bridge.check = vi.fn(async () => ({ ok: true as const, data: INFO }))
    render(<UpdateCard />)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(screen.getByText('v1.2.0')).toBeTruthy()
    expect(screen.getByText('Faster chat streaming')).toBeTruthy()
  })

  it('stays hidden when check() resolves ok with null data (up to date)', async () => {
    installBridge()
    render(<UpdateCard />)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows determinate progress with percent and MB while downloading', async () => {
    const { emit } = installBridge()
    render(<UpdateCard />)
    emit({ status: 'available', info: INFO })
    await screen.findByRole('dialog')
    const MB = 1024 * 1024
    emit({
      status: 'downloading',
      info: INFO,
      progress: { percent: 42, transferred: 12 * MB, total: 30 * MB }
    })
    const bar = await screen.findByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('42')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
    expect(screen.getByText('42% · 12.0 MB of 30.0 MB')).toBeTruthy()
  })

  it('renders Install & restart when downloaded and calls install on click', async () => {
    const { bridge, emit } = installBridge()
    render(<UpdateCard />)
    emit({ status: 'available', info: INFO })
    await screen.findByRole('dialog')
    emit({ status: 'downloading', info: INFO, progress: { percent: 80, transferred: 20, total: 25 } })
    emit({ status: 'downloaded', info: INFO })
    const button = await screen.findByRole('button', { name: 'Install & restart' })
    fireEvent.click(button)
    await waitFor(() => expect(bridge.install).toHaveBeenCalledTimes(1))
  })

  it('hides the card after dismiss and persists the last-seen version', async () => {
    const { emit } = installBridge()
    render(<UpdateCard />)
    emit({ status: 'available', info: INFO })
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss update notification' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(window.localStorage.getItem(LAST_SEEN_UPDATE_VERSION_KEY)).toBe('1.2.0')
    // Same version arriving again stays hidden.
    emit({ status: 'downloaded', info: INFO })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('hides when the arriving version was already dismissed previously', () => {
    setLastSeen('1.2.0')
    installBridge({ status: 'available', info: INFO })
    render(<UpdateCard />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes on Escape', async () => {
    const { emit } = installBridge()
    render(<UpdateCard />)
    emit({ status: 'available', info: INFO })
    const dialog = await screen.findByRole('dialog')
    // Effects (focus + Escape listener) flush after commit — wait for focus
    // so the keydown listener is guaranteed attached before dispatching.
    await waitFor(() => expect(document.activeElement).toBe(dialog))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(window.localStorage.getItem(LAST_SEEN_UPDATE_VERSION_KEY)).toBe('1.2.0')
  })

  it('takes focus when it appears and unsubscribes on unmount', async () => {
    const { emit, listenerCount } = installBridge()
    const { unmount } = render(<UpdateCard />)
    emit({ status: 'available', info: INFO })
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(document.activeElement).toBe(dialog))
    expect(listenerCount()).toBe(1)
    unmount()
    expect(listenerCount()).toBe(0)
  })
})
