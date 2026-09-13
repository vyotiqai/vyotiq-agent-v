import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-atomic-${process.pid}-${Date.now()}`)

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

import { appendMessage, flushMessageAppends, loadMessages, saveCompaction } from '@main/agent/state'
import { resolveRunDir, workspaceSessionsRoot } from '@main/storage/paths'

describe('atomic run persistence', () => {
  beforeEach(() => {
    mkdirSync(userData, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('rewrites messages.jsonl atomically on append', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-atomic-ws-'))
    const runId = 'atomic-run'
    const dir = resolveRunDir(workspace, runId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'messages.jsonl'), '', 'utf8')
    writeFileSync(
      join(dir, 'status.json'),
      '{"status":"running","step":0,"updatedAt":"2026-01-01T00:00:00.000Z"}',
      'utf8'
    )

    appendMessage(dir, { role: 'user', content: 'hello' })
    appendMessage(dir, { role: 'assistant', content: 'world' })
    await flushMessageAppends(dir)

    const messages = loadMessages(workspace, runId)
    expect(messages).toHaveLength(2)
    expect(messages[0]?.content).toBe('hello')
    expect(existsSync(join(dir, 'messages.jsonl.tmp'))).toBe(false)
    expect(readFileSync(join(dir, 'messages.jsonl'), 'utf8')).toContain('"hello"')
  })

  it('keeps resolved run directories inside the workspace sessions root', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-atomic-escape-'))
    const sessions = workspaceSessionsRoot(workspace)

    expect(resolveRunDir(workspace, 'good-run')).toBe(join(sessions, 'good-run'))
    const existing = resolveRunDir(workspace, 'existing-run')
    mkdirSync(existing, { recursive: true })
    expect(resolveRunDir(workspace, 'existing-run')).toBe(existing)
    for (const runId of ['..', join('..', '..', '..'), '../sibling', userData]) {
      expect(() => resolveRunDir(workspace, runId)).toThrow(/run id/i)
    }
  })

  it('writes compaction.json atomically', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-atomic-compact-'))
    const runId = 'compact-run'
    const dir = resolveRunDir(workspace, runId)
    mkdirSync(dir, { recursive: true })

    saveCompaction(dir, {
      summary: 'summary text',
      createdAt: '2026-01-01T00:00:00.000Z',
      tokenEstimate: 42
    })

    const raw = JSON.parse(readFileSync(join(dir, 'compaction.json'), 'utf8')) as {
      summary: string
    }
    expect(raw.summary).toBe('summary text')
    expect(existsSync(join(dir, 'compaction.json.tmp'))).toBe(false)
  })
})
