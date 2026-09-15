import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-window-${process.pid}-${Date.now()}`)

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

import { createRun, loadMessagesWindowAsync } from '@main/agent/state'
import { resolveRunDir } from '@main/storage/paths'

const workspacePath = join(tmpdir(), `vyotiq-window-ws-${process.pid}-${Date.now()}`)
const runId = 'window-run'

const messageLine = (text: string, at?: string): string =>
  JSON.stringify(at ? { role: 'user', content: text, at } : { role: 'user', content: text })

describe('loadMessagesWindowAsync (bounded transcript hydration)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mkdirSync(workspacePath, { recursive: true })
    createRun(workspacePath, runId, 'window', { mode: 'agent' })
  })

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true })
  })

  it('returns the most recent window and pages backwards to the start', async () => {
    const total = 1_000
    const runDir = resolveRunDir(workspacePath, runId)
    const rows = Array.from({ length: total }, (_, i) => messageLine(`m${i}`))
    writeFileSync(join(runDir, 'messages.jsonl'), `${rows.join('\n')}\n`)

    const first = await loadMessagesWindowAsync(workspacePath, runId, { limit: 400 })
    expect(first.messages).toHaveLength(400)
    expect(first.messages[0]).toMatchObject({ role: 'user', content: 'm600' })
    expect(first.messages[399]).toMatchObject({ role: 'user', content: 'm999' })
    expect(first.hasEarlier).toBe(true)
    expect(first.earlierCursor).toMatch(/^0:\d+$/)
    if (!first.earlierCursor) throw new Error('missing cursor')

    const second = await loadMessagesWindowAsync(workspacePath, runId, {
      limit: 400,
      cursor: first.earlierCursor
    })
    expect(second.messages).toHaveLength(400)
    expect(second.messages[0]).toMatchObject({ role: 'user', content: 'm200' })
    expect(second.messages[399]).toMatchObject({ role: 'user', content: 'm599' })
    expect(second.hasEarlier).toBe(true)
    expect(second.earlierCursor).toMatch(/^0:\d+$/)
    if (!second.earlierCursor) throw new Error('missing cursor')

    const third = await loadMessagesWindowAsync(workspacePath, runId, {
      limit: 400,
      cursor: second.earlierCursor
    })
    expect(third.messages).toHaveLength(200)
    expect(third.messages[0]).toMatchObject({ role: 'user', content: 'm0' })
    expect(third.messages[199]).toMatchObject({ role: 'user', content: 'm199' })
    expect(third.hasEarlier).toBe(false)
    expect(third.earlierCursor).toBeNull()
  })

  it('never reads past the byte budget even when the limit would allow the whole file', async () => {
    const runDir = resolveRunDir(workspacePath, runId)
    // 100 messages x ~60KB = ~6MB, above the 4MB window budget. The default
    // byte budget is 4MB, so the loader must return fewer than all 100 even
    // with limit 2000 — proof it never parses the whole file.
    const huge = 'x'.repeat(60_000)
    const rows = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({ role: 'assistant', content: `${i}:${huge}` })
    )
    writeFileSync(join(runDir, 'messages.jsonl'), `${rows.join('\n')}\n`)

    const window = await loadMessagesWindowAsync(workspacePath, runId, { limit: 2000 })
    expect(window.messages.length).toBeGreaterThan(0)
    expect(window.messages.length).toBeLessThan(100)
    expect(window.hasEarlier).toBe(true)
    expect(window.messages[window.messages.length - 1]).toMatchObject({
      role: 'assistant'
    })
    const lastContent = window.messages[window.messages.length - 1].content
    expect(typeof lastContent === 'string' ? lastContent : '').toMatch(/^99:/)
  })

  it('loads a small transcript fully with no earlier window', async () => {
    const runDir = resolveRunDir(workspacePath, runId)
    const rows = Array.from({ length: 5 }, (_, i) => messageLine(`s${i}`))
    writeFileSync(join(runDir, 'messages.jsonl'), `${rows.join('\n')}\n`)

    const window = await loadMessagesWindowAsync(workspacePath, runId)
    expect(window.messages).toHaveLength(5)
    expect(window.hasEarlier).toBe(false)
    expect(window.earlierCursor).toBeNull()
  })

  it('skips malformed lines inside a window instead of failing', async () => {
    const runDir = resolveRunDir(workspacePath, runId)
    const rows = [
      messageLine('m0'),
      messageLine('m1'),
      '{not json',
      messageLine('m2'),
      messageLine('m3')
    ]
    writeFileSync(join(runDir, 'messages.jsonl'), `${rows.join('\n')}\n`)

    const window = await loadMessagesWindowAsync(workspacePath, runId)
    expect(window.messages.map((m) => (typeof m.content === 'string' ? m.content : ''))).toEqual([
      'm0',
      'm1',
      'm2',
      'm3'
    ])
    expect(window.hasEarlier).toBe(false)
    expect(window.earlierCursor).toBeNull()
  })

  it('degrades gracefully on a stale cursor (rewritten transcript)', async () => {
    const runDir = resolveRunDir(workspacePath, runId)
    const rows = Array.from({ length: 10 }, (_, i) => messageLine(`m${i}`))
    writeFileSync(join(runDir, 'messages.jsonl'), `${rows.join('\n')}\n`)

    const window = await loadMessagesWindowAsync(workspacePath, runId, {
      limit: 5,
      cursor: '9:512'
    })
    expect(window.messages).toEqual([])
    expect(window.hasEarlier).toBe(false)
    expect(window.earlierCursor).toBeNull()
  })
})
