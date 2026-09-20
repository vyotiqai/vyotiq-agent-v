/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UpdateNavItem } from '@renderer/app/sidebar/UpdateNavItem'
import {
  ANNOUNCED_VERSION_KEY,
  PENDING_NOTES_KEY,
  resetUpdaterStoreForTests
} from '@renderer/features/updates/updaterStore'
import type { UpdateInfo, UpdaterStatePayload } from '@shared/ipc'

const INFO: UpdateInfo = {
  version: '1.2.0',
  releaseDate: '2026-09-01',
  releaseName: 'Autumn release',
  notesText: 'Autumn release\n- Faster chat streaming\n- Sidebar scroll fix',
  notesSections: [
    { heading: 'Highlights', items: ['Faster chat streaming', 'New command palette'] },
    { heading: 'Fixes', items: ['Sidebar scroll fix'] }
  ],
  releaseUrl: 'https://github.com/vyotiqai/vyotiq-agent-v-releases/releases/tag/v1.2.0'
}

type StateListener = (s: UpdaterStatePayload) => void

function installBridge(seed: UpdaterStatePayload = { status: 'idle' }): {
  bridge: {
    getState: ReturnType<typeof vi.fn>
    check: ReturnType<typeof vi.fn>
    download: ReturnType<typeof vi.fn>
    install: ReturnType<typeof vi.fn>
    onState: ReturnType<typeof vi.fn>
  }
  emit: (s: UpdaterStatePayload) => void
  listenerCount: () => number
} {
  const listeners: StateListener[] = []
  const bridge = {
    getState: vi.fn(async () => ({ ok: true as const, data: seed })),
    check: vi.fn(async () => ({ ok: true as const, data: null })),
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
  const shellOpenExternal = vi.fn(async () => ({ ok: true as const, data: undefined }))
  ;(window as unknown as { vyotiq: unknown }).vyotiq = { updater: bridge, shellOpenExternal }
  return {
    bridge,
    emit: (s) => listeners.forEach((l) => l(s)),
    listenerCount: () => listeners.length
  }
}

beforeEach(() => {
  window.localStorage.clear()
  resetUpdaterStoreForTests()
})

afterEach(() => {
  cleanup()
  resetUpdaterStoreForTests()
  delete (window as unknown as { vyotiq?: unknown }).vyotiq
})

describe('UpdateNavItem', () => {
  it('renders nothing while the install is current', async () => {
    const { emit } = installBridge()
    render(<UpdateNavItem collapsed={false} />)

    await waitFor(() => expect(screen.queryByRole('button')).toBeNull())
    for (const status of ['checking', 'not-available', 'error'] as const) {
      emit({ status })
      expect(screen.queryByRole('button')).toBeNull()
    }
  })

  it('seeds from getState and never fires a network check on mount', async () => {
    const { bridge } = installBridge({ status: 'available', info: INFO })
    render(<UpdateNavItem collapsed={false} />)

    await screen.findByRole('button', { name: /Version 1\.2\.0 is available/ })
    expect(bridge.getState).toHaveBeenCalledTimes(1)
    // Checking is main's job, gated on the Automatic checks switch. A renderer
    // that checks on mount is what made that switch meaningless.
    expect(bridge.check).not.toHaveBeenCalled()
  })

  it('opens its panel once per version, then leaves the rail entry behind', async () => {
    const { emit } = installBridge()
    render(<UpdateNavItem collapsed={false} />)
    emit({ status: 'available', info: INFO })

    // Announces itself without being clicked.
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(screen.getByText('Autumn release')).toBeTruthy()
    expect(screen.getByText('Faster chat streaming')).toBeTruthy()
    expect(window.localStorage.getItem(ANNOUNCED_VERSION_KEY)).toBe('1.2.0')

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // Closing is not dismissing: the entry stays, and nothing is persisted
    // that could hide this update on a later launch.
    expect(screen.getByRole('button', { name: /Version 1\.2\.0 is available/ })).toBeTruthy()
  })

  it('does not re-announce a version the user has already seen', async () => {
    window.localStorage.setItem(ANNOUNCED_VERSION_KEY, '1.2.0')
    const { emit } = installBridge()
    render(<UpdateNavItem collapsed={false} />)
    emit({ status: 'available', info: INFO })

    await screen.findByRole('button', { name: /Version 1\.2\.0 is available/ })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('announces a newer version even after an older one was seen', async () => {
    window.localStorage.setItem(ANNOUNCED_VERSION_KEY, '1.2.0')
    const { emit } = installBridge()
    render(<UpdateNavItem collapsed={false} />)
    emit({ status: 'available', info: { ...INFO, version: '1.3.0' } })

    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(window.localStorage.getItem(ANNOUNCED_VERSION_KEY)).toBe('1.3.0')
  })

  it('downloads only when the user asks, and reports progress', async () => {
    const { bridge, emit } = installBridge()
    render(<UpdateNavItem collapsed={false} />)
    emit({ status: 'available', info: INFO })

    await screen.findByRole('dialog')
    expect(bridge.download).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Download update' }))
    expect(bridge.download).toHaveBeenCalledTimes(1)

    emit({
      status: 'downloading',
      info: INFO,
      progress: { percent: 42.4, transferred: 4.2 * 1024 * 1024, total: 10 * 1024 * 1024 }
    })
    const bar = await screen.findByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('42')
    expect(screen.getByText(/4\.2 MB of 10\.0 MB/)).toBeTruthy()
  })

  it('hands the release notes to Stage B before installing', async () => {
    const { bridge, emit } = installBridge()
    render(<UpdateNavItem collapsed={false} />)
    emit({ status: 'downloaded', info: INFO })

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: /Install & restart/ }))

    expect(bridge.install).toHaveBeenCalledTimes(1)
    const pending = JSON.parse(window.localStorage.getItem(PENDING_NOTES_KEY) ?? 'null')
    expect(pending).toMatchObject({ version: '1.2.0', notesSections: INFO.notesSections })
  })

  it('falls back to plain notes text when there are no sections', async () => {
    const { emit } = installBridge()
    render(<UpdateNavItem collapsed={false} />)
    emit({
      status: 'available',
      info: { ...INFO, notesSections: [] as UpdateInfo['notesSections'] }
    })

    await screen.findByRole('dialog')
    expect(screen.getByText(/Faster chat streaming/)).toBeTruthy()
  })

  it('opens full release notes externally', async () => {
    const { emit } = installBridge()
    render(<UpdateNavItem collapsed={false} />)
    emit({ status: 'available', info: INFO })

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Full release notes' }))
    const api = (window as unknown as { vyotiq: { shellOpenExternal: ReturnType<typeof vi.fn> } })
      .vyotiq
    expect(api.shellOpenExternal).toHaveBeenCalledWith(INFO.releaseUrl)
  })

  it('shares one bridge subscription across consumers', async () => {
    const { listenerCount } = installBridge()
    const first = render(<UpdateNavItem collapsed={false} />)
    const second = render(<UpdateNavItem collapsed />)

    await waitFor(() => expect(listenerCount()).toBe(1))
    first.unmount()
    second.unmount()
  })

  it('stays idle and does not throw when the preload bridge is absent', () => {
    delete (window as unknown as { vyotiq?: unknown }).vyotiq
    expect(() => render(<UpdateNavItem collapsed={false} />)).not.toThrow()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
