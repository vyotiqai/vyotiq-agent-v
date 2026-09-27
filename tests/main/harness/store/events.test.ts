import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AgentEvent } from '@shared/ipc'
import {
  appendEvent,
  readEventRows,
  readHydrationEvents,
  rewriteEvents,
  sumStepUsage
} from '@main/harness/store/events'
import { resetJsonlForTests } from '@main/harness/store/jsonl'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vy-events-'))
  resetJsonlForTests()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const row = (at: string, event: Record<string, unknown>): string => `${JSON.stringify({ at, event })}\n`

describe('events.jsonl', () => {
  it('stamps each row when it is queued and keeps queue order', async () => {
    const before = Date.now()
    void appendEvent(dir, { type: 'status', runId: 'r1', status: 'running' })
    await appendEvent(dir, { type: 'status', runId: 'r1', status: 'done' })
    const rows = await readEventRows(dir)
    expect(rows.map((r) => (r.event as { status: string }).status)).toEqual(['running', 'done'])
    for (const r of rows) {
      expect(Date.parse(r.at)).toBeGreaterThanOrEqual(before - 1)
      expect(Date.parse(r.at)).toBeLessThanOrEqual(Date.now())
    }
  })

  it('stitches legacy archives into full reads, not into tail reads', async () => {
    writeFileSync(join(dir, 'events.archive.2026-01-01T00-00-00-000Z.jsonl'), row('t1', { type: 'status', runId: 'r', status: 'running' }))
    writeFileSync(join(dir, 'events.jsonl'), row('t2', { type: 'status', runId: 'r', status: 'done' }))
    expect((await readEventRows(dir)).map((r) => r.at)).toEqual(['t1', 't2'])
    expect((await readEventRows(dir, { limit: 10 })).map((r) => r.at)).toEqual(['t2'])
  })

  it('backfills the run id on legacy rows and skips malformed lines', async () => {
    writeFileSync(
      join(dir, 'events.jsonl'),
      `${row('t1', { type: 'status', status: 'running' })}not json\n${JSON.stringify({ event: {} })}\n`
    )
    const rows = await readEventRows(dir, { runId: 'run-x' })
    expect(rows).toHaveLength(1)
    expect((rows[0]!.event as { runId: string }).runId).toBe('run-x')
  })

  it('reads a missing file as no rows', async () => {
    expect(await readEventRows(join(dir, 'nope'))).toEqual([])
    expect(await readHydrationEvents(join(dir, 'nope'), 'r')).toEqual([])
  })

  it('hydrates the tail plus the latest critical rows from before it', async () => {
    const lines = [
      row('c1', { type: 'writes_checkpoint', runId: 'r', checkpointId: 'cp1', files: [] }),
      row('c2', { type: 'writes_checkpoint', runId: 'r', checkpointId: 'cp2', files: [] }),
      row('m', { type: 'mode_changed', runId: 'r', mode: 'ask' }),
      row('s-run', { type: 'status', runId: 'r', status: 'running' }),
      row('s-done', { type: 'status', runId: 'r', status: 'done' })
    ]
    for (let i = 0; i < 20; i++) lines.push(row(`t${i}`, { type: 'text_delta', runId: 'r', text: 'x' }))
    writeFileSync(join(dir, 'events.jsonl'), lines.join(''))
    const rows = await readHydrationEvents(dir, 'r', 5)
    const ats = rows.map((r) => r.at)
    expect(ats.slice(0, 5)).toEqual(['t15', 't16', 't17', 't18', 't19'])
    // Terminal status (not the running one), the mode, and both checkpoints.
    expect(new Set(ats.slice(5))).toEqual(new Set(['s-done', 'm', 'c1', 'c2']))
  })

  it('sums step usage across archives and the live file', async () => {
    const usage = (step: number, inputTokens: number): string =>
      row(`u${step}`, { type: 'step_usage', runId: 'r', step, inputTokens, outputTokens: 10 })
    writeFileSync(join(dir, 'events.archive.2026-01-01T00-00-00-000Z.jsonl'), usage(1, 100))
    writeFileSync(join(dir, 'events.jsonl'), usage(2, 200))
    const totals = await sumStepUsage(dir)
    expect(totals.steps).toBe(2)
    expect(totals.outputTokens).toBe(20)
  })

  it('rewrites after pending appends, keeps each row time, and drops archives', async () => {
    writeFileSync(join(dir, 'events.archive.2026-01-01T00-00-00-000Z.jsonl'), row('a', { type: 'status', runId: 'r', status: 'running' }))
    void appendEvent(dir, { type: 'status', runId: 'r', status: 'done' } as AgentEvent)
    const rows = await readEventRows(dir)
    await rewriteEvents(dir, rows.slice(0, 1))
    expect(readFileSync(join(dir, 'events.jsonl'), 'utf8')).toBe(row('a', { type: 'status', runId: 'r', status: 'running' }))
    expect(readdirSync(dir).some((n) => n.startsWith('events.archive.'))).toBe(false)
    expect(existsSync(join(dir, 'events.jsonl'))).toBe(true)
  })
})
