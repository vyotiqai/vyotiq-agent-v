/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'

const spies = vi.hoisted(() => ({
  collectLastTurnChangedFiles: vi.fn(() => [] as unknown[]),
  collectLastTurnFileDiffs: vi.fn(() => new Map()),
  collectSessionChangedFiles: vi.fn(() => [] as unknown[]),
  collectSessionFileDiffs: vi.fn(() => new Map()),
  mergeCheckpointChangedFiles: vi.fn((files: unknown) => files),
  checkpointOnlyChangedFiles: vi.fn(() => [])
}))

vi.mock('@renderer/features/chat/utils/turnFileDiffs', () => spies)

import { ChangesPanel } from '@renderer/features/chat/components/ChangesPanel'

function toolItem(id: string): UiItem {
  return {
    kind: 'tool',
    id,
    tool: { name: 'read', summary: id, status: 'done' }
  } as unknown as UiItem
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: {}
  })
})

afterEach(() => {
  cleanup()
})

describe('ChangesPanel hidden dock gating', () => {
  it('does not recompute session diff collectors while hidden', () => {
    const { rerender } = render(
      <ChangesPanel items={[toolItem('a')]} workspacePath="/ws" gitRevision={1} active={false} />
    )
    const atMount = spies.collectSessionFileDiffs.mock.calls.length
    expect(atMount).toBeGreaterThan(0)

    rerender(
      <ChangesPanel
        items={[toolItem('a'), toolItem('b')]}
        workspacePath="/ws"
        gitRevision={2}
        active={false}
      />
    )
    expect(spies.collectSessionFileDiffs.mock.calls.length).toBe(atMount)
    expect(spies.collectSessionChangedFiles.mock.calls.length).toBe(atMount)
    expect(spies.collectLastTurnFileDiffs.mock.calls.length).toBe(atMount)
  })
})
