import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-userdata-checks-${process.pid}-${Date.now()}`)

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

// Which runs are in review is reviewSummary's business; here every finished run is.
vi.mock('@main/agent/reviewSummary', () => ({
  pendingReviewSummary: vi.fn(async () => ({ files: 2, add: 3, del: 1 }))
}))

import { listRuns } from '@main/agent/state'
import { pendingReviewSummary } from '@main/agent/reviewSummary'
import { resolveRunDir } from '@main/storage/paths'
import { DONE_WHEN_CHECKS_FILE, type DoneWhenCheck } from '@shared/doneWhenChecks'

function writeRun(
  workspace: string,
  runId: string,
  checks?: Array<DoneWhenCheck['verdict']>,
  status: Record<string, unknown> = { status: 'done' }
): void {
  const dir = resolveRunDir(workspace, runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), goal: runId, workspacePath: workspace, ...status }),
    'utf8'
  )
  if (!checks) return
  const now = new Date().toISOString()
  writeFileSync(
    join(dir, DONE_WHEN_CHECKS_FILE),
    JSON.stringify({
      checks: checks.map((verdict, i) => ({ id: `c${i + 1}`, text: `Check ${i + 1}`, source: 'brief', verdict, createdAt: now }))
    }),
    'utf8'
  )
}

describe('listRuns: a run in review carries its checks', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-ws-checks-${process.pid}-${Date.now()}-${Math.random()}`)
    mkdirSync(workspace, { recursive: true })
  })

  afterEach(() => {
    vi.mocked(pendingReviewSummary).mockClear()
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('counts met of total, leaving open and unmet checks out of met', async () => {
    writeRun(workspace, 'mixed', ['met', 'not_met', null])
    writeRun(workspace, 'none')
    writeRun(workspace, 'empty', [])
    const { runs } = await listRuns(workspace)
    const byId = new Map(runs.map((r) => [r.runId, r]))
    expect(byId.get('mixed')?.checks).toEqual({ met: 1, total: 3 })
    // No checks file, or one with nothing in it, says nothing.
    expect(byId.get('none')?.checks).toBeUndefined()
    expect(byId.get('empty')?.checks).toBeUndefined()
  })

  it('reads no checks for a run that is not in review', async () => {
    vi.mocked(pendingReviewSummary).mockResolvedValue(null)
    writeRun(workspace, 'settled', ['met'])
    const { runs } = await listRuns(workspace)
    expect(runs[0]?.review).toBeUndefined()
    expect(runs[0]?.checks).toBeUndefined()
  })

  it('reads the checks of a run still working, in review or not', async () => {
    vi.mocked(pendingReviewSummary).mockResolvedValue(undefined)
    writeRun(workspace, 'working', ['met', null], { status: 'running' })
    const { runs } = await listRuns(workspace)
    expect(runs[0]?.review).toBeUndefined()
    expect(runs[0]?.checks).toEqual({ met: 1, total: 2 })
  })
})

describe('listRuns: a failed run says whether Retry can get past it', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-ws-retry-${process.pid}-${Date.now()}-${Math.random()}`)
    mkdirSync(workspace, { recursive: true })
    vi.mocked(pendingReviewSummary).mockResolvedValue(undefined)
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('marks a failure with a retryable code, and only while its message still stands', async () => {
    const lost = 'The connection dropped.'
    writeRun(workspace, 'network', undefined, { status: 'error', error: lost, lastError: { code: 'PROVIDER_NETWORK', message: lost } })
    writeRun(workspace, 'loop', undefined, { status: 'error', error: 'Crashed', lastError: { code: 'AGENT_LOOP', message: 'Crashed' } })
    // A later failure written without a code does not inherit the earlier one.
    writeRun(workspace, 'stale', undefined, { status: 'error', error: 'Context full', lastError: { code: 'PROVIDER_NETWORK', message: lost } })
    writeRun(workspace, 'legacy', undefined, { status: 'error', error: lost })
    const { runs } = await listRuns(workspace)
    const byId = new Map(runs.map((r) => [r.runId, r]))
    expect(byId.get('network')?.retryable).toBe(true)
    expect(byId.get('loop')?.retryable).toBeUndefined()
    expect(byId.get('stale')?.retryable).toBeUndefined()
    expect(byId.get('legacy')?.retryable).toBeUndefined()
  })
})
