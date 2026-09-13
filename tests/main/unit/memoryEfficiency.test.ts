import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  countTextTokens,
  resetTokenizerCache,
  tokenizerCacheKeyContains
} from '@main/agent/context/tokenizer'
import { truncateToolArgsPreview } from '@shared/utils/toolResultIpc'

const userData = join(tmpdir(), `vyotiq-mem-eff-${process.pid}-${Date.now()}`)

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

describe('tokenizer cache keys', () => {
  beforeEach(() => {
    resetTokenizerCache()
  })

  it('returns identical counts for long strings without retaining them as Map keys', () => {
    const marker = `mem-eff-unique-${Date.now()}-${'x'.repeat(4000)}`
    const first = countTextTokens(marker)
    const second = countTextTokens(marker)
    expect(second).toBe(first)
    expect(first).toBeGreaterThan(0)
    // Hashed keys must not pin the full body (or its unique prefix) in the Map.
    expect(tokenizerCacheKeyContains(marker.slice(0, 64))).toBe(false)
  })
})

describe('tool args preview cap', () => {
  it('truncates oversized argument previews', () => {
    const huge = 'a'.repeat(10_000)
    const preview = truncateToolArgsPreview(huge)
    expect(preview.length).toBeLessThan(huge.length)
    expect(preview.endsWith('\n…')).toBe(true)
  })
})

describe('loadWorkingMessagesForFold', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-fold-'))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('skips folded prefix without returning those tool bodies', async () => {
    const { createRun, appendMessage, loadWorkingMessagesForFold, flushMessageAppends } =
      await import('@main/agent/state')
    const runId = 'run-fold-mem'
    const runDir = createRun(workspace, runId, 'goal')
    const big = `FOLDED-${'x'.repeat(50_000)}`
    appendMessage(runDir, { role: 'user', content: 'start' })
    appendMessage(runDir, {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
    })
    appendMessage(runDir, {
      role: 'tool',
      toolCallId: 'c1',
      toolName: 'read',
      content: big,
      ok: true
    })
    appendMessage(runDir, { role: 'user', content: 'continue' })
    appendMessage(runDir, { role: 'assistant', content: 'kept after fold' })
    await flushMessageAppends(runDir)

    const { messages, foldedMessages } = loadWorkingMessagesForFold(workspace, runId, 3)
    expect(foldedMessages).toBe(3)
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('user')
    expect(messages[1]?.role).toBe('assistant')
    const joined = JSON.stringify(messages)
    expect(joined).not.toContain('FOLDED-')
    expect(joined).toContain('kept after fold')
  })
})

vi.mock('@main/workspace/workspaces', () => ({
  getWorkspaces: () => ({
    openPaths: ['C:\\ws\\a'],
    recentPaths: [],
    activePath: 'C:\\ws\\a'
  })
}))

describe('load snapshot fields', () => {
  it('reports main-process RSS directly', async () => {
    const { collectLoadSnapshot } = await import('@main/perf/loadSnapshot')
    const snap = collectLoadSnapshot()
    expect(snap.rssMb).toBeGreaterThan(0)
  })
})
