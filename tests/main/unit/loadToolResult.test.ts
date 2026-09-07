import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    appendFile: vi.fn(actual.appendFile)
  }
})

const userData = join(tmpdir(), `vyotiq-load-tool-${process.pid}-${Date.now()}`)

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

import { appendMessage, loadToolResultContent } from '@main/agent/state'
import {
  enqueueMessageAppend,
  resetMessageAppendQueueForTests,
  takeMessageAppendFailureNotice
} from '@main/agent/messageAppendQueue'
import { resolveRunDir } from '@main/storage/paths'
import { appendFile } from 'fs/promises'

describe('loadToolResultContent', () => {
  let workspace: string
  const runId = 'run-1'

  beforeEach(() => {
    resetMessageAppendQueueForTests()
    mkdirSync(userData, { recursive: true })
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-ws-'))
    const runDir = resolveRunDir(workspace, runId)
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, 'status.json'),
      JSON.stringify({ status: 'done', step: 1, updatedAt: new Date().toISOString() }),
      'utf8'
    )
  })

  afterEach(() => {
    resetMessageAppendQueueForTests()
    if (workspace) rmSync(workspace, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  })

  it('returns full persisted tool message by toolCallId', async () => {
    const runDir = resolveRunDir(workspace, runId)
    const full = 'line\n'.repeat(3000)
    writeFileSync(
      join(runDir, 'messages.jsonl'),
      [
        JSON.stringify({ role: 'user', content: 'read big file' }),
        JSON.stringify({
          role: 'tool',
          toolCallId: 'call-abc',
          toolName: 'read',
          content: full
        })
      ].join('\n') + '\n',
      'utf8'
    )

    const content = await loadToolResultContent(workspace, runId, 'call-abc')
    expect(content).toBe(full)
  })

  it('returns null when tool call is missing', async () => {
    const runDir = resolveRunDir(workspace, runId)
    writeFileSync(
      join(runDir, 'messages.jsonl'),
      `${JSON.stringify({ role: 'user', content: 'hi' })}\n`,
      'utf8'
    )

    const content = await loadToolResultContent(workspace, runId, 'missing')
    expect(content).toBeNull()
  })

  it('waits for a queued live result before reading it back', async () => {
    const runDir = resolveRunDir(workspace, runId)
    appendMessage(runDir, {
      role: 'tool',
      toolCallId: 'queued',
      toolName: 'read',
      ok: true,
      content: 'full queued output'
    })

    await expect(loadToolResultContent(workspace, runId, 'queued')).resolves.toBe(
      'full queued output'
    )
  })

  it('still returns persisted content when a queued append failed (best-effort flush)', async () => {
    const runDir = resolveRunDir(workspace, runId)
    writeFileSync(
      join(runDir, 'messages.jsonl'),
      `${JSON.stringify({
        role: 'tool',
        toolCallId: 'persisted',
        toolName: 'read',
        content: 'already persisted output'
      })}\n`,
      'utf8'
    )

    // Record a real append failure for this run dir (non-transient EPERM).
    vi.mocked(appendFile).mockRejectedValueOnce(
      Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    )
    await expect(
      enqueueMessageAppend(
        runDir,
        `${JSON.stringify({ role: 'user', content: 'lost line' })}\n`
      )
    ).resolves.toBeUndefined()

    // The flush failure must not fail the whole read.
    await expect(loadToolResultContent(workspace, runId, 'persisted')).resolves.toBe(
      'already persisted output'
    )

    // The failure stays surfaced to the run via the notice path (single failure
    // keeps the raw error message; the file name appears only when aggregated).
    const notice = takeMessageAppendFailureNotice(runDir)
    expect(notice).toBeInstanceOf(Error)
    expect(notice?.message).toContain('EPERM')
    expect(takeMessageAppendFailureNotice(runDir)).toBeUndefined()
  })
})
