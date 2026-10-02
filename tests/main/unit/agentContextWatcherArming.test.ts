/**
 * The agent context watcher on a Node that does not throw for a missing path.
 *
 * On Linux a recursive `fs.watch` is Node's own, and from Node 24 (the Node in
 * Electron 44) watching a folder that does not exist returns a watcher on
 * nothing instead of throwing ENOENT. The watcher counted that as armed, so a
 * `.vyotiq/memory` made after the workspace opened was never heard again: the
 * first note showed up (its parent reported it), every later one did not.
 *
 * `watch` here behaves like that Node on every platform: a missing path gets
 * a silent watcher, a recursive watch whose folder is deleted goes quiet
 * instead of reporting an error, and `.vyotiq/memory` always reports the same
 * inode, as a folder deleted and made again often does on ext4. Everything
 * else is the real code, real disk and real timers.
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceAgentContextResult } from '@shared/ipc'

const sent: WorkspaceAgentContextResult[] = []

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const watch = ((path: string, ...rest: unknown[]) => {
    if (!real.existsSync(path)) {
      // A watcher on nothing, as Node 24's Linux recursive watch returns.
      return Object.assign(new EventEmitter(), { close() {}, unref() {}, ref() {} })
    }
    const handle = (real.watch as (...args: unknown[]) => import('node:fs').FSWatcher)(path, ...rest)
    if (!(rest[0] as { recursive?: boolean } | undefined)?.recursive) return handle
    // Node's Linux recursive watch goes quiet when its folder is deleted; it
    // never reports an error the way Windows does.
    handle.on('error', () => {})
    return Object.assign(new EventEmitter(), {
      close: () => handle.close(),
      unref: () => handle.unref(),
      ref: () => handle.ref()
    })
  }) as typeof real.watch
  // ext4 often hands a folder made again the inode of the one just deleted, so
  // the inode alone cannot tell them apart; pin it to show that on any disk.
  const statSync = ((path: string, ...rest: unknown[]) => {
    const st = (real.statSync as (...args: unknown[]) => import('node:fs').Stats)(path, ...rest)
    if (st && String(path).endsWith('memory')) st.ino = 4242
    return st
  }) as typeof real.statSync
  return { ...real, default: { ...real, watch, statSync }, watch, statSync }
})

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => join(tmpdir(), `vyotiq-watcher-${name}`),
    getAppPath: () => join(tmpdir(), 'vyotiq-watcher-app'),
    isPackaged: false
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (_channel: string, payload: { context: WorkspaceAgentContextResult }) => sent.push(payload.context)
        }
      }
    ]
  }
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({ codeIndex: { enabled: false, pausedPaths: [] } })
}))

vi.mock('@main/git/gitStatusCache', () => ({
  readGitStatusCached: async () => ({ kind: 'not_repo' }),
  invalidateGitStatusCache: () => {}
}))

vi.mock('@main/agent/codeindex', () => ({
  getCodeIndexRuntimeStatus: () => ({ phase: 'idle', progress: null, message: null, error: null, indexProgress: null }),
  isCodeIndexPaused: () => false,
  onCodeIndexRuntimeStatus: () => () => {}
}))

const { armAgentContextWatch, stopAgentContextWatch } = await import('@main/agent/context/agentContextWatcher')
const { buildWorkspaceAgentContext } = await import('@main/agent/context/agentContext')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForNote(name: string, timeoutMs = 8_000): Promise<void> {
  const started = Date.now()
  while (!sent.some((c) => c.memoryNoteNames?.includes(name))) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`no push with note "${name}" within ${timeoutMs}ms; pushes: ${JSON.stringify(sent.map((c) => c.memoryNoteNames))}`)
    }
    await sleep(20)
  }
}

let workspace = ''
const notes = (): string => join(workspace, '.vyotiq', 'memory', 'notes')
function writeNote(name: string): void {
  mkdirSync(notes(), { recursive: true })
  writeFileSync(join(notes(), `${name}.md`), `- ${name}\n`, 'utf8')
}

beforeEach(async () => {
  sent.length = 0
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-agentctx-arming-'))
  const initial = await buildWorkspaceAgentContext(workspace, { enabled: false, phase: 'idle' })
  armAgentContextWatch(workspace, initial)
  // macOS starts its FSEvents stream asynchronously; let it settle before writing.
  await sleep(300)
})

afterEach(() => {
  stopAgentContextWatch(workspace)
  try {
    rmSync(workspace, { recursive: true, force: true })
  } catch {
    /* windows keeps a handle briefly; the temp dir is disposable anyway */
  }
})

describe('agent context watcher on a Node that does not throw for a missing folder', () => {
  it('hears notes in a memory folder made after the workspace opened', async () => {
    // The folder appears: its parent's watch reports it and the rebuild reads it.
    writeNote('first')
    await waitForNote('first')
    // Only the memory folder changes now. Before the fix nothing heard this.
    writeNote('second')
    await waitForNote('second')
  })

  it('hears notes again after the memory folder is deleted and made again', async () => {
    writeNote('before')
    await waitForNote('before')
    rmSync(join(workspace, '.vyotiq', 'memory'), { recursive: true, force: true })
    writeNote('remade')
    await waitForNote('remade')
    writeNote('after')
    await waitForNote('after')
  })
})
