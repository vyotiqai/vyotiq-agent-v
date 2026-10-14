import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { IPC } from '@shared/channels'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
const state = vi.hoisted(() => ({ dir: '', open: new Set<string>(), senderOk: true }))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) }
}))
vi.mock('@main/ipc/ipcShared', () => ({
  senderOk: () => state.senderOk,
  isOpenWorkspace: (path: string) => state.open.has(path),
  failFrom: (err: unknown) => ({ ok: false, error: err instanceof Error ? err.message : String(err) })
}))
vi.mock('@main/voice/sessions', () => ({ voiceLogDir: () => state.dir }))

import { registerVoiceConversationsIpc } from '@main/ipc/handlers/voiceConversations'

type Result = { ok: boolean; data?: unknown; error?: string }
const call = (channel: string, raw: unknown): Promise<Result> =>
  handlers.get(channel)!({ sender: { id: 1 } }, raw) as Promise<Result>

let root = ''
const ID = '2026-10-14T16-52-28-000Z_s1'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vyotiq-voiceipc-'))
  state.dir = join(root, 'voice')
  mkdirSync(state.dir)
  state.open = new Set(['C:/work'])
  state.senderOk = true
  writeFileSync(
    join(state.dir, `${ID}.jsonl`),
    [
      { at: '2026-10-14T16:52:28.000Z', kind: 'you', turnId: 't1', text: 'hello' },
      { at: '2026-10-14T16:52:29.000Z', kind: 'end' }
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n'
  )
  writeFileSync(join(root, 'outside.jsonl'), `${JSON.stringify({ at: 'x', kind: 'you', turnId: 't', text: 'outside' })}\n`)
  handlers.clear()
  registerVoiceConversationsIpc()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('voice conversation IPC (§24.8)', () => {
  it('lists and reads an open workspace’s conversations', async () => {
    const list = await call(IPC.voiceConversationsList, { workspacePath: 'C:/work' })
    expect(list.ok).toBe(true)
    expect(list.data).toEqual([expect.objectContaining({ id: ID, turns: 1, firstWords: 'hello' })])
    const one = await call(IPC.voiceConversationRead, { workspacePath: 'C:/work', id: ID })
    expect(one.ok).toBe(true)
    expect((one.data as { entries: unknown[] }).entries).toHaveLength(2)
  })

  it('refuses a workspace that is not open', async () => {
    expect(await call(IPC.voiceConversationsList, { workspacePath: 'C:/other' })).toEqual({ ok: false, error: 'Workspace is not open' })
    expect((await call(IPC.voiceConversationRead, { workspacePath: 'C:/other', id: ID })).ok).toBe(false)
  })

  it('refuses another sender', async () => {
    state.senderOk = false
    expect((await call(IPC.voiceConversationsList, { workspacePath: 'C:/work' })).error).toBe('Invalid sender')
  })

  it('rejects an id that is a path before touching the disk', async () => {
    for (const id of ['../outside', '..\\outside', `${ID}/../../outside`, 'outside', '']) {
      const res = await call(IPC.voiceConversationRead, { workspacePath: 'C:/work', id })
      expect(res.ok).toBe(false)
      expect(JSON.stringify(res)).not.toContain('outside"')
    }
  })

  it('rejects a malformed request', async () => {
    expect((await call(IPC.voiceConversationsList, {})).ok).toBe(false)
    expect((await call(IPC.voiceConversationRead, { workspacePath: 'C:/work' })).ok).toBe(false)
  })

  it('says a conversation is gone when its file is', async () => {
    const res = await call(IPC.voiceConversationRead, { workspacePath: 'C:/work', id: '2026-10-14T10-00-00-000Z_gone' })
    expect(res).toEqual({ ok: false, error: 'That voice conversation is no longer kept' })
  })
})
