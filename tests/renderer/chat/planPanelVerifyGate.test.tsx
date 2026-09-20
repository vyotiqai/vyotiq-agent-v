/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PlanPanel } from '@renderer/features/chat/components/PlanPanel'

beforeEach(() => {
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: {
      readRunArtifact: vi.fn(),
      slashCommandsOpenFile: vi.fn()
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

type GateFixture = {
  wouldFire: boolean
  reason?: 'never_checked' | 'check_failed'
  paths?: string[]
}

function mockReceipt(verificationGate?: GateFixture): void {
  window.vyotiq.readRunArtifact = vi.fn().mockImplementation(async (req: { name?: string }) => {
    if (req.name !== 'receipt.json') {
      return { ok: true, data: { name: req.name ?? '', exists: false, content: null } }
    }
    return {
      ok: true,
      data: {
        name: 'receipt.json',
        exists: true,
        content: JSON.stringify({
          version: 5,
          writtenAt: '2026-09-19T00:00:00.000Z',
          runId: 'run-gate',
          status: 'done',
          step: 2,
          compactionCount: 0,
          toolStats: { totalCalls: 1, ok: 1, failed: 0, byName: {} },
          failureClusters: [],
          unreadEditPaths: [],
          wroteFiles: ['src/a.ts'],
          diagnostics: { calls: 0, ok: 0, clean: 0 },
          contractExcerpt: '',
          ...(verificationGate ? { verificationGate } : {})
        })
      }
    }
  })
}

async function openReceipt(): Promise<void> {
  render(<PlanPanel workspacePath="/ws" runId="run-gate" running={false} />)
  fireEvent.click(screen.getByRole('tab', { name: 'Receipt' }))
  await waitFor(() => {
    expect(screen.getByText('Status')).toBeTruthy()
  })
}

describe('PlanPanel verification gate chip', () => {
  it('surfaces a run that changed files without a passing check', async () => {
    mockReceipt({ wouldFire: true, reason: 'never_checked', paths: ['src/a.ts'] })
    await openReceipt()

    expect(screen.getByText('unchecked')).toBeTruthy()
    expect(screen.getByText('no check')).toBeTruthy()
  })

  it('distinguishes a check that ran and failed', async () => {
    mockReceipt({ wouldFire: true, reason: 'check_failed', paths: ['src/a.ts'] })
    await openReceipt()

    expect(screen.getByText('check failed')).toBeTruthy()
  })

  it('stays silent when the work was verified', async () => {
    mockReceipt({ wouldFire: false })
    await openReceipt()

    expect(screen.queryByText('unchecked')).toBeNull()
  })

  it('stays silent on a receipt written before the gate existed', async () => {
    mockReceipt(undefined)
    await openReceipt()

    expect(screen.queryByText('unchecked')).toBeNull()
  })
})
