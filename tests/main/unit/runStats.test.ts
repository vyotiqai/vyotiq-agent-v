import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectRunStats } from '@main/agent/runStats'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => join(tmpdir(), `vyotiq-${name}`),
    getAppPath: () => join(tmpdir(), 'vyotiq-app'),
    isPackaged: false
  }
}))

const root = mkdtempSync(join(tmpdir(), `vyotiq-runstats-${process.pid}-`))

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

function makeRun(id: string, files: Record<string, string>): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
}

describe('collectRunStats', () => {
  it('stitches archive heads + live transcript and extracts receipt tokenUsage', async () => {
    makeRun('run-1', {
      'messages.archive.20260101T000000.jsonl': '{"role":"user"}\n{"role":"assistant"}\n',
      'messages.jsonl': '{"role":"user"}\n',
      'receipt.json': JSON.stringify({
        tokenUsage: { billedInputTokens: 1500, outputTokens: 120 }
      })
    })

    const stats = await collectRunStats(root, ['run-1'])

    expect(stats).toEqual([
      {
        runId: 'run-1',
        messages: 3,
        tokenUsage: { billedInputTokens: 1500, outputTokens: 120 }
      }
    ])
  })

  it('counts a final line without trailing newline and handles missing receipt', async () => {
    makeRun('run-2', { 'messages.jsonl': '{"role":"user"}\n{"role":"assistant"}' })

    const stats = await collectRunStats(root, ['run-2'])

    expect(stats).toEqual([{ runId: 'run-2', messages: 2 }])
  })

  it('returns zero messages for a run dir without a transcript', async () => {
    makeRun('run-3', {})

    const stats = await collectRunStats(root, ['run-3'])

    expect(stats).toEqual([{ runId: 'run-3', messages: 0 }])
  })

  it('omits runs whose id fails the containment guard, never zero-filling them', async () => {
    makeRun('run-4', { 'messages.jsonl': 'x\n' })

    const stats = await collectRunStats(root, ['..\\escape', 'run-4'])

    expect(stats).toEqual([{ runId: 'run-4', messages: 1 }])
  })

  it('omits tokenUsage from a corrupt receipt but still counts messages', async () => {
    makeRun('run-5', { 'messages.jsonl': 'a\n', 'receipt.json': '{not json' })

    const stats = await collectRunStats(root, ['run-5'])

    expect(stats).toEqual([{ runId: 'run-5', messages: 1 }])
  })
})
