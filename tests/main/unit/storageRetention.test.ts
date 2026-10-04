import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Storage retention policy tests (audit H4/H5, design §6.4 + §8.4).
 * electron's userData points at a fresh tmp dir; runRegistry / settings /
 * workspaces are mocked so the sweeps see only the fixtures on disk.
 */

const userDataRoot = mkdtempSync(join(tmpdir(), `vyotiq-retention-${process.pid}-`))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) =>
      name === 'userData' ? userDataRoot : join(tmpdir(), `vyotiq-${name}`),
    getAppPath: () => join(tmpdir(), 'vyotiq-app'),
    isPackaged: false
  }
}))

let activeRuns: Array<{ runId: string; workspacePath: string; invokeId: number }> = []

vi.mock('@main/agent/runRegistry', () => ({
  listActiveRuns: () => activeRuns
}))

let mockSettings: {
  storage: typeof DEFAULT_STORAGE_SETTINGS
  storageSurfaceAcked: boolean
}

vi.mock('@main/settings/settings', () => ({
  getSettings: () => mockSettings
}))

let mockWorkspacesState: {
  openPaths: string[]
  activePath: string | null
  recentPaths: string[]
  uiStateByPath: Record<string, never>
  settingsOverridesByPath: Record<string, never>
  workspaceIdsByPath?: Record<string, string>
}

vi.mock('@main/workspace/workspaces', () => ({
  getWorkspaces: () => mockWorkspacesState
}))

import {
  PROTECTED_WINDOW_MS,
  collectStorageReport,
  deleteWorkspaceStorageDir,
  measureWorkspaceStorageDir,
  previewStorageCleanup,
  resetPendingCleanupTokenForTests,
  resetRetentionAutoForTests,
  runStorageCleanup,
  selectOrphanDirs,
  sweepRetentionAuto,
  withinProtectedWindow
} from '@main/storage/retention'
import { workspacesRoot, workspaceIdFromPath, workspaceSessionsRoot } from '@main/storage/paths'
import { DEFAULT_STORAGE_SETTINGS } from '@shared/ipc'
import { logger } from '@shared/logger'

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** Backdate a file or dir's mtime. */
function age(path: string, ageDays: number): void {
  const t = new Date(Date.now() - ageDays * DAY_MS)
  utimesSync(path, t, t)
}

/** Write `bytes` of content and backdate its mtime. */
function writeWithAge(path: string, bytes: number, ageDays: number): void {
  writeFileSync(path, Buffer.alloc(Math.max(1, bytes), 'x'))
  age(path, ageDays)
}

/** Storage-id dir; `sessions` create run dirs under `{id}/sessions/`. */
function makeStorageId(id: string, sessions: string[] = []): string {
  const root = join(workspacesRoot(), id, 'sessions')
  mkdirSync(root, { recursive: true })
  for (const runId of sessions) {
    mkdirSync(join(root, runId), { recursive: true })
  }
  return root
}

/** A run dir with transcript, backdated (dir mtime included). */
function makeSession(
  id: string,
  runId: string,
  opts: { ageDays?: number; transcriptBytes?: number } = {}
): string {
  const runDir = join(workspacesRoot(), id, 'sessions', runId)
  mkdirSync(runDir, { recursive: true })
  writeWithAge(join(runDir, 'messages.jsonl'), opts.transcriptBytes ?? 50, opts.ageDays ?? 40)
  age(runDir, opts.ageDays ?? 40)
  return runDir
}

/**
 * Checkpoint dir with meta.json + index entry (append-only index shape).
 * Every file AND the parent dirs are re-backdated — creating files inside a
 * dir refreshes its mtime, which would otherwise pull the fixture into the
 * 24 h protected window.
 */
function makeCheckpoint(
  runDir: string,
  cpId: string,
  opts: { bytes?: number; ageDays?: number; resolved?: boolean; undone?: boolean } = {}
): void {
  const ageDays = opts.ageDays ?? 40
  const cpDir = join(runDir, 'checkpoints', cpId)
  mkdirSync(cpDir, { recursive: true })
  writeWithAge(join(cpDir, 'blob.json'), opts.bytes ?? 100, ageDays)
  const meta: Record<string, unknown> = {
    createdAt: new Date(Date.now() - ageDays * DAY_MS).toISOString()
  }
  if (opts.resolved) meta.resolved = true
  if (opts.undone) meta.undone = true
  const metaPath = join(cpDir, 'meta.json')
  writeFileSync(metaPath, JSON.stringify(meta))
  age(metaPath, ageDays)
  const indexPath = join(runDir, 'checkpoints', 'index.json')
  const existing: { checkpoints?: Array<Record<string, unknown>> } = existsSync(indexPath)
    ? (JSON.parse(readFileSync(indexPath, 'utf8')) as {
        checkpoints?: Array<Record<string, unknown>>
      })
    : {}
  existing.checkpoints = [...(existing.checkpoints ?? []), { id: cpId, ...meta }]
  writeFileSync(indexPath, JSON.stringify(existing))
  age(indexPath, ageDays)
  age(cpDir, ageDays)
  age(join(runDir, 'checkpoints'), ageDays)
  age(runDir, ageDays)
}

/**
 * Register a storage id as a known workspace so the orphan reaper and the
 * report treat it as tracked. Retention tests that are about per-workspace
 * policy use this so the 30-day orphan grace cannot remove their fixture.
 */
function trackWorkspace(id: string, wsPath = `C:\\proj\\${id}`): void {
  mockWorkspacesState.workspaceIdsByPath = { ...mockWorkspacesState.workspaceIdsByPath, [wsPath]: id }
}

/** A rebuildable code index dir under a workspace store, backdated. */
function makeCodeIndex(
  id: string,
  opts: { bytes?: number; ageDays?: number; name?: string } = {}
): string {
  const dir = join(workspacesRoot(), id, opts.name ?? 'codeindex')
  mkdirSync(dir, { recursive: true })
  writeWithAge(join(dir, 'index.sqlite'), opts.bytes ?? 1000, opts.ageDays ?? 30)
  age(dir, opts.ageDays ?? 30)
  return dir
}

/** Default-armed settings (ack + defaults) for most sweeps. */
function ackedSettings(overrides: Record<string, unknown> = {}): void {
  mockSettings = {
    storage: { ...DEFAULT_STORAGE_SETTINGS, ...overrides } as typeof mockSettings.storage,
    storageSurfaceAcked: true
  }
}

beforeEach(() => {
  resetPendingCleanupTokenForTests()
  activeRuns = []
  ackedSettings()
  mockWorkspacesState = {
    openPaths: [],
    activePath: null,
    recentPaths: [],
    uiStateByPath: {},
    settingsOverridesByPath: {},
    workspaceIdsByPath: {}
  }
  rmSync(userDataRoot, { recursive: true, force: true })
  mkdirSync(userDataRoot, { recursive: true })
})

describe('withinProtectedWindow', () => {
  it('protects anything written inside the last 24 h', () => {
    const now = Date.now()
    expect(withinProtectedWindow(now - 23 * HOUR_MS, now)).toBe(true)
    expect(withinProtectedWindow(now - PROTECTED_WINDOW_MS - 1, now)).toBe(false)
  })
})

describe('selectOrphanDirs (grace + tracked exclusion)', () => {
  const now = Date.now()
  const mk = (id: string, tracked: boolean, idleDays: number) => ({
    workspaceId: id,
    tracked,
    idleDays
  })

  it('selects only untracked dirs past the grace window', () => {
    const ws = [mk('tracked', true, 400), mk('young', false, 5), mk('old', false, 45)]
    const out = selectOrphanDirs(
      ws as never,
      { storage: DEFAULT_STORAGE_SETTINGS } as never,
      now
    )
    expect(out.map((w) => w.workspaceId)).toEqual(['old'])
  })

  it('returns nothing when the reaper is disabled', () => {
    const out = selectOrphanDirs([mk('old', false, 45)] as never, {
      storage: { ...DEFAULT_STORAGE_SETTINGS, orphanReaperEnabled: false }
    } as never, now)
    expect(out).toEqual([])
  })

  it('a tracked id is never reapable regardless of age', () => {
    const out = selectOrphanDirs(
      [mk('tracked-ancient', true, 400)] as never,
      { storage: DEFAULT_STORAGE_SETTINGS } as never,
      now
    )
    expect(out).toEqual([])
  })
})

describe('checkpoint GC (sweepRetentionAuto)', () => {
  it('prunes resolved/undone checkpoint blobs immediately (free pass)', async () => {
    makeStorageId('wid-a')
    // Session sits inside the 30-day backstop so only the free pass can act;
    // checkpoint blobs themselves are aged past the 24 h protected window.
    const runDir = makeSession('wid-a', 'run-1', { ageDays: 10 })
    makeCheckpoint(runDir, 'cp-resolved', { resolved: true, ageDays: 40, bytes: 500 })
    makeCheckpoint(runDir, 'cp-live', { ageDays: 40, bytes: 300 })
    age(runDir, 10)
    await sweepRetentionAuto()
    expect(existsSync(join(runDir, 'checkpoints', 'cp-resolved'))).toBe(false)
    expect(existsSync(join(runDir, 'checkpoints', 'cp-live'))).toBe(true)
  })

  it('keeps the newest N checkpoint-bearing sessions, prunes the rest', async () => {
    ackedSettings({ checkpointKeepSessions: 2 })
    makeStorageId('wid-a')
    // run-0 (10 d ago) has the newest dir mtime, … run-3 (13 d) the oldest.
    for (let i = 0; i < 4; i++) {
      const runDir = makeSession('wid-a', `run-${i}`, { ageDays: 10 + i })
      makeCheckpoint(runDir, 'cp', { ageDays: 10 + i })
    }
    await sweepRetentionAuto()
    // Newest 2 sessions (run-0, run-1) keep their checkpoints; older two lose
    // theirs, but transcripts survive — only checkpoint data is GC'd.
    for (const keep of ['run-0', 'run-1']) {
      expect(existsSync(join(workspacesRoot(), 'wid-a', 'sessions', keep, 'checkpoints'))).toBe(true)
    }
    for (const drop of ['run-2', 'run-3']) {
      expect(existsSync(join(workspacesRoot(), 'wid-a', 'sessions', drop, 'checkpoints'))).toBe(false)
      expect(existsSync(join(workspacesRoot(), 'wid-a', 'sessions', drop, 'messages.jsonl'))).toBe(true)
    }
  })

  it('30-day age backstop prunes old checkpoint dirs even under the count cap', async () => {
    ackedSettings({ checkpointKeepSessions: 20 })
    makeStorageId('wid-a')
    const runDir = makeSession('wid-a', 'run-old', { ageDays: 45 })
    makeCheckpoint(runDir, 'cp', { ageDays: 45 })
    await sweepRetentionAuto()
    expect(existsSync(join(runDir, 'checkpoints'))).toBe(false)
  })

  it('never deletes anything written inside the 24 h protected window', async () => {
    makeStorageId('wid-a')
    const runDir = makeSession('wid-a', 'run-fresh', { ageDays: 0 })
    makeCheckpoint(runDir, 'cp-resolved', { resolved: true, ageDays: 0 })
    makeCheckpoint(runDir, 'cp-capped', { ageDays: 0 })
    await sweepRetentionAuto()
    expect(existsSync(join(runDir, 'checkpoints', 'cp-resolved'))).toBe(true)
    expect(existsSync(join(runDir, 'checkpoints', 'cp-capped'))).toBe(true)
  })

  it('excludes session dirs of active runs (registry-listed)', async () => {
    ackedSettings({ checkpointKeepSessions: 5 })
    const wsPath = 'C:\\proj\\active'
    const id = workspaceIdFromPath(wsPath)
    makeStorageId(id)
    const runDir = makeSession(id, 'run-active', { ageDays: 60 })
    makeCheckpoint(runDir, 'cp', { ageDays: 60, resolved: true })
    activeRuns = [{ runId: 'run-active', workspacePath: wsPath, invokeId: 1 }]
    // Sanity: the registry-resolved dir is exactly the fixture dir.
    expect(join(workspacesRoot(), id, 'sessions', 'run-active')).toBe(runDir)
    await sweepRetentionAuto()
    expect(existsSync(join(runDir, 'checkpoints', 'cp'))).toBe(true)
  })

  it('before the §8.1 ack, only the free resolved/undone pass runs', async () => {
    mockSettings = {
      storage: { ...DEFAULT_STORAGE_SETTINGS, checkpointKeepSessions: 1 },
      storageSurfaceAcked: false
    }
    makeStorageId('wid-a')
    const runDir = makeSession('wid-a', 'run-1', { ageDays: 40 })
    makeCheckpoint(runDir, 'cp-resolved', { resolved: true, ageDays: 40 })
    makeCheckpoint(runDir, 'cp-capped', { ageDays: 40 })
    await sweepRetentionAuto()
    expect(existsSync(join(runDir, 'checkpoints', 'cp-resolved'))).toBe(false)
    expect(existsSync(join(runDir, 'checkpoints', 'cp-capped'))).toBe(true)
  })

  it('kill switch: checkpointGcEnabled=false keeps everything', async () => {
    ackedSettings({ checkpointGcEnabled: false })
    makeStorageId('wid-a')
    const runDir = makeSession('wid-a', 'run-1', { ageDays: 90 })
    makeCheckpoint(runDir, 'cp', { ageDays: 90 })
    await sweepRetentionAuto()
    expect(existsSync(join(runDir, 'checkpoints'))).toBe(true)
  })

  it('crash-mid-sweep: blob dir without meta.json is never free-passed', async () => {
    // Backstop pushed past the fixture age so only the free pass can run.
    ackedSettings({ checkpointKeepSessions: 50, checkpointMaxAgeDays: 365 })
    makeStorageId('wid-a')
    const runDir = makeSession('wid-a', 'run-1', { ageDays: 40 })
    mkdirSync(join(runDir, 'checkpoints', 'cp-orphan-blob'), { recursive: true })
    writeWithAge(join(runDir, 'checkpoints', 'cp-orphan-blob', 'blob'), 200, 40)
    age(join(runDir, 'checkpoints', 'cp-orphan-blob'), 40)
    age(join(runDir, 'checkpoints'), 40)
    age(runDir, 40)
    await sweepRetentionAuto()
    expect(existsSync(join(runDir, 'checkpoints', 'cp-orphan-blob'))).toBe(true)
  })
})

describe('session retention (sweepRetentionAuto)', () => {
  it('evicts a session past keep-N that is INSIDE the age window (keep-N stands alone)', async () => {
    // The defect this replaces: keep-N and the age window were AND-ed, so a
    // session had to be old enough to evict before keep-N could act — with a
    // 60-day window and an all-recent session tree, keep-N never fired.
    ackedSettings({
      sessionRetentionEnabled: true,
      sessionKeepCount: 1,
      sessionMaxAgeDays: 60
    })
    makeStorageId('wid-a')
    trackWorkspace('wid-a')
    makeSession('wid-a', 'run-newest', { ageDays: 3 }) // index 0 — inside keep
    const beyondKeep = makeSession('wid-a', 'run-beyond-keep', { ageDays: 5 })
    // Both bounds still apply where both are true.
    const beyondBoth = makeSession('wid-a', 'run-beyond-both', { ageDays: 90 })
    expect(beyondKeep).not.toBe(beyondBoth)

    const warnSpy = vi.spyOn(logger, 'warn')
    await sweepRetentionAuto()

    // Beyond keep-N but only 5 days old — well inside the 60-day window. The
    // age bound is a ceiling on aggressiveness, not the gate, so keep-N evicts.
    expect(existsSync(beyondKeep)).toBe(false)
    expect(existsSync(beyondBoth)).toBe(false)
    // The newest session is inside keep-N and inside the window — untouched.
    expect(existsSync(join(workspacesRoot(), 'wid-a', 'sessions', 'run-newest'))).toBe(true)
    // Every eviction logs runId + bytes.
    expect(warnSpy).toHaveBeenCalledWith('Evicted session dir (session retention)', {
      scope: 'storage',
      code: 'SESSION_DIR_EVICTED',
      correlationId: 'run-beyond-keep',
      reason: 'count',
      bytes: 50
    })
    warnSpy.mockRestore()
  })

  it('deletes sessions beyond keep-N when also past the age window', async () => {
    // The original direction, kept: past keep-N AND past the age window.
    ackedSettings({
      sessionRetentionEnabled: true,
      sessionKeepCount: 1,
      sessionMaxAgeDays: 30
    })
    makeStorageId('wid-a')
    trackWorkspace('wid-a')
    const old = makeSession('wid-a', 'run-old', { ageDays: 40 })
    makeSession('wid-a', 'run-new', { ageDays: 5 })
    const warnSpy = vi.spyOn(logger, 'warn')
    await sweepRetentionAuto()
    expect(existsSync(old)).toBe(false)
    // run-new is the newest dir, so the min-1 floor holds it regardless.
    expect(existsSync(join(workspacesRoot(), 'wid-a', 'sessions', 'run-new'))).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(
      'Evicted session dir (session retention)',
      expect.objectContaining({ correlationId: 'run-old', reason: 'count+age' })
    )
    warnSpy.mockRestore()
  })

  it('the age window still evicts a session that is INSIDE keep-N', async () => {
    // Age is a ceiling on aggressiveness, not a floor: it still fires on its
    // own, otherwise raising keep-N would pin old sessions forever.
    ackedSettings({
      sessionRetentionEnabled: true,
      sessionKeepCount: 30,
      sessionMaxAgeDays: 30
    })
    makeStorageId('wid-a')
    trackWorkspace('wid-a')
    makeSession('wid-a', 'run-ancient', { ageDays: 90 }) // newest, so inside keep
    await sweepRetentionAuto()
    // The hard min-1 floor: the newest session is never deleted, even aged out.
    expect(existsSync(join(workspacesRoot(), 'wid-a', 'sessions', 'run-ancient'))).toBe(true)

    makeSession('wid-a', 'run-ancient-2', { ageDays: 91 })
    await sweepRetentionAuto()
    expect(existsSync(join(workspacesRoot(), 'wid-a', 'sessions', 'run-ancient-2'))).toBe(false)
    expect(existsSync(join(workspacesRoot(), 'wid-a', 'sessions', 'run-ancient'))).toBe(true)
  })

  it('never deletes the session dir of an active run, even beyond keep-N', async () => {
    ackedSettings({
      sessionRetentionEnabled: true,
      sessionKeepCount: 1,
      sessionMaxAgeDays: 60
    })
    const wsPath = 'C:\\proj\\active-retention'
    const id = workspaceIdFromPath(wsPath)
    makeStorageId(id)
    trackWorkspace(id, wsPath)
    makeSession(id, 'run-newest', { ageDays: 3 })
    const activeDir = makeSession(id, 'run-active', { ageDays: 5 })
    makeSession(id, 'run-dead', { ageDays: 7 })
    activeRuns = [{ runId: 'run-active', workspacePath: wsPath, invokeId: 1 }]
    expect(join(workspacesRoot(), id, 'sessions', 'run-active')).toBe(activeDir)

    await sweepRetentionAuto()

    // Beyond keep-N and inside the age window, but registry-listed: protected.
    expect(existsSync(activeDir)).toBe(true)
    expect(existsSync(join(workspacesRoot(), id, 'sessions', 'run-dead'))).toBe(false)
  })

  it('session retention OFF (default) keeps every session', async () => {
    ackedSettings()
    makeStorageId('wid-a')
    const runDir = makeSession('wid-a', 'run-ancient', { ageDays: 400 })
    await sweepRetentionAuto()
    expect(existsSync(runDir)).toBe(true)
  })
})

describe('derived index-only free pass (orphan reaper)', () => {
  /** An untracked storage dir with no `sessions/` and no `meta.json`. */
  function bareDir(id: string, build: (root: string) => void): void {
    const root = join(workspacesRoot(), id)
    mkdirSync(root, { recursive: true })
    build(root)
    age(root, 2)
  }

  function indexIn(root: string): void {
    mkdirSync(join(root, 'codeindex'), { recursive: true })
    writeWithAge(join(root, 'codeindex', 'db.bin'), 100, 2)
  }

  it('is not stranded by a derived runFeedback.json, but real state still blocks it', async () => {
    ackedSettings()
    bareDir('wid-index-only', indexIn)
    bareDir('wid-index-and-feedback', (root) => {
      indexIn(root)
      writeWithAge(join(root, 'runFeedback.json'), 50, 2)
    })
    bareDir('wid-feedback-only', (root) => {
      writeWithAge(join(root, 'runFeedback.json'), 50, 2)
    })
    bareDir('wid-real-state', (root) => {
      indexIn(root)
      writeWithAge(join(root, 'notes.bin'), 50, 2)
    })

    const by = new Map((await collectStorageReport()).workspaces.map((w) => [w.workspaceId, w]))

    // Baseline: an index-only dir is free-passed regardless of the grace window.
    expect(by.get('wid-index-only')?.derivedOnly).toBe(true)
    // The change: a rebuildable ratings file must not cost the free pass.
    expect(by.get('wid-index-and-feedback')).toMatchObject({
      derivedOnly: true,
      reapable: true
    })
    // ...but it is not itself an index, so it cannot earn the pass alone.
    expect(by.get('wid-feedback-only')?.derivedOnly).toBe(false)
    // ...and anything unrecognised still blocks it. These dirs are 2 days old,
    // well inside the 30-day grace window, so only the free pass could reap them.
    expect(by.get('wid-real-state')).toMatchObject({
      derivedOnly: false,
      reapable: false
    })
  })
})

describe('collectStorageReport (rollup math + orphan flags)', () => {
  it('sums categories, flags untracked dirs reapable, computes cap state', async () => {
    ackedSettings({ sizeCapGb: 1 })
    makeStorageId('wid-a')
    const runDir = makeSession('wid-a', 'run-1', { ageDays: 0, transcriptBytes: 1000 })
    writeWithAge(join(runDir, 'events.jsonl'), 500, 0)
    makeCheckpoint(runDir, 'cp', { bytes: 100, ageDays: 0 })
    makeStorageId('wid-orphan')
    writeWithAge(join(workspacesRoot(), 'wid-orphan', 'stale.bin'), 1000, 45)
    age(join(workspacesRoot(), 'wid-orphan'), 45)
    mkdirSync(join(userDataRoot, 'logs'), { recursive: true })
    writeWithAge(join(userDataRoot, 'logs', 'main.log'), 250, 0)
    mkdirSync(join(userDataRoot, 'dictation', 'models'), { recursive: true })
    writeWithAge(join(userDataRoot, 'dictation', 'models', 'model.bin'), 500, 0)
    mkdirSync(join(userDataRoot, 'embed', 'models'), { recursive: true })
    writeWithAge(join(userDataRoot, 'embed', 'models', 'model_quantized.onnx'), 700, 0)

    const report = await collectStorageReport()

    const byId = new Map(report.categories.map((c) => [c.id, c]))
    // Checkpoints include blob + meta + index — at least the blob bytes.
    expect(byId.get('checkpoints')?.bytes).toBeGreaterThanOrEqual(100)
    expect(byId.get('transcripts')?.bytes).toBe(1500)
    expect(byId.get('logs')?.bytes).toBe(250)
    // Report-only categories are measured but excluded from the managed set.
    expect(byId.get('dictation-models')?.managed).toBe(false)
    expect(byId.get('logs')?.managed).toBe(true)
    // The code-search embedding model is reported too — Settings → Storage
    // names it — but, like dictation models, is never evicted.
    expect(byId.get('embed-models')).toMatchObject({ bytes: 700, managed: false })

    const orphan = report.workspaces.find((w) => w.workspaceId === 'wid-orphan')
    expect(orphan).toBeDefined()
    expect(orphan?.tracked).toBe(false)
    expect(orphan?.reapable).toBe(true)
    expect(orphan?.sessionCount).toBe(0)
    expect(orphan?.bytes).toBeGreaterThanOrEqual(1000)

    expect(report.totalBytes).toBe(report.categories.reduce((s, c) => s + c.bytes, 0))
    expect(report.managedBytes).toBe(
      report.categories.filter((c) => c.managed).reduce((s, c) => s + c.bytes, 0)
    )
    expect(report.sizeCapBytes).toBe(1024 * 1024 * 1024)
    expect(report.overCap).toBe(report.managedBytes > report.sizeCapBytes)
    expect(report.overCap).toBe(false)
  })

  it('a tracked storage id is reported tracked and never reapable', async () => {
    const wsPath = 'C:\\proj\\tracked'
    const id = workspaceIdFromPath(wsPath)
    makeStorageId(id)
    age(join(workspacesRoot(), id), 400)
    mockWorkspacesState.workspaceIdsByPath = { [wsPath]: id }
    const report = await collectStorageReport()
    const ws = report.workspaces.find((w) => w.workspaceId === id)
    expect(ws?.tracked).toBe(true)
    expect(ws?.reapable).toBe(false)
  })

  it('flags derived index-only dirs reapable below the grace window', async () => {
    ackedSettings({ orphanGraceDays: 30 })
    // Instance-worktree index storage: no sessions/, no meta.json, only the
    // derived index caches. Last write today (0 idle days).
    const derived = join(workspacesRoot(), 'wid-derived', 'codeindex')
    mkdirSync(derived, { recursive: true })
    writeWithAge(join(derived, 'index.sqlite'), 1024, 0)

    const report = await collectStorageReport()
    const ws = report.workspaces.find((w) => w.workspaceId === 'wid-derived')
    expect(ws?.derivedOnly).toBe(true)
    expect(ws?.reapable).toBe(true)

    const preview = await previewStorageCleanup()
    expect(preview.orphanDirs.map((w) => w.workspaceId)).toContain('wid-derived')
    const result = await runStorageCleanup(preview.confirm.token)
    expect(result.totalReclaimedBytes).toBeGreaterThanOrEqual(1024)
    expect(existsSync(join(workspacesRoot(), 'wid-derived'))).toBe(false)
  })

  it('keeps a fresh untracked dir with sessions out of the reapable set', async () => {
    ackedSettings({ orphanGraceDays: 30 })
    makeStorageId('wid-user', ['run-1'])
    writeWithAge(join(workspacesRoot(), 'wid-user', 'sessions', 'run-1', 'messages.jsonl'), 200, 0)
    const report = await collectStorageReport()
    const ws = report.workspaces.find((w) => w.workspaceId === 'wid-user')
    expect(ws?.derivedOnly).toBe(false)
    expect(ws?.reapable).toBe(false)
  })
})

describe('sweepRetentionAuto orphan reap (derived-only strays)', () => {
  beforeEach(() => {
    resetRetentionAutoForTests()
  })

  it('auto-reaps a derived-only orphan dir without ack or confirm', async () => {
    ackedSettings()
    const derived = join(workspacesRoot(), 'wid-auto', 'codeindex')
    mkdirSync(derived, { recursive: true })
    writeWithAge(join(derived, 'index.sqlite'), 1024, 0)

    await sweepRetentionAuto()

    expect(existsSync(join(workspacesRoot(), 'wid-auto'))).toBe(false)
  })

  it('auto-reaps a user-data orphan once it is past orphanGraceDays', async () => {
    // Previously the automatic reap took derived-only dirs only, so a store
    // holding sessions/ + meta.json under a path nothing registered was
    // unreachable without Settings → Storage. Now it is reaped after the same
    // grace the report already flags it with.
    ackedSettings({ orphanGraceDays: 30 })
    makeStorageId('wid-old', ['run-old'])
    writeFileSync(
      join(workspacesRoot(), 'wid-old', 'meta.json'),
      JSON.stringify({ canonicalPath: 'C:\\Temp\\scratchpad' })
    )
    age(join(workspacesRoot(), 'wid-old', 'meta.json'), 45)
    writeWithAge(join(workspacesRoot(), 'wid-old', 'sessions', 'run-old', 'messages.jsonl'), 200, 45)
    age(join(workspacesRoot(), 'wid-old', 'sessions', 'run-old'), 45)
    age(join(workspacesRoot(), 'wid-old', 'sessions'), 45)
    age(join(workspacesRoot(), 'wid-old'), 45)

    await sweepRetentionAuto()

    expect(existsSync(join(workspacesRoot(), 'wid-old'))).toBe(false)
  })

  it('leaves a user-data orphan untouched until the grace window has passed', async () => {
    ackedSettings({ orphanGraceDays: 30 })
    makeStorageId('wid-fresh', ['run-1'])
    writeWithAge(join(workspacesRoot(), 'wid-fresh', 'sessions', 'run-1', 'messages.jsonl'), 200, 5)
    age(join(workspacesRoot(), 'wid-fresh', 'sessions', 'run-1'), 5)
    age(join(workspacesRoot(), 'wid-fresh', 'sessions'), 5)
    age(join(workspacesRoot(), 'wid-fresh'), 5)

    await sweepRetentionAuto()

    expect(existsSync(join(workspacesRoot(), 'wid-fresh'))).toBe(true)
    expect(existsSync(join(workspacesRoot(), 'wid-fresh', 'sessions', 'run-1'))).toBe(true)
  })

  it('never auto-reaps an orphan whose store still hosts an active run', async () => {
    // Untracked is not the same as unreferenced-in-use: reaping this would
    // delete a live run's session dir, so it stays even past the grace window.
    const wsPath = 'C:\\Temp\\scratchpad\\live'
    const id = workspaceIdFromPath(wsPath)
    ackedSettings({ orphanGraceDays: 30 })
    makeStorageId(id, ['run-live'])
    writeWithAge(join(workspacesRoot(), id, 'sessions', 'run-live', 'messages.jsonl'), 200, 60)
    age(join(workspacesRoot(), id, 'sessions', 'run-live'), 60)
    age(join(workspacesRoot(), id, 'sessions'), 60)
    age(join(workspacesRoot(), id), 60)
    activeRuns = [{ runId: 'run-live', workspacePath: wsPath, invokeId: 1 }]
    expect(join(workspacesRoot(), id, 'sessions', 'run-live')).toBe(
      join(workspaceSessionsRoot(wsPath), 'run-live')
    )

    await sweepRetentionAuto()

    expect(existsSync(join(workspacesRoot(), id))).toBe(true)
    expect(existsSync(join(workspacesRoot(), id, 'sessions', 'run-live'))).toBe(true)
  })

  it('skips orphan reaping when the reaper setting is disabled', async () => {
    ackedSettings({ orphanReaperEnabled: false })
    const derived = join(workspacesRoot(), 'wid-off', 'codeindex')
    mkdirSync(derived, { recursive: true })
    writeWithAge(join(derived, 'index.sqlite'), 1024, 0)

    await sweepRetentionAuto()

    expect(existsSync(join(workspacesRoot(), 'wid-off'))).toBe(true)
  })

  it('never auto-reaps a tracked workspace dir', async () => {
    ackedSettings()
    const wsPath = 'C:\\proj\\tracked'
    const id = workspaceIdFromPath(wsPath)
    const derived = join(workspacesRoot(), id, 'codeindex')
    mkdirSync(derived, { recursive: true })
    writeWithAge(join(derived, 'index.sqlite'), 1024, 0)
    mockWorkspacesState.workspaceIdsByPath = { [wsPath]: id }

    await sweepRetentionAuto()

    expect(existsSync(join(workspacesRoot(), id))).toBe(true)
  })
})

describe('confirm-gated cleanup flow', () => {
  it('preview computes reclaim but deletes nothing; run requires + consumes the token', async () => {
    makeStorageId('wid-a')
    // Session inside the 30d backstop so only the free pass + orphan reap
    // contribute — preview and run then measure the exact same set.
    const runDir = makeSession('wid-a', 'run-1', { ageDays: 20 })
    makeCheckpoint(runDir, 'cp-resolved', { resolved: true, bytes: 400, ageDays: 20 })
    makeStorageId('wid-orphan')
    writeWithAge(join(workspacesRoot(), 'wid-orphan', 'stale.bin'), 1000, 45)
    age(join(workspacesRoot(), 'wid-orphan'), 45)

    const preview = await previewStorageCleanup()
    expect(preview.totalReclaimBytes).toBeGreaterThan(0)
    expect(existsSync(join(runDir, 'checkpoints', 'cp-resolved'))).toBe(true)
    expect(preview.confirm.token.length).toBeGreaterThan(0)
    expect(preview.orphanDirs.map((w) => w.workspaceId)).toContain('wid-orphan')

    // Wrong token → rejected, nothing deleted.
    await expect(runStorageCleanup('not-the-token')).rejects.toThrow(/expired/)
    expect(existsSync(join(runDir, 'checkpoints', 'cp-resolved'))).toBe(true)

    const result = await runStorageCleanup(preview.confirm.token)
    expect(result.totalReclaimedBytes).toBe(preview.totalReclaimBytes)
    expect(result.removedDirs).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(runDir, 'checkpoints', 'cp-resolved'))).toBe(false)
    expect(existsSync(join(workspacesRoot(), 'wid-orphan'))).toBe(false)

    // Token is single-use.
    resetPendingCleanupTokenForTests()
    await expect(runStorageCleanup(preview.confirm.token)).rejects.toThrow(/expired/)
  })

  it('previews the old sessions a run deletes, with automatic retention off', async () => {
    // The default: the automatic sweep is off, but Free up space still
    // applies the session limits — so its confirmation has to list them.
    ackedSettings({ sessionRetentionEnabled: false, sessionKeepCount: 1, sessionMaxAgeDays: 30 })
    makeStorageId('wid-a')
    mockWorkspacesState.workspaceIdsByPath = { 'C:\\proj\\a': 'wid-a' }
    const old = makeSession('wid-a', 'run-old', { ageDays: 90, transcriptBytes: 300 })
    const kept = makeSession('wid-a', 'run-new', { ageDays: 5 })

    const preview = await previewStorageCleanup()
    const previewed = preview.categories.find((c) => c.id === 'sessions')
    expect(previewed).toMatchObject({ items: 1 })
    expect(previewed!.reclaimBytes).toBeGreaterThanOrEqual(300)
    expect(existsSync(old)).toBe(true)

    const result = await runStorageCleanup(preview.confirm.token)
    expect(result.categories.find((c) => c.id === 'sessions')).toEqual(previewed)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(kept)).toBe(true)
  })

  it('never reaps an orphan that became tracked between preview and run', async () => {
    makeStorageId('wid-late')
    writeWithAge(join(workspacesRoot(), 'wid-late', 'stale.bin'), 1000, 45)
    age(join(workspacesRoot(), 'wid-late'), 45)
    const preview = await previewStorageCleanup()
    expect(preview.orphanDirs.map((w) => w.workspaceId)).toContain('wid-late')
    // Workspace re-added (tracked) between preview and confirm.
    mockWorkspacesState.workspaceIdsByPath = { 'C:\\proj\\late': 'wid-late' }
    await runStorageCleanup(preview.confirm.token)
    expect(existsSync(join(workspacesRoot(), 'wid-late'))).toBe(true)
  })
})

describe('size-cap LRU', () => {
  it('under-cap runStorageCleanup reports a size-cap category with zero reclaim', async () => {
    // Byte-scale fixtures can never exceed a 1 GB cap — the size-cap pass
    // must run as a no-op (0 reclaimed) rather than deleting anything.
    ackedSettings({ sizeCapGb: 1 })
    makeStorageId('wid-a')
    const runDir = makeSession('wid-a', 'run-1', { ageDays: 20 })
    makeCheckpoint(runDir, 'cp-live', { bytes: 100, ageDays: 20 })
    const preview = await previewStorageCleanup()
    const result = await runStorageCleanup(preview.confirm.token)
    const sizeCapCat = result.categories.find((c) => c.id === 'size-cap')
    expect(sizeCapCat?.reclaimBytes ?? 0).toBe(0)
    expect(sizeCapCat?.items ?? 0).toBe(0)
    // The live checkpoint (20d, inside backstop, under keep-20) survives.
    expect(existsSync(join(runDir, 'checkpoints', 'cp-live'))).toBe(true)
  })

  it('skips checkpoint eviction when reclaimable checkpoints cannot satisfy the excess', async () => {
    // ~1 KB cap, ~50 KB of transcripts, only ~20 KB of checkpoints: the
    // overage is dominated by a surface the cap cannot evict, so evicting
    // undo history would destroy data without ever reaching the cap.
    ackedSettings({ sizeCapGb: 0.000001 })
    makeStorageId('wid-a')
    const runDir = makeSession('wid-a', 'run-1', { ageDays: 20, transcriptBytes: 50_000 })
    makeCheckpoint(runDir, 'cp-old', { bytes: 10_000, ageDays: 5 })
    makeCheckpoint(runDir, 'cp-new', { bytes: 10_000, ageDays: 3 })
    // Keep the session itself inside the 30-day backstop so only the
    // size-cap pass can act on the checkpoints.
    age(runDir, 20)
    const infoSpy = vi.spyOn(logger, 'info')
    const preview = await previewStorageCleanup()
    await runStorageCleanup(preview.confirm.token)
    expect(infoSpy).toHaveBeenCalledWith(
      'Size-cap eviction skipped: reclaimable checkpoints cannot satisfy excess',
      expect.objectContaining({ scope: 'storage', code: 'SIZE_CAP_EVICTED' })
    )
    expect(existsSync(join(runDir, 'checkpoints', 'cp-old'))).toBe(true)
    expect(existsSync(join(runDir, 'checkpoints', 'cp-new'))).toBe(true)
  })

  it('evicts oldest checkpoints when they can satisfy the excess', async () => {
    // ~11 KB cap, ~20 KB of checkpoints: the oldest checkpoint alone can
    // bring the managed set under the cap, so the LRU backstop fires.
    ackedSettings({ sizeCapGb: 0.00001 })
    makeStorageId('wid-a')
    const runDir = makeSession('wid-a', 'run-1', { ageDays: 20, transcriptBytes: 10 })
    makeCheckpoint(runDir, 'cp-old', { bytes: 10_000, ageDays: 5 })
    makeCheckpoint(runDir, 'cp-new', { bytes: 10_000, ageDays: 3 })
    age(runDir, 20)
    const preview = await previewStorageCleanup()
    const result = await runStorageCleanup(preview.confirm.token)
    const sizeCapCat = result.categories.find((c) => c.id === 'size-cap')
    expect(sizeCapCat?.items).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(runDir, 'checkpoints', 'cp-old'))).toBe(false)
    expect(existsSync(join(runDir, 'checkpoints', 'cp-new'))).toBe(true)
  })

  it('leaves a rebuildable code index alone when checkpoints can satisfy the excess', async () => {
    // ~15.9 KB excess against ~20.5 KB of checkpoints: stage 1 can cover it, so
    // stage 2 (code indexes) must never run — even though a 500 KB index sits
    // right there, larger than the whole overage.
    ackedSettings({ sizeCapGb: 0.00047 })
    makeStorageId('wid-a')
    trackWorkspace('wid-a')
    const runDir = makeSession('wid-a', 'run-1', { ageDays: 20, transcriptBytes: 10 })
    makeCheckpoint(runDir, 'cp-old', { bytes: 10_000, ageDays: 5 })
    makeCheckpoint(runDir, 'cp-new', { bytes: 10_000, ageDays: 3 })
    makeCodeIndex('wid-a', { bytes: 500_000, ageDays: 10 })
    age(runDir, 20)
    const warnSpy = vi.spyOn(logger, 'warn')
    const preview = await previewStorageCleanup()
    const result = await runStorageCleanup(preview.confirm.token)

    expect(result.categories.find((c) => c.id === 'size-cap')?.items).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(runDir, 'checkpoints', 'cp-old'))).toBe(false)
    expect(warnSpy).not.toHaveBeenCalledWith(
      'Size-cap LRU eviction of rebuildable code index dir',
      expect.anything()
    )
    expect(existsSync(join(workspacesRoot(), 'wid-a', 'codeindex'))).toBe(true)
    expect(existsSync(join(workspacesRoot(), 'wid-a', 'codeindex', 'index.sqlite'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('evicts rebuildable code indexes oldest-first when checkpoints cannot satisfy the excess', async () => {
    // No checkpoints at all and ~92.6 KB of excess against two 100 KB indexes:
    // stage 2 fires and takes only the oldest workspace's index.
    ackedSettings({ sizeCapGb: 0.0001 })
    makeStorageId('wid-old')
    trackWorkspace('wid-old')
    makeSession('wid-old', 'run-1', { ageDays: 20, transcriptBytes: 10 })
    const oldIndex = makeCodeIndex('wid-old', { bytes: 100_000, ageDays: 10 })
    makeStorageId('wid-new')
    trackWorkspace('wid-new')
    makeSession('wid-new', 'run-1', { ageDays: 20, transcriptBytes: 10 })
    const newIndex = makeCodeIndex('wid-new', { bytes: 100_000, ageDays: 3 })

    const warnSpy = vi.spyOn(logger, 'warn')
    const preview = await previewStorageCleanup()
    const result = await runStorageCleanup(preview.confirm.token)

    const sizeCapCat = result.categories.find((c) => c.id === 'size-cap')
    expect(sizeCapCat?.items).toBe(1)
    expect(sizeCapCat?.reclaimBytes).toBe(100_000)
    expect(existsSync(oldIndex)).toBe(false)
    // Oldest first: the newer index survives this pass.
    expect(existsSync(newIndex)).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith('Size-cap LRU eviction of rebuildable code index dir', {
      scope: 'storage',
      code: 'CODE_INDEX_EVICTED',
      correlationId: 'wid-old',
      index: 'codeindex',
      bytes: 100_000
    })
    warnSpy.mockRestore()
  })

  it('never evicts a code index for a workspace with an active run', async () => {
    const wsPath = 'C:\\proj\\indexing'
    const id = workspaceIdFromPath(wsPath)
    ackedSettings({ sizeCapGb: 0.000001 })
    makeStorageId(id, ['run-live'])
    trackWorkspace(id, wsPath)
    const runDir = makeSession(id, 'run-live', { ageDays: 40, transcriptBytes: 100 })
    const indexDir = makeCodeIndex(id, { bytes: 400_000, ageDays: 40 })
    activeRuns = [{ runId: 'run-live', workspacePath: wsPath, invokeId: 1 }]
    const infoSpy = vi.spyOn(logger, 'info')

    const preview = await previewStorageCleanup()
    const result = await runStorageCleanup(preview.confirm.token)

    expect(result.categories.find((c) => c.id === 'size-cap')?.items ?? 0).toBe(0)
    expect(existsSync(indexDir)).toBe(true)
    expect(existsSync(runDir)).toBe(true)
    expect(infoSpy).toHaveBeenCalledWith(
      'Size-cap eviction skipped: no reclaimable managed category can satisfy excess',
      expect.objectContaining({ scope: 'storage', code: 'SIZE_CAP_EVICTED' })
    )
    infoSpy.mockRestore()
  })

  it('skips size-cap eviction when no managed category is reclaimable at all', async () => {
    // A ~1 KB cap against a 5 KB transcript: there are no checkpoints to drop
    // and no code index to drop, so both stages skip and nothing is deleted.
    ackedSettings({ sizeCapGb: 0.000001 })
    makeStorageId('wid-a')
    trackWorkspace('wid-a')
    const runDir = makeSession('wid-a', 'run-1', { ageDays: 40, transcriptBytes: 5000 })
    const infoSpy = vi.spyOn(logger, 'info')

    const preview = await previewStorageCleanup()
    const result = await runStorageCleanup(preview.confirm.token)

    const sizeCapCat = result.categories.find((c) => c.id === 'size-cap')
    expect(sizeCapCat?.reclaimBytes ?? 0).toBe(0)
    expect(sizeCapCat?.items ?? 0).toBe(0)
    expect(infoSpy).toHaveBeenCalledWith(
      'Size-cap eviction skipped: reclaimable checkpoints cannot satisfy excess',
      expect.objectContaining({ scope: 'storage', code: 'SIZE_CAP_EVICTED' })
    )
    expect(infoSpy).toHaveBeenCalledWith(
      'Size-cap eviction skipped: no reclaimable managed category can satisfy excess',
      expect.objectContaining({ scope: 'storage', code: 'SIZE_CAP_EVICTED' })
    )
    expect(existsSync(runDir)).toBe(true)
    infoSpy.mockRestore()
  })
})

describe('prune-on-removal', () => {
  it('measures and deletes a workspace storage dir end to end', async () => {
    const id = workspaceIdFromPath('C:\\proj\\x')
    makeStorageId(id, ['run-1'])
    const runDir = join(workspacesRoot(), id, 'sessions', 'run-1')
    writeWithAge(join(runDir, 'messages.jsonl'), 700, 0)
    const bytes = await measureWorkspaceStorageDir('C:\\proj\\x')
    expect(bytes).toBeGreaterThanOrEqual(700)
    const res = await deleteWorkspaceStorageDir('C:\\proj\\x')
    expect(res.ok).toBe(true)
    expect(res.bytes).toBeGreaterThanOrEqual(700)
    expect(existsSync(join(workspacesRoot(), id))).toBe(false)
  })

  it('a missing dir is a measured-0 no-op that never throws (skip when gone)', async () => {
    const bytes = await measureWorkspaceStorageDir('C:\\no\\such\\dir')
    expect(bytes).toBe(0)
    const res = await deleteWorkspaceStorageDir('C:\\no\\such\\dir')
    // rm(force) treats a missing dir as success — "skip silently when the dir
    // is gone already" (register.ts contract) — and never throws.
    expect(res.ok).toBe(true)
    expect(res.bytes).toBe(0)
  })
})
