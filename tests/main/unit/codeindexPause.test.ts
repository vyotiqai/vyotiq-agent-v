import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(join(tmpdir(), 'vyotiq-pause-ud-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => join(tmpdir(), 'vyotiq-pause-app'),
    isPackaged: false
  }
}))

import { DEFAULT_SETTINGS } from '@shared/ipc'
import { getSettings, setSettings } from '@main/settings/settings'
import {
  disposeCodeIndexWorkspace,
  ensureCodeIndexSynced,
  getCodeIndexRuntimeStatus,
  isCodeIndexPaused
} from '@main/agent/codeindex'
import {
  clearWorkspaceIndexSyncTimers,
  disposeWorkspaceIndexes,
  pauseWorkspaceIndexes,
  scheduleWorkspaceIndexSync,
  warmWorkspaceIndexes
} from '@main/agent/workspaceIndex'
import { indexJobQueuePendingCountForTests, resetIndexJobQueueForTests } from '@main/agent/indexJobQueue'

let dir: string

const setPaused = (paths: string[]): void => {
  setSettings({ codeIndex: { ...(getSettings().codeIndex ?? DEFAULT_SETTINGS.codeIndex), pausedPaths: paths } })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vyotiq-pause-ws-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.ts'), 'export function alphaHelper(): number { return 1 }\n', 'utf8')
})

afterEach(() => {
  setPaused([])
  clearWorkspaceIndexSyncTimers()
  resetIndexJobQueueForTests()
  disposeWorkspaceIndexes(dir)
  disposeCodeIndexWorkspace(dir)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // sqlite may hold the file briefly on Windows
  }
  vi.useRealTimers()
})

describe('pausing a workspace’s index', () => {
  it('stops every way a sync starts — a direct sync, a warm, an edit’s debounce — and says Paused', async () => {
    setPaused([dir])
    expect(isCodeIndexPaused(dir)).toBe(true)
    // Case and slashes on Windows do not escape it.
    expect(isCodeIndexPaused(dir.toUpperCase().replace(/\\/g, '/'))).toBe(process.platform === 'win32')

    expect(await ensureCodeIndexSynced(dir)).toEqual({ sync: null, paused: true })
    expect(getCodeIndexRuntimeStatus()).toMatchObject({ phase: 'idle', message: 'Indexing paused', workspacePath: dir })

    warmWorkspaceIndexes(dir)
    expect(indexJobQueuePendingCountForTests()).toBe(0)

    vi.useFakeTimers()
    scheduleWorkspaceIndexSync(dir, 100)
    await vi.advanceTimersByTimeAsync(200)
    expect(indexJobQueuePendingCountForTests()).toBe(0)
  })

  it('pause drops what is queued; resume carries on and indexes', async () => {
    vi.useFakeTimers()
    scheduleWorkspaceIndexSync(dir, 1_000)
    setPaused([dir])
    pauseWorkspaceIndexes(dir)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(indexJobQueuePendingCountForTests()).toBe(0)
    vi.useRealTimers()

    setPaused([])
    const { sync } = await ensureCodeIndexSynced(dir)
    expect(sync?.status.chunkCount).toBeGreaterThan(0)
  })
})
