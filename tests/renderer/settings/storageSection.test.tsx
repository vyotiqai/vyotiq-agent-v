/** @vitest-environment jsdom */
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { SettingsView, type SettingsSection } from '@renderer/features/settings'
import { emptySecretStatus, type Settings } from '@shared/ipc'
import { DEFAULT_SETTINGS } from '@shared/ipc'

/**
 * Settings → Storage surface (audit H4/H5). Every control is wired: the usage
 * rows render live IPC numbers, "Free up space now" runs the
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
    { id: 'checkpoints', label: 'Checkpoints (undo points)', bytes: 4096, files: 2, managed: true },
    { id: 'transcripts', label: 'Task records', bytes: 1_048_576, files: 3, managed: true },
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
    { id: 'checkpoints', label: 'Undo points', reclaimBytes: 4096, items: 2 },
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
    { id: 'checkpoints', label: 'Undo points', reclaimBytes: 4096, items: 2 },
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

function renderStorage(
  bridge: Bridge,
  onUpdate = vi.fn(async () => ({ ok: true as const })),
  sectionSettings: Settings = baseSettings
) {
  // @ts-expect-error test bridge
  window.vyotiq = bridge
  // Section lives in state: the dictation-model link navigates away, and a
  // constant `section` prop would swallow that nav (controlled prop).
  function Harness() {
    const [section, setSection] = useState<SettingsSection>('storage')
    return (
      <SettingsView
        settings={sectionSettings}
        secrets={emptySecrets}
        section={section}
        onSectionChange={setSection}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
  }
  return render(<Harness />)
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

describe('Settings → Storage', () => {
  it('renders the live usage report from the storage IPC (no fake numbers)', async () => {
    const bridge = makeBridge()
    renderStorage(bridge)

    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    const row = (id: string) => document.querySelector(`[data-storage-category="${id}"]`) as HTMLElement
    await waitFor(() => expect(row('transcripts')).toBeTruthy())
    expect(bridge.storageReport).toHaveBeenCalledTimes(1)
    // Managed data first, largest first; report-only categories after.
    expect(
      [...document.querySelectorAll('[data-storage-category]')].map((el) =>
        el.getAttribute('data-storage-category')
      )
    ).toEqual(['transcripts', 'checkpoints', 'dictation-models'])
    // Real numbers from the mocked report, with the file count on the size.
    expect(within(row('checkpoints')).getByText('4 KB').getAttribute('title')).toBe('2 files')
    expect(within(row('transcripts')).getByText('1.0 MB').getAttribute('title')).toBe('3 files')
    expect(within(row('dictation-models')).getByText('456 MB').getAttribute('title')).toBe('1 file')
    // Models are measured but the cap never evicts them, so they draw no share.
    expect(within(row('dictation-models')).getByText('not managed')).toBeTruthy()
    // The headline is managed data against its cap, beside everything measured.
    expect(screen.getByText('of a 5.0 GB managed cap')).toBeTruthy()
    expect(screen.getByText('457 MB in all')).toBeTruthy()
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

  it('flags untracked workspace storage as safe to clean', async () => {
    const bridge = makeBridge()
    renderStorage(bridge)

    await waitFor(() => expect(screen.getByText('Untracked · safe to clean')).toBeTruthy())
    expect(screen.getByText('Tracked')).toBeTruthy()
    expect(screen.getByText('1 task')).toBeTruthy()
  })

  it('runs the Free up space flow: preview → confirm → run → result', async () => {
    const bridge = makeBridge()
    renderStorage(bridge)

    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Check…' }))

    await waitFor(() => expect(bridge.storageCleanupPreview).toHaveBeenCalled())
    // The preview lists what would go, per category; nothing is deleted yet.
    const freeUp = document.querySelector('[data-settings-field="storage-free-up"]') as HTMLElement
    await waitFor(() => expect(within(freeUp).getByText('Untracked workspace storage')).toBeTruthy())
    expect(within(freeUp).getByText('100 MB')).toBeTruthy()
    expect(within(freeUp).getByText('2 items')).toBeTruthy()
    // Under the cap, so the size-cap pass has nothing to add.
    expect(screen.queryByText(/may also be evicted/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Delete 100 MB' }))
    await waitFor(() =>
      expect(bridge.storageCleanupRun).toHaveBeenCalledWith({ confirmToken: 'tok-1' })
    )
    await waitFor(() => expect(screen.getByText(/Freed 100 MB/)).toBeTruthy())
    expect(screen.getByText(/across 3 items/i)).toBeTruthy()
  })

  it('cancel exits the confirm step without running the cleanup', async () => {
    const bridge = makeBridge()
    renderStorage(bridge)

    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Check…' }))
    await waitFor(() => expect(bridge.storageCleanupPreview).toHaveBeenCalled())

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(bridge.storageCleanupRun).not.toHaveBeenCalled()
    expect(screen.queryByText('Untracked workspace storage')).toBeNull()
    expect(screen.getByRole('button', { name: 'Check…' })).toBeTruthy()
  })

  it('retention switch toggles checkpoint cleanup live', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    const bridge = makeBridge()
    renderStorage(bridge, onUpdate)

    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    const toggle = screen.getByRole('switch', { name: 'Clean up undo points' })
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
    const keepInput = screen.getByLabelText('Keep undo points of the newest')
    fireEvent.change(keepInput, { target: { value: '3' } })
    fireEvent.blur(keepInput)
    // Out of bounds (min 5) → rejected, no settings write, and the reason is
    // under the field rather than at the bottom of the page.
    expect(onUpdate).not.toHaveBeenCalled()
    const row = document.querySelector('[data-settings-field="storage-checkpoint-keep"]')
    expect(row?.textContent).toMatch(/Keep undo points of the newest must be from 5 to 100 tasks\./)
    expect(keepInput.getAttribute('aria-invalid')).toBe('true')

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
    const offSettings: Settings = {
      ...baseSettings,
      storage: { ...baseSettings.storage, checkpointGcEnabled: false }
    }
    renderStorage(bridge, vi.fn(async () => ({ ok: true as const })), offSettings)
    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    expect(screen.getByText(/every undo point is kept forever/i)).toBeTruthy()
    // sessionRetentionEnabled defaults false. Free up space still applies the
    // session limits then, so the hint must not promise "kept forever" — and
    // the limits stay editable.
    expect(screen.getByText(/nothing is deleted on a schedule/i)).toBeTruthy()
    expect(screen.queryByText(/every task is kept forever/i)).toBeNull()
    expect(
      (screen.getByRole('spinbutton', { name: 'Always keep the newest' }) as HTMLInputElement).disabled
    ).toBe(false)
  })

  it('every retention control is present and labeled', async () => {
    const bridge = makeBridge()
    renderStorage(bridge)

    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    for (const name of [
      'Clean up undo points',
      'Delete old tasks',
      'Clean up untracked storage',
      'Delete storage when closing a workspace'
    ]) {
      expect(screen.getByRole('switch', { name })).toBeTruthy()
    }
    for (const name of [
      'Keep undo points for',
      'Keep undo points of the newest',
      'Keep tasks for',
      'Always keep the newest',
      'Untracked grace period',
      'Managed size cap'
    ]) {
      expect(screen.getByRole('spinbutton', { name })).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: 'Check…' })).toBeTruthy()
  })

  it('report failure surfaces the error inline instead of fake numbers', async () => {
    const bridge = makeBridge({
      storageReport: vi.fn(async () => ({ ok: false as const, error: 'scan failed' }))
    })
    renderStorage(bridge)
    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    // No category table rendered (report never resolved ok) — and the
    // failure is said, not swallowed.
    expect(screen.queryByText('Task records')).toBeNull()
    expect((await screen.findByRole('alert')).textContent).toMatch(/scan failed/)
  })

  it('the retention policy sits on the Storage page it governs', async () => {
    // Opening Storage acks the first-run suspension and arms the policy, so
    // the policy has to be here to be seen before it runs.
    const bridge = makeBridge()
    renderStorage(bridge)
    await waitFor(() => expect(bridge.storageAckSurface).toHaveBeenCalledWith(true))
    expect(document.querySelector('[data-settings-field="storage-checkpoint-gc"]')).toBeTruthy()
    expect(document.querySelector('[data-settings-field="storage-size-cap"]')).toBeTruthy()
  })

  it('says the size cap may evict more than the preview lists when over the cap', async () => {
    // The confirmed run enforces the cap after the listed categories, and the
    // preview cannot size that pass, so the confirm step must say so.
    const bridge = makeBridge({
      storageReport: vi.fn(async () => ({
        ok: true as const,
        data: { ...reportData, overCap: true }
      }))
    })
    renderStorage(bridge)
    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Check…' }))
    expect(
      await screen.findByText(
        /Managed data is over the 5\.0 GB cap, so the oldest checkpoints may also be evicted/
      )
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete 100 MB' })).toBeTruthy()
  })

  it('a cleanup with nothing to reclaim says so instead of offering to delete 0 B', async () => {
    const bridge = makeBridge({
      storageCleanupPreview: vi.fn(async () => ({
        ok: true as const,
        data: { ...previewData, categories: [], totalReclaimBytes: 0, orphanDirs: [] }
      }))
    })
    renderStorage(bridge)
    await waitFor(() => expect(bridge.storageReport).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Check…' }))
    expect(await screen.findByText('Nothing to clean up right now.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Delete /i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByText('Nothing to clean up right now.')).toBeNull()
    expect(bridge.storageCleanupRun).not.toHaveBeenCalled()
  })

  it('links the dictation-model category to Voice, where models are managed', async () => {
    const bridge = makeBridge({
      dictationStatus: vi.fn(async () => ({
        ok: true as const,
        data: {
          phase: 'idle' as const,
          progress: null,
          message: null,
          error: null,
          installed: [],
          recommendedModelId: 'whisper-small.en' as const,
          engine: 'openai' as const,
          activeModelId: null,
          loadedModelId: null
        }
      })),
      onDictationStatus: vi.fn(() => () => {})
    })
    renderStorage(bridge)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Manage dictation models in Voice' })
    )
    await waitFor(() =>
      expect(document.querySelector('[data-settings-field="dictation-engine"]')).toBeTruthy()
    )
  })
})
