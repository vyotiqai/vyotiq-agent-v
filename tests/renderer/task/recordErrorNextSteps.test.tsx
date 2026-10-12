/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { buildRecordModel, type BuildOptions } from '@renderer/features/task/recordModel'
import { TaskRecord } from '@renderer/features/task/TaskRecord'
import { RecordActionsContext, latestRetryableErrorId } from '@renderer/features/task/record/WorkItems'
import { OPEN_MODEL_PICKER_EVENT } from '@renderer/features/chat/components/composer/modelPickerEvent'

/**
 * A provider that rejects the request is not fixed by typing in the composer:
 * the error row offers another model and the provider's settings, keeps the
 * raw code for Copy details, and the run says "Failed" once.
 */

afterEach(cleanup)

const T0 = Date.parse('2026-10-09T09:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

function show(code: string) {
  const items: UiItem[] = [
    { kind: 'message', id: 'u1', role: 'user', content: 'Fix add()', at: at(0) },
    { kind: 'run_error', id: 'e1', message: 'This model does not support tools with this many entries', code, at: at(3) }
  ]
  const options: BuildOptions = { running: false, failed: true }
  return render(
    <RecordActionsContext.Provider value={{ retryableErrorId: latestRetryableErrorId(items, false), onRetry: vi.fn() }}>
      <TaskRecord model={buildRecordModel(items, options)} options={options} messageCount={items.length} />
    </RecordActionsContext.Provider>
  )
}

describe('a provider error', () => {
  it('offers another model and the provider settings, not Retry, for a rejected request', () => {
    const { getByRole, container } = show('PROVIDER_REQUEST')
    const alert = getByRole('alert')
    expect(within(alert).getByRole('button', { name: 'Switch model' })).toBeTruthy()
    expect(within(alert).getByRole('button', { name: 'Provider settings' })).toBeTruthy()
    expect(within(alert).getByRole('button', { name: 'Copy error details' })).toBeTruthy()
    expect(within(alert).queryByRole('button', { name: 'Retry' })).toBeNull()
    // The raw code is for Copy details, not the row.
    expect(alert.textContent).not.toContain('PROVIDER_REQUEST')
    // Said once: the receipt does not repeat "Failed".
    expect(container.querySelector('[data-receipt-outcome="failed"]')).toBeNull()
  })

  it('asks the model picker to open on Switch model', () => {
    const seen = vi.fn()
    window.addEventListener(OPEN_MODEL_PICKER_EVENT, seen)
    const { getByRole } = show('PROVIDER_REQUEST')
    fireEvent.click(within(getByRole('alert')).getByRole('button', { name: 'Switch model' }))
    expect(seen).toHaveBeenCalledTimes(1)
    window.removeEventListener(OPEN_MODEL_PICKER_EVENT, seen)
  })

  it('keeps Retry first for a transient failure', () => {
    const { getByRole } = show('PROVIDER_TIMEOUT')
    const alert = getByRole('alert')
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(within(alert).queryByRole('button', { name: 'Provider settings' })).toBeNull()
  })
})
