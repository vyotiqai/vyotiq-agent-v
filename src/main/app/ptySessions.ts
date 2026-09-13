import { randomUUID } from 'crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { IPty } from 'node-pty'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc/channels'
import { workspacePathIsInside, workspacePathsEqual } from '../../shared/workspacePath'
import { getSettings } from '../settings/settings'
import {
  commandOnPath,
  killProcessTree,
  killProcessTreeAndWait,
  resolveTerminalShell,
  sanitizedTerminalEnv
} from '../agent/tools/terminal'
import type { PtySessionInfo } from '../../shared/ipc'
import { getMainWindow } from './window'

// `IPty` is a type-only import — erased at runtime, so the optional node-pty
// dependency still loads lazily via tryLoadPty() with the pipe fallback.
type SessionBackend =
  | { kind: 'pty'; pty: IPty }
  | { kind: 'pipe'; child: ChildProcessWithoutNullStreams }

type PtyHandle = {
  id: string
  title: string
  cwd: string
  workspacePath: string
  running: boolean
  backend: SessionBackend
  /** Ring buffer for macOS window recreate / late subscriber recovery. */
  scrollbackChunks: string[]
  scrollbackLength: number
}

const sessions = new Map<string, PtyHandle>()
const PTY_SCROLLBACK_MAX = 200_000

function appendScrollback(handle: PtyHandle, data: string): void {
  handle.scrollbackChunks.push(data)
  handle.scrollbackLength += data.length
  // Drop whole oldest chunks instead of re-slicing a max-size string per chunk.
  while (handle.scrollbackLength > PTY_SCROLLBACK_MAX && handle.scrollbackChunks.length > 1) {
    const dropped = handle.scrollbackChunks[0]
    handle.scrollbackChunks.shift()
    handle.scrollbackLength -= dropped.length
  }
}

function scrollbackText(handle: PtyHandle): string {
  return handle.scrollbackChunks.length === 1
    ? handle.scrollbackChunks[0]
    : handle.scrollbackChunks.join('')
}

function shellTitle(): string {
  const resolved = resolveTerminalShell(getSettings().terminalShell ?? 'auto')
  if (resolved === 'powershell') return 'PowerShell'
  if (resolved === 'cmd') return 'cmd'
  return 'bash'
}

function shellBinAndArgs(): { file: string; args: string[] } {
  const preference = getSettings().terminalShell ?? 'auto'
  const resolved = resolveTerminalShell(preference)
  if (resolved === 'powershell') {
    // Prefer pwsh on PATH (same as agent terminal tool), else Windows PowerShell 5.x.
    const file =
      process.platform === 'win32'
        ? commandOnPath('pwsh')
          ? 'pwsh'
          : 'powershell.exe'
        : 'pwsh'
    return { file, args: ['-NoLogo'] }
  }
  if (resolved === 'cmd') {
    return { file: 'cmd.exe', args: [] }
  }
  if (resolved === 'bash') {
    return { file: 'bash', args: ['-l'] }
  }
  const shell = process.env.SHELL || '/bin/bash'
  return { file: shell, args: ['-l'] }
}

function tryLoadPty(): typeof import('node-pty') | null {
  try {
    return require('node-pty') as typeof import('node-pty')
  } catch {
    return null
  }
}

export function listPtySessions(
  workspacePath?: string,
  sessionFilter?: (sessionWorkspace: string) => boolean
): PtySessionInfo[] {
  let entries = [...sessions.values()]
  if (workspacePath) {
    entries = entries.filter((s) => workspacePathsEqual(s.workspacePath, workspacePath))
  }
  if (sessionFilter) {
    entries = entries.filter((s) => sessionFilter(s.workspacePath))
  }
  return entries.map((s) => ({
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    running: s.running,
    backend: s.backend.kind
  }))
}

export function createPtySession(opts: {
  cwd: string
  cols?: number
  rows?: number
  sendTo: BrowserWindow
}): PtySessionInfo {
  const id = randomUUID()
  const title = shellTitle()
  const { file, args } = shellBinAndArgs()
  const nodePty = tryLoadPty()
  // Placeholder until backend is ready so early data is retained for recreate replay.
  const handle: PtyHandle = {
    id,
    title,
    cwd: opts.cwd,
    workspacePath: opts.cwd,
    running: true,
    backend: { kind: 'pipe', child: null as unknown as ChildProcessWithoutNullStreams },
    scrollbackChunks: [],
    scrollbackLength: 0
  }
  sessions.set(id, handle)

  const rawSend = (channel: string, payload: unknown): void => {
    const current = getMainWindow()
    const target =
      current && !current.isDestroyed()
        ? current
        : !opts.sendTo.isDestroyed()
          ? opts.sendTo
          : null
    if (!target || target.webContents.isDestroyed()) return
    target.webContents.send(channel, payload)
  }

  // Coalesce PTY output into one IPC message per flush window. Chatty builds
  // emit hundreds of tiny chunks/sec; batching keeps structured-clone + send
  // overhead flat while preserving exact byte order via concatenation.
  const PTY_BATCH_FLUSH_MS = 16
  let pendingChunks: string[] | null = null
  let flushTimer: NodeJS.Timeout | null = null

  const flushPtyData = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    const chunks = pendingChunks
    pendingChunks = null
    if (!chunks || chunks.length === 0) return
    rawSend(IPC.ptyData, { id, data: chunks.length === 1 ? chunks[0] : chunks.join('') })
  }

  const send = (channel: string, payload: unknown): void => {
    if (
      channel === IPC.ptyData &&
      payload &&
      typeof payload === 'object' &&
      'data' in payload &&
      typeof (payload as { data: unknown }).data === 'string'
    ) {
      const data = (payload as { data: string }).data
      appendScrollback(handle, data)
      if (!pendingChunks) pendingChunks = []
      pendingChunks.push(data)
      if (!flushTimer) {
        flushTimer = setTimeout(flushPtyData, PTY_BATCH_FLUSH_MS)
      }
      return
    }
    // Non-data events (exit) must not overtake buffered output.
    if (channel === IPC.ptyExit) flushPtyData()
    rawSend(channel, payload)
  }

  let backend: SessionBackend | null = null
  let usedPipeFallback = false

  if (nodePty) {
    try {
      const pty = nodePty.spawn(file, args, {
        name: 'xterm-color',
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        cwd: opts.cwd,
        env: sanitizedTerminalEnv()
      })
      backend = { kind: 'pty', pty }
      pty.onData((data: string) => {
        send(IPC.ptyData, { id, data })
      })
      pty.onExit(({ exitCode }: { exitCode: number }) => {
        handle.running = false
        send(IPC.ptyExit, { id, exitCode })
      })
    } catch {
      backend = null
      usedPipeFallback = true
    }
  } else {
    usedPipeFallback = true
  }

  if (!backend) {
    // Fallback when native node-pty cannot load or spawn (missing rebuild / Spectre libs).
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: sanitizedTerminalEnv(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    backend = { kind: 'pipe', child }
    const push = (buf: Buffer): void => {
      send(IPC.ptyData, { id, data: buf.toString('utf8') })
    }
    let terminalSent = false
    const finish = (exitCode: number | null): void => {
      if (terminalSent) return
      terminalSent = true
      handle.running = false
      send(IPC.ptyExit, { id, exitCode })
    }
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    child.on('error', (err) => {
      push(Buffer.from(`[vyotiq] Failed to start shell: ${err.message}\r\n`, 'utf8'))
      finish(1)
    })
    child.on('exit', (code) => {
      finish(typeof code === 'number' ? code : null)
    })
    if (usedPipeFallback) {
      send(IPC.ptyData, {
        id,
        data: `[vyotiq] Interactive PTY unavailable (node-pty not built). Using pipe shell fallback.\r\n`
      })
    }
  }

  handle.backend = backend
  return { id, title, cwd: opts.cwd, running: true, backend: backend.kind }
}

/** Rebind PTY output to a freshly created main window (macOS activate recreate). */
export function replayPtySessionsToWindow(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  for (const s of sessions.values()) {
    if (s.scrollbackLength === 0) continue
    win.webContents.send(IPC.ptyData, { id: s.id, data: scrollbackText(s) })
  }
}

/** Test helper: seed scrollback without depending on shell echo. */
export function seedPtyScrollbackForTests(id: string, data: string): void {
  const handle = sessions.get(id)
  if (handle) appendScrollback(handle, data)
}

export function ptySessionMatchesWorkspace(id: string, workspacePath: string): boolean {
  const s = sessions.get(id)
  return s != null && workspacePathsEqual(s.workspacePath, workspacePath)
}

export function writePty(id: string, data: string, workspacePath?: string): boolean {
  const s = sessions.get(id)
  if (!s?.running) return false
  if (workspacePath && !workspacePathsEqual(s.workspacePath, workspacePath)) return false
  if (s.backend.kind === 'pty') {
    s.backend.pty.write(data)
    return true
  }
  try {
    s.backend.child.stdin.write(data)
    return true
  } catch {
    return false
  }
}

export function resizePty(id: string, cols: number, rows: number, workspacePath?: string): boolean {
  const s = sessions.get(id)
  if (!s || s.backend.kind !== 'pty') return false
  if (workspacePath && !workspacePathsEqual(s.workspacePath, workspacePath)) return false
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) return false
  try {
    s.backend.pty.resize(cols, rows)
    return true
  } catch {
    return false
  }
}

function backendPid(backend: SessionBackend): number | undefined {
  if (backend.kind === 'pty') {
    const pid = backend.pty.pid
    return typeof pid === 'number' && Number.isFinite(pid) && pid > 0 ? pid : undefined
  }
  const pid = backend.child.pid
  return typeof pid === 'number' && Number.isFinite(pid) && pid > 0 ? pid : undefined
}

export function killPty(id: string, workspacePath?: string): boolean {
  const s = sessions.get(id)
  if (!s) return false
  if (workspacePath && !workspacePathsEqual(s.workspacePath, workspacePath)) return false
  try {
    if (s.backend.kind === 'pty') s.backend.pty.kill()
    else s.backend.child.kill()
  } catch {
    /* ignore */
  }
  // The interactive shell may have spawned long-lived grandchildren (dev
  // servers, watchers). Killing only the direct child orphans them, so walk
  // the process tree as well. Fire-and-forget: the session is already gone.
  const pid = backendPid(s.backend)
  if (pid) killProcessTree(pid, 'pty-session-terminate')
  sessions.delete(id)
  return true
}

export function disposePtySessionsForWorkspace(workspacePath: string): number {
  let n = 0
  for (const s of [...sessions.values()]) {
    if (!workspacePathsEqual(s.workspacePath, workspacePath)) continue
    if (killPty(s.id)) n += 1
  }
  return n
}

/** Kill PTY/pipe shells whose cwd or workspace sits under `root` (instance worktree teardown). */
export async function disposePtySessionsUnderPath(root: string): Promise<number> {
  const trimmed = root.trim()
  if (!trimmed) return 0
  const pids: number[] = []
  let n = 0
  for (const s of [...sessions.values()]) {
    if (!workspacePathIsInside(trimmed, s.cwd) && !workspacePathIsInside(trimmed, s.workspacePath)) {
      continue
    }
    const pid = backendPid(s.backend)
    if (pid) pids.push(pid)
    if (killPty(s.id)) n += 1
  }
  await Promise.all(pids.map((pid) => killProcessTreeAndWait(pid, 'worktree-pty-teardown')))
  return n
}

export function disposeAllPtySessions(): void {
  for (const id of [...sessions.keys()]) {
    killPty(id)
  }
}
