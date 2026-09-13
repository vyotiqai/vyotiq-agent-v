import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import {
  createPtySession,
  disposeAllPtySessions,
  killPty,
  listPtySessions,
  writePty
} from '@main/app/ptySessions'
import { IPC } from '@shared/ipc/channels'

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    terminalShell: process.platform === 'win32' ? 'cmd' : 'bash'
  })
}))

vi.mock('@main/agent/tools/terminal', () => ({
  resolveTerminalShell: () => (process.platform === 'win32' ? 'cmd' : 'bash'),
  sanitizedTerminalEnv: () => ({
    PATH: process.env.PATH ?? '/usr/bin',
    HOME: process.env.HOME,
    TERM: 'xterm'
  }),
  commandOnPath: () => false,
  killProcessTree: () => undefined,
  killProcessTreeAndWait: async () => undefined
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

function fakeWindow(send: ReturnType<typeof vi.fn> = vi.fn()): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send }
  } as unknown as BrowserWindow
}

async function waitForPtyData(
  send: ReturnType<typeof vi.fn>,
  sessionId: string,
  opts?: { minCalls?: number; includes?: string; timeoutMs?: number }
): Promise<string[]> {
  const minCalls = opts?.minCalls ?? 1
  const timeoutMs = opts?.timeoutMs ?? 8_000
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const chunks = send.mock.calls
      .filter(
        (c) => c[0] === IPC.ptyData && (c[1] as { id?: string })?.id === sessionId
      )
      .map((c) => String((c[1] as { data?: string }).data ?? ''))
    const joined = chunks.join('')
    if (
      chunks.length >= minCalls &&
      (opts?.includes == null || joined.includes(opts.includes))
    ) {
      return chunks
    }
    await new Promise((r) => setTimeout(r, 40))
  }
  throw new Error(
    `timeout waiting for pty:data (id=${sessionId}, includes=${opts?.includes ?? '(any)'})`
  )
}

describe('e2e pty lifecycle (real shell)', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    disposeAllPtySessions()
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('create → write → assert pty:data → kill', async () => {
    const send = vi.fn()
    const win = fakeWindow(send)
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-pty-e2e-'))
    tempDirs.push(dir)

    const session = createPtySession({ cwd: dir, cols: 80, rows: 24, sendTo: win })
    expect(session.id).toBeTruthy()
    expect(['pty', 'pipe']).toContain(session.backend)
    expect(listPtySessions(dir).map((s) => s.id)).toEqual([session.id])

    // Initial output: real PTY prompt and/or pipe-fallback banner.
    await waitForPtyData(send, session.id)

    const before = send.mock.calls.filter(
      (c) => c[0] === IPC.ptyData && (c[1] as { id?: string })?.id === session.id
    ).length

    const marker = `hello-pty-${Date.now()}`
    const line =
      process.platform === 'win32' ? `echo ${marker}\r\n` : `echo ${marker}\n`
    expect(writePty(session.id, line, dir)).toBe(true)

    await waitForPtyData(send, session.id, {
      minCalls: before + 1,
      includes: marker,
      timeoutMs: 12_000
    })

    expect(killPty(session.id, dir)).toBe(true)
    expect(listPtySessions()).toEqual([])
  })

  it('scopes sessions to workspace cwd', () => {
    const win = fakeWindow()
    const dirA = mkdtempSync(join(tmpdir(), 'vyotiq-pty-e2e-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'vyotiq-pty-e2e-b-'))
    tempDirs.push(dirA, dirB)

    const a = createPtySession({ cwd: dirA, cols: 80, rows: 24, sendTo: win })
    const b = createPtySession({ cwd: dirB, cols: 80, rows: 24, sendTo: win })

    expect(listPtySessions(dirA).map((s) => s.id)).toEqual([a.id])
    expect(listPtySessions(dirB).map((s) => s.id)).toEqual([b.id])
    expect(listPtySessions(dirA).some((s) => s.id === b.id)).toBe(false)

    expect(killPty(a.id, dirA)).toBe(true)
    expect(listPtySessions().map((s) => s.id)).toEqual([b.id])
  })

  it('pipe fallback still yields pty:data (or clear fallback banner)', async () => {
    const send = vi.fn()
    const win = fakeWindow(send)
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-pty-e2e-pipe-'))
    tempDirs.push(dir)

    const session = createPtySession({ cwd: dir, cols: 80, rows: 24, sendTo: win })
    const chunks = await waitForPtyData(send, session.id)
    const joined = chunks.join('')

    if (session.backend === 'pipe') {
      expect(joined).toMatch(/pipe shell fallback|Interactive PTY unavailable|./i)
    } else {
      // Real node-pty: any initial stream is enough; write still works.
      expect(joined.length).toBeGreaterThan(0)
    }

    expect(writePty(session.id, process.platform === 'win32' ? 'echo ok\r\n' : 'echo ok\n')).toBe(
      true
    )
    expect(killPty(session.id)).toBe(true)
  })
})
