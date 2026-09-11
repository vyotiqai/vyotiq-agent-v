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
  runStorageCleanup,
  selectOrphanDirs,
  sweepRetentionAuto,
  withinProtectedWindow
} from '@main/storage/retention'
import { workspacesRoot, workspaceIdFromPath } from '@main/storage/paths'
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
  it('deletes sessions beyond keep-N only when also past the age window', async () => {
    ackedSettings({
      sessionRetentionEnabled: true,
      sessionKeepCount: 1,
      sessionMaxAgeDays: 30
    })
    makeStorageId('wid-a')
    const old = makeSession('wid-a', 'run-old', { ageDays: 40 })
    makeSession('wid-a', 'run-new', { ageDays: 5 }) // beyond keep but inside window
    await sweepRetentionAuto()
    expect(existsSync(old)).toBe(false)
    expect(existsSync(join(workspacesRoot(), 'wid-a', 'sessions', 'run-new'))).toBe(true)
  })

  it('session retention OFF (default) keeps every session', async () => {
    ackedSettings()
    makeStorageId('wid-a')
    const runDir = makeSession('wid-a', 'run-ancient', { ageDays: 400 })
    await sweepRetentionAuto()
    expect(existsSync(runDir)).toBe(true)
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

    const report = await collectStorageReport()

    const byId = new Map(report.categories.map((c) => [c.id, c]))
    // Checkpoints include blob + meta + index — at least the blob bytes.
    expect(byId.get('checkpoints')?.bytes).toBeGreaterThanOrEqual(100)
    expect(byId.get('transcripts')?.bytes).toBe(1500)
    expect(byId.get('logs')?.bytes).toBe(250)
    // Report-only categories are measured but excluded from the managed set.
    expect(byId.get('dictation-models')?.managed).toBe(false)
    expect(byId.get('logs')?.managed).toBe(true)

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
