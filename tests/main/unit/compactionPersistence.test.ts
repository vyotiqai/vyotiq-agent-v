import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-compact-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

import {
  createRun,
  loadCompaction,
  readContract,
  saveCompaction
} from '@main/agent/state'

const root = join(tmpdir(), `vyotiq-compact-${process.pid}-${Date.now()}`)
const workspace = join(root, 'ws')

describe('compaction persistence', () => {
  beforeEach(() => {
    mkdirSync(workspace, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  })

  it('round-trips compaction.json', () => {
    const runId = 'run-1'
    const dir = createRun(workspace, runId, 'test goal')
    const record = {
      summary: '## Session Intent\nDid things',
      createdAt: new Date().toISOString(),
      tokenEstimate: 42
    }
    saveCompaction(dir, record)
    expect(loadCompaction(dir)).toEqual(record)
  })

  it('round-trips compaction observability metadata', () => {
    const runId = 'run-meta'
    const dir = createRun(workspace, runId, 'meta goal')
    const record = {
      summary: '## Session Intent\nFolded',
      createdAt: new Date().toISOString(),
      tokenEstimate: 120,
      foldedMessages: 8,
      triggerReason: 'proactive' as const,
      messagesFolded: 6,
      keptMessages: 2,
      postCompactEstimatedTokens: 15_000,
      contentWindowAtCompact: 128_000,
      retainedDecisions: ['Use JWT'],
      verified: true,
      verifyCoverage: 1,
      verifyFailures: []
    }
    saveCompaction(dir, record)
    expect(loadCompaction(dir)).toEqual(record)
  })

  it('reads contract.md with cap', () => {
    const runId = 'run-2'
    const dir = createRun(workspace, runId, 'short goal')
    const contract = readContract(dir)
    expect(contract).toContain('short goal')
    writeFileSync(join(dir, 'contract.md'), 'x'.repeat(5000), 'utf8')
    expect(readContract(dir).length).toBeLessThanOrEqual(4003)
  })
})
