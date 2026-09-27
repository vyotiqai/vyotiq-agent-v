/**
 * The live "what the agent will see" strip, on the real main-process code.
 *
 * Two failures this file pins down, both of which froze the strip on its
 * boot-time reading on Windows:
 *
 *  1. `schedule` restarted its 250ms debounce on *every* fs event, so an event
 *     storm — what `rm -rf .vyotiq/memory` produces against an armed recursive
 *     watch — slid the window forward forever and the summary was never rebuilt.
 *  2. The name filter compared with `Array.includes` on the exact spelling, so
 *     a workspace holding `agents.md` (which NTFS resolves for `AGENTS.md`)
 *     had every one of its events dropped.
 *
 * Real `node:fs` events, real `buildWorkspaceAgentContext`, real timers — only
 * Electron, settings, the git cache and the code-index runtime are stubbed, so
 * the timing under test is the timing that ships.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceAgentContextResult } from '@shared/ipc'

const sent: WorkspaceAgentContextResult[] = []
const send = vi.fn((_channel: string, payload: { context: WorkspaceAgentContextResult }) => {
  sent.push(payload.context)
})

/** What the stubbed branch read answers; flipped by the git-cache test. */
let branchAnswer: string | null = null
const invalidateGitStatusCache = vi.fn()

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
        webContents: { isDestroyed: () => false, send }
      }
    ]
  }
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({ codeIndex: { enabled: false, pausedPaths: [] } })
}))

// Real disk reads drive the summary; only the two answers that would shell out
// are stubbed, so the test does not depend on git being installed.
vi.mock('@main/git/gitStatusCache', () => ({
  readGitStatusCached: async () =>
    branchAnswer === null
      ? { kind: 'not_repo' }
      : { kind: 'ok', status: { branch: branchAnswer } },
  invalidateGitStatusCache
}))

vi.mock('@main/agent/codeindex', () => ({
  getCodeIndexRuntimeStatus: () => ({
    phase: 'idle',
    progress: null,
    message: null,
    error: null,
    indexProgress: null
  }),
  isCodeIndexPaused: () => false,
  onCodeIndexRuntimeStatus: () => () => {}
}))

const { armAgentContextWatch, stopAgentContextWatch } = await import(
  '@main/agent/context/agentContextWatcher'
)
const { buildWorkspaceAgentContext } = await import('@main/agent/context/agentContext')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait until a push matches `predicate`. Returns how long the push took, so a
 * test can assert on *when* it arrived, not only that it did.
 */
async function waitForPush(
  predicate: (ctx: WorkspaceAgentContextResult) => boolean,
  timeoutMs: number,
  label: string
): Promise<number> {
  const started = Date.now()
  for (;;) {
    const hit = sent.find(predicate)
    if (hit) return Date.now() - started
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `no push matching ${label} within ${timeoutMs}ms; pushes so far: ${JSON.stringify(
          sent.map((c) => ({ notes: c.memoryNotes, names: c.memoryNoteNames, rules: c.rules }))
        )}`
      )
    }
    await sleep(20)
  }
}

let workspace = ''

/** `memory_write` keeps every note as `notes/<name>.md`; the count ignores the rest. */
function writeNote(name: string): void {
  mkdirSync(join(workspace, '.vyotiq', 'memory', 'notes'), { recursive: true })
  writeFileSync(join(workspace, '.vyotiq', 'memory', 'notes', `${name}.md`), `- ${name}\n`, 'utf8')
}

async function arm(): Promise<void> {
  const initial = await buildWorkspaceAgentContext(workspace, { enabled: false, phase: 'idle' })
  armAgentContextWatch(workspace, initial)
}

beforeEach(() => {
  sent.length = 0
  send.mockClear()
  invalidateGitStatusCache.mockClear()
  branchAnswer = null
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-agentctx-watch-'))
})

afterEach(() => {
  stopAgentContextWatch(workspace)
  try {
    rmSync(workspace, { recursive: true, force: true })
  } catch {
    /* windows keeps a handle briefly; the temp dir is disposable anyway */
  }
})

describe('agent context watcher', () => {
  it('rebuilds after the memory directory is deleted, re-created and written to', async () => {
    await arm()
    writeNote('one')
    await waitForPush((c) => c.memoryNoteNames?.includes('one') === true, 8_000, 'note "one"')

    // The exact sequence from the bug report: a directory removal against an
    // armed recursive watch storms, and the re-created note must still land.
    rmSync(join(workspace, '.vyotiq', 'memory'), { recursive: true, force: true })
    writeNote('two')

    const elapsed = await waitForPush(
      (c) => c.memoryNoteNames?.includes('two') === true,
      8_000,
      'note "two"'
    )
    expect(sent.at(-1)?.memoryNotes).toBe(1)
    // Bounded window: a push cannot wait behind an unbounded storm.
    expect(elapsed).toBeLessThan(5_000)
  })

  it('fires a rebuild while fs events are still arriving, not only after they stop', async () => {
    await arm()
    writeNote('seed')
    await waitForPush((c) => c.memoryNoteNames?.includes('seed') === true, 8_000, 'note "seed"')
    sent.length = 0

    // A sustained storm: an event every 50ms for 2s, so a debounce that slides
    // on every event never fires. This is the property the report measured as
    // `events=25551 rebuilds=0`.
    let storming = true
    const storm = (async () => {
      for (let i = 0; i < 40; i++) {
        writeNote(`storm-${i}`)
        await sleep(50)
      }
      storming = false
    })()

    await waitForPush((c) => (c.memoryNoteNames?.length ?? 0) > 0, 8_000, 'a rebuild mid-storm')
    expect(storming, 'the rebuild waited for the storm to end').toBe(true)
    await storm
  })

  it('keeps a quiet workspace quiet — no push with nothing on disk changing', async () => {
    await arm()
    writeNote('quiet')
    await waitForPush((c) => c.memoryNoteNames?.includes('quiet') === true, 8_000, 'note "quiet"')

    // Long enough for several debounce windows and the max window to pass.
    await sleep(3_000)
    expect(sent).toHaveLength(1)
  })

  it('accepts a lowercase agents.md at the workspace root', async () => {
    // A case-insensitive filesystem resolves `<ws>/AGENTS.md` onto a file
    // stored as `agents.md`, so rules.ts counts the file and the card must
    // follow it. On a case-sensitive filesystem the file is not a rule at all,
    // and this expectation would be wrong rather than unmet.
    const probe = join(workspace, 'agents.md')
    writeFileSync(probe, '# rules\n', 'utf8')
    if (!existsSync(join(workspace, 'AGENTS.md'))) return
    rmSync(probe)

    await arm()
    writeFileSync(join(workspace, 'agents.md'), '# rules\n', 'utf8')

    await waitForPush((c) => c.rules.agentsMd === true, 8_000, 'rules.agentsMd')
  })

  it('accepts a lowercase claude.md at the workspace root', async () => {
    const probe = join(workspace, 'claude.md')
    writeFileSync(probe, '# rules\n', 'utf8')
    if (!existsSync(join(workspace, 'CLAUDE.md'))) return
    rmSync(probe)

    await arm()
    writeFileSync(join(workspace, 'claude.md'), '# rules\n', 'utf8')

    await waitForPush((c) => c.rules.claudeMd === true, 8_000, 'rules.claudeMd')
  })

  it('drops the branch cache when .git appears, so the next read is not a cached one', async () => {
    // Exercises the other name list, `gitNames` (`.git` under the root, `HEAD`
    // under it). Both are names git writes itself in exactly this case, so the
    // case-insensitive comparison is hardening here rather than a live fix —
    // what matters is that the event reaches the rebuild at all.
    await arm()
    expect(invalidateGitStatusCache).not.toHaveBeenCalled()

    mkdirSync(join(workspace, '.git'), { recursive: true })
    writeFileSync(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')

    const started = Date.now()
    while (invalidateGitStatusCache.mock.calls.length === 0) {
      if (Date.now() - started > 8_000) {
        throw new Error('the .git event never invalidated the branch cache')
      }
      await sleep(20)
    }
    expect(invalidateGitStatusCache).toHaveBeenCalledWith(workspace)
  })
})
