import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  ensureMemoryLayout,
  readMemoryIndexAsync,
  readMemoryStateAsync
} from '@main/agent/context/memory'

describe('memory async reads', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-mem-'))
    ensureMemoryLayout(workspace)
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('reads index and state concurrently without blocking each other', async () => {
    writeFileSync(join(workspace, '.vyotiq', 'memory', 'index.md'), '# Index\nalpha', 'utf8')
    writeFileSync(join(workspace, '.vyotiq', 'memory', 'state.md'), '# State\nbeta', 'utf8')

    const [index, state] = await Promise.all([
      readMemoryIndexAsync(workspace),
      readMemoryStateAsync(workspace)
    ])
    expect(index).toContain('alpha')
    expect(state).toContain('beta')
  })
})
