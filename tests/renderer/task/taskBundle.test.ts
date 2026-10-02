/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportTaskJson, importTaskInto } from '@renderer/features/task/taskBundle'
import { paletteCommands, runPaletteCommand, type PaletteHandlers } from '@renderer/features/commandPalette/paletteCommands'
import { pushToast } from '@renderer/lib/ui/toastStore'

vi.mock('@renderer/lib/ui/toastStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/ui/toastStore')>()),
  pushToast: vi.fn()
}))

const toast = vi.mocked(pushToast)

afterEach(() => {
  // @ts-expect-error test cleanup
  delete window.vyotiq
})

describe('task bundles in the renderer', () => {
  it('imports into the workspace and hands back the new task, or says why not', async () => {
    toast.mockClear()
    const importRun = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { imported: true, runId: 'new-id', title: 'Fix lint' } })
      .mockResolvedValueOnce({ ok: true, data: { imported: false } })
      .mockResolvedValueOnce({ ok: false, error: 'The file is not JSON.' })
    // @ts-expect-error test bridge
    window.vyotiq = { importRun }
    expect(await importTaskInto('C:\\repo')).toBe('new-id')
    expect(importRun).toHaveBeenCalledWith('C:\\repo')
    expect(toast).toHaveBeenLastCalledWith('Imported “Fix lint” — read-only; fork it to continue', 'success')
    // Cancelled: nothing to open, nothing said.
    toast.mockClear()
    expect(await importTaskInto('C:\\repo')).toBeNull()
    expect(toast).not.toHaveBeenCalled()
    expect(await importTaskInto('C:\\repo')).toBeNull()
    expect(toast).toHaveBeenLastCalledWith('Couldn’t import the task: The file is not JSON.', 'error')
  })

  it('exports through main and says where the file went', async () => {
    toast.mockClear()
    const exportRunJson = vi.fn(async () => ({ ok: true as const, data: { saved: true, path: 'C:\\out\\task.json' } }))
    // @ts-expect-error test bridge
    window.vyotiq = { exportRunJson }
    await exportTaskJson('C:\\repo', 'r1')
    expect(exportRunJson).toHaveBeenCalledWith('C:\\repo', 'r1')
    expect(toast).toHaveBeenLastCalledWith('Task exported to C:\\out\\task.json')
  })

  it('offers Import task… in the palette only with a workspace to import into', () => {
    const base = { workspaces: ['C:\\repo'], activePath: 'C:\\repo', canSendFeedback: false }
    expect(paletteCommands(base).some((c) => c.id === 'importTask')).toBe(false)
    expect(paletteCommands({ ...base, canImportTask: true }).find((c) => c.id === 'importTask')?.title).toBe('Import task…')
    const onImportTask = vi.fn()
    const noop = (): void => {}
    const handlers: PaletteHandlers = {
      workspaces: [],
      onOpenSettings: noop,
      onOpenHome: noop,
      onOpenUsage: noop,
      onNewTask: noop,
      onToggleNavigator: noop,
      onNextNeedsYou: noop,
      onSwitchWorkspaceByIndex: noop,
      onFocusInstructionLine: noop,
      onOpenSettingsField: noop,
      onImportTask
    }
    runPaletteCommand('importTask', handlers)
    expect(onImportTask).toHaveBeenCalledTimes(1)
  })
})
