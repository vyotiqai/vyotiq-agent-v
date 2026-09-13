import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import {
  createPtySession,
  disposeAllPtySessions,
  disposePtySessionsForWorkspace,
  disposePtySessionsUnderPath,
  killPty,
  listPtySessions,
  replayPtySessionsToWindow,
  resizePty,
  seedPtyScrollbackForTests,
  writePty
} from '@main/app/ptySessions'

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({ terminalShell: 'cmd' })
}))

vi.mock('@main/agent/tools/terminal', () => ({
  resolveTerminalShell: () => 'cmd',
  sanitizedTerminalEnv: () => ({ PATH: '/usr/bin' }),
  commandOnPath: () => false,
  killProcessTree: () => undefined,
  killProcessTreeAndWait: async () => undefined
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

function fakeWindow(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() }
  } as unknown as BrowserWindow
}

describe('ptySessions', () => {
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

  it('starts with no sessions', () => {
    expect(listPtySessions()).toEqual([])
  })

  it('killPty returns false for unknown ids', () => {
    expect(killPty('missing-id')).toBe(false)
  })

  it('disposeAllPtySessions is safe when empty', () => {
    expect(() => disposeAllPtySessions()).not.toThrow()
    expect(listPtySessions()).toEqual([])
  })

  it('resizePty rejects tiny dimensions and unknown ids', () => {
    expect(resizePty('missing', 1, 24)).toBe(false)
    expect(resizePty('missing', 80, 0)).toBe(false)
  })

  it('scopes list and dispose to workspace cwd', () => {
    const win = fakeWindow()
    const dirA = mkdtempSync(join(tmpdir(), 'vyotiq-pty-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'vyotiq-pty-b-'))
    tempDirs.push(dirA, dirB)
    const a = createPtySession({ cwd: dirA, cols: 80, rows: 24, sendTo: win })
    const b = createPtySession({ cwd: dirB, cols: 80, rows: 24, sendTo: win })
    expect(listPtySessions()).toHaveLength(2)
    expect(listPtySessions(dirA).map((s) => s.id)).toEqual([a.id])
    expect(listPtySessions(dirB).map((s) => s.id)).toEqual([b.id])
    expect(disposePtySessionsForWorkspace(dirA)).toBe(1)
    expect(listPtySessions().map((s) => s.id)).toEqual([b.id])
    expect(writePty(a.id, 'x')).toBe(false)
    expect(writePty(b.id, 'x')).toBe(true)
  })

  it('disposes sessions whose cwd sits under a worktree path', async () => {
    const win = fakeWindow()
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-pty-root-'))
    const nested = join(root, 'nested')
    const other = mkdtempSync(join(tmpdir(), 'vyotiq-pty-other-'))
    tempDirs.push(root, other)
    mkdirSync(nested, { recursive: true })
    const inside = createPtySession({ cwd: nested, cols: 80, rows: 24, sendTo: win })
    const outside = createPtySession({ cwd: other, cols: 80, rows: 24, sendTo: win })
    await expect(disposePtySessionsUnderPath(root)).resolves.toBe(1)
    expect(listPtySessions().map((s) => s.id)).toEqual([outside.id])
    expect(writePty(inside.id, 'x')).toBe(false)
  })

  it('replays buffered scrollback to a recreated window', () => {
    const win = fakeWindow()
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-pty-replay-'))
    tempDirs.push(dir)
    const session = createPtySession({ cwd: dir, cols: 80, rows: 24, sendTo: win })
    seedPtyScrollbackForTests(session.id, 'hello-scrollback\r\n')
    const other = fakeWindow()
    replayPtySessionsToWindow(other)
    const replayed = (other.webContents.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'pty:data' && (c[1] as { id?: string })?.id === session.id
    )
    expect(replayed.length).toBeGreaterThan(0)
    expect(String((replayed[0]?.[1] as { data?: string })?.data ?? '')).toContain('hello-scrollback')
  })
})
