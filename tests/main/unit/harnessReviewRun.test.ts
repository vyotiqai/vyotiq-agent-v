import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ensurePlanStub } from '@main/agent/planArtifacts'

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
