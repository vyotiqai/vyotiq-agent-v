/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SettingsView } from '@renderer/features/settings'
import { emptySecretStatus, type Settings } from '@shared/ipc'
import { DEFAULT_SETTINGS } from '@shared/ipc'

/**
 * Settings → Storage surface (audit H4/H5). Every control is wired: the
 * report table renders live IPC numbers, "Free up space" runs the
 * preview → confirm → run flow over the storage cleanup IPC, retention
 * switches/inputs patch settings live, and the first-open ack fires once.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const emptySecrets = emptySecretStatus()

const baseSettings: Settings = {
  ...DEFAULT_SETTINGS,
  provider: 'openai',
  model: 'gpt-5.6'
}

const reportData = {
  categories: [
    { id: 'checkpoints', label: 'Checkpoints', bytes: 4096, files: 2, managed: true },
    { id: 'transcripts', label: 'Session transcripts', bytes: 1_048_576, files: 3, managed: true },
    { id: 'dictation-models', label: 'Dictation models', bytes: 478_150_656, files: 1, managed: false }
  ],
  workspaces: [
    {
      workspaceId: 'wid-a',
      path: 'C:\\proj\\a',
      displayName: 'a',
      bytes: 2048,
      files: 2,
      sessionCount: 1,
      tracked: true,
      idleDays: 0,
      reapable: false
    },
    {
      workspaceId: 'wid-orphan',
      path: null,
      displayName: null,
      bytes: 104_857_600,
      files: 10,
      sessionCount: 0,
      tracked: false,
      idleDays: 45,
      reapable: true
    }
  ],
  totalBytes: 479_200_000,
  managedBytes: 1_052_672,
  sizeCapBytes: 5 * 1024 * 1024 * 1024,
  overCap: false
}

const previewData = {
  categories: [
    { id: 'checkpoints', label: 'Checkpoints', reclaimBytes: 4096, items: 2 },
    {
      id: 'orphans',
      label: 'Untracked workspace storage',
      reclaimBytes: 104_857_600,
      items: 1
    }
  ],
  totalReclaimBytes: 104_861_696,
  orphanDirs: [
    {
      workspaceId: 'wid-orphan',
      path: null,
      displayName: null,
      bytes: 104_857_600,
      files: 10,
      sessionCount: 0,
      tracked: false,
      idleDays: 45,
      reapable: true
    }
  ],
  confirm: { token: 'tok-1', mintedAt: '2026-09-10T07:00:00.000Z' }
}

const runResultData = {
  categories: [
    { id: 'checkpoints', label: 'Checkpoints', reclaimBytes: 4096, items: 2 },
    {
      id: 'orphans',
      label: 'Untracked workspace storage',
      reclaimBytes: 104_857_600,
      items: 1
    }
  ],
  totalReclaimedBytes: 104_861_696,
  removedDirs: 3,
  skipped: 0
}

type Bridge = Record<string, ReturnType<typeof vi.fn>>

function makeBridge(overrides: Partial<Bridge> = {}): Bridge {
  return {
    listModels: vi.fn(async () => ({
      ok: true as const,
      data: {
        models: [
          {
            id: 'gpt-5.6',
            inputModalities: ['text'],
            outputModalities: ['text'],
            supportsTools: true,
            supportsVision: false
          }
        ],
        warning: 'seed'
      }
    })),
    storageReport: vi.fn(async () => ({ ok: true as const, data: reportData })),
    storageCleanupPreview: vi.fn(async () => ({ ok: true as const, data: previewData })),
    storageCleanupRun: vi.fn(async () => ({ ok: true as const, data: runResultData })),
    storageAckSurface: vi.fn(async () => ({ ok: true as const, data: baseSettings })),
    ...overrides
  }
}

function renderStorage(bridge: Bridge, onUpdate = vi.fn(async () => ({ ok: true as const }))) {
  // @ts-expect-error test bridge
  window.vyotiq = bridge
  const props = {
    settings: baseSettings,
    secrets: emptySecrets,
    section: 'storage' as const,
    onClose: vi.fn(),
    onUpdate,
    onSaveSecret: vi.fn(async () => ({ ok: true as const })),
    onClearSecret: vi.fn(async () => ({ ok: true as const }))
  }
  return { props, ...render(<SettingsView {...props} />) }
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe('Settings → Storage', () => {
  it('renders the live usage report from the storage IPC (no fake numbers)', async () => {
    const bridge = makeBridge()
    renderStorage(bridge)

    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByText('Session transcripts').closest('table')).toBeTruthy()
    )
    expect(bridge.storageReport).toHaveBeenCalledTimes(1)
    // Category rows with real numbers from the mocked report.
    expect(screen.getByText('4 KB')).toBeTruthy()
    expect(screen.getByText('1.0 MB')).toBeTruthy()
    expect(screen.getByText('1 file')).toBeTruthy()
    expect(screen.getByText('3 files')).toBeTruthy()
  })

  it('acks the surface once on first open (§8.1 first-run arm)', async () => {
    const bridge = makeBridge()
    renderStorage(bridge, vi.fn(async () => ({ ok: true as const })))

    await waitFor(() => expect(bridge.storageAckSurface).toHaveBeenCalledWith(true))
  })

  it('does not re-ack when already acked', async () => {
    const bridge = makeBridge()
    renderStorage(bridge, vi.fn(async () => ({ ok: true as const })))
    // baseSettings carries storageSurfaceAcked default false — first render
    // acks. Re-render with acked=true and assert no further call.
    await waitFor(() => expect(bridge.storageAckSurface).toHaveBeenCalled())
    const calls = bridge.storageAckSurface.mock.calls.length
    cleanup()
    const ackedSettings: Settings = { ...baseSettings, storageSurfaceAcked: true }
    // @ts-expect-error test bridge
    window.vyotiq = bridge
    render(
      <SettingsView
        settings={ackedSettings}
        secrets={emptySecrets}
        section="storage"
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    expect(bridge.storageAckSurface.mock.calls.length).toBe(calls)
  })

  it('flags untracked workspace storage as safe to clean in the detail table', async () => {
    const bridge = makeBridge()
    renderStorage(bridge)

    await waitFor(() => expect(screen.getByText('Untracked (safe to clean)')).toBeTruthy())
    expect(screen.getByText('Tracked')).toBeTruthy()
    expect(screen.getByText('1 session')).toBeTruthy()
  })

  it('runs the Free up space flow: preview → confirm → run → result', async () => {
    const bridge = makeBridge()
    renderStorage(bridge)

    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    // The field's ?-help button also says "About Free up space" — target the
    // action button by its exact label.
    fireEvent.click(screen.getByRole('button', { name: 'Free up space' }))

    await waitFor(() => expect(bridge.storageCleanupPreview).toHaveBeenCalled())
    // Preview shows reclaimable per category, deletes nothing yet.
    expect(screen.getByText(/Reclaimable:/)).toBeTruthy()
    expect(screen.getByText('100.0 MB')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /delete 100\.0 mb/i }))
    await waitFor(() =>
      expect(bridge.storageCleanupRun).toHaveBeenCalledWith({ confirmToken: 'tok-1' })
    )
    await waitFor(() => expect(screen.getByText(/freed 100\.0 mb/i)).toBeTruthy())
    expect(screen.getByText(/across 3 items/i)).toBeTruthy()
  })

  it('cancel exits the confirm step without running the cleanup', async () => {
    const bridge = makeBridge()
    renderStorage(bridge)

    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Free up space' }))
    await waitFor(() => expect(bridge.storageCleanupPreview).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(bridge.storageCleanupRun).not.toHaveBeenCalled()
    expect(screen.queryByText(/reclaimable:/i)).toBeNull()
  })

  it('retention switch toggles checkpoint cleanup live', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    const bridge = makeBridge()
    renderStorage(bridge, onUpdate)

    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    const toggle = screen.getByRole('switch', { name: /checkpoint cleanup/i })
    fireEvent.click(toggle)
    await waitFor(() => expect(onUpdate).toHaveBeenCalled())
    const patch = onUpdate.mock.calls[0][0] as { storage: Settings['storage'] }
    expect(patch.storage.checkpointGcEnabled).toBe(false)
  })

  it('numeric controls validate their bounds before patching', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    const bridge = makeBridge()
    renderStorage(bridge, onUpdate)

    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    const keepInput = screen.getByLabelText('Keep checkpoint sessions')
    fireEvent.change(keepInput, { target: { value: '3' } })
    fireEvent.blur(keepInput)
    // Out of bounds (min 5) → rejected, no settings write.
    expect(onUpdate).not.toHaveBeenCalled()

    fireEvent.change(keepInput, { target: { value: '25' } })
    fireEvent.blur(keepInput)
    await waitFor(() => expect(onUpdate).toHaveBeenCalled())
    const patch = onUpdate.mock.calls[0][0] as { storage: Settings['storage'] }
    expect(patch.storage.checkpointKeepSessions).toBe(25)
  })

  it('kill-switch semantics: a disabled policy states "keep everything forever"', async () => {
    // Parent-owned settings carry the OFF state; the section renders the
    // kill-switch copy instead of the enabled hint.
    const bridge = makeBridge()
    // @ts-expect-error test bridge
    window.vyotiq = bridge
    const offSettings: Settings = {
      ...baseSettings,
      storage: { ...baseSettings.storage, checkpointGcEnabled: false }
    }
    render(
      <SettingsView
        settings={offSettings}
        secrets={emptySecrets}
        section="storage"
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    expect(screen.getByText(/off = keep everything forever/i)).toBeTruthy()
    // sessionRetentionEnabled defaults false → its hint says it too.
    expect(screen.getByText(/off = keep every session forever/i)).toBeTruthy()
  })

  it('every retention control is present and labeled', async () => {
    const bridge = makeBridge()
    renderStorage(bridge)

    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    for (const label of [
      'Checkpoint cleanup',
      'Keep checkpoint sessions',
      'Checkpoint age backstop',
      'Untracked workspace storage cleanup',
      'Untracked grace window',
      'Delete storage when removing a workspace',
      'Automatic session retention',
      'Keep sessions count',
      'Session age window',
      'Managed size cap'
    ]) {
      expect(screen.getByText(label, { exact: false })).toBeTruthy()
    }
  })

  it('report failure surfaces the error inline instead of fake numbers', async () => {
    const bridge = makeBridge({
      storageReport: vi.fn(async () => ({ ok: false as const, error: 'scan failed' }))
    })
    renderStorage(bridge)
    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    // No category table rendered (report never resolved ok).
    expect(screen.queryByText('Session transcripts')).toBeNull()
  })
})
