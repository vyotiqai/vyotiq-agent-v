import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => join(tmpdir(), 'vyotiq-app'),
    getPath: (name: string) => join(tmpdir(), name)
  }
}))

const runHarnessReviewMock = vi.hoisted(() =>
  vi.fn(async (_ws: string, opts?: { limit?: number }) => ({
    limit: opts?.limit
  }))
)

vi.mock('@main/agent/harnessReview', () => ({ runHarnessReview: runHarnessReviewMock }))

import { ensurePlanStub } from '@main/agent/planArtifacts'
import { runHarnessReviewWithSettings } from '@main/agent/harnessReviewRun'

describe('ensurePlanStub', () => {
  it('seeds plan.md with the default stub when missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-plan-stub-'))
    try {
      const planPath = join(dir, 'plan.md')
      ensurePlanStub(dir)
      expect(existsSync(planPath)).toBe(true)
      expect(readFileSync(planPath, 'utf8').length).toBeGreaterThan(0)
      // Second call is a no-op and must not clobber user content.
      writeFileSync(planPath, '## Custom user plan\n', 'utf8')
      ensurePlanStub(dir)
      expect(readFileSync(planPath, 'utf8')).toBe('## Custom user plan\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('runHarnessReviewWithSettings', () => {
  beforeEach(() => {
    runHarnessReviewMock.mockClear()
  })

  it('forwards limit', async () => {
    const result = await runHarnessReviewWithSettings('C:/ws', { limit: 5 })
    expect(runHarnessReviewMock).toHaveBeenCalledTimes(1)
    expect(result.limit).toBe(5)
  })

  it('omits limit when not requested', async () => {
    const result = await runHarnessReviewWithSettings('C:/ws')
    expect(result.limit).toBeUndefined()
  })
})
