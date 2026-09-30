import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userData = mkdtempSync(join(tmpdir(), 'vyotiq-run-search-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

import { searchRuns, snippetAround } from '@main/agent/runSearch'
import { workspaceSessionsRoot } from '@main/storage/paths'

const WS = join(userData, 'project')

function seedRun(
  runId: string,
  status: Record<string, unknown>,
  messages: unknown[],
  archives: Record<string, unknown[]> = {}
): void {
  const dir = join(workspaceSessionsRoot(WS), runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ status: 'done', workspacePath: WS, ...status }))
  writeFileSync(join(dir, 'messages.jsonl'), messages.map((m) => JSON.stringify(m)).join('\n') + '\n')
  for (const [name, rows] of Object.entries(archives)) {
    writeFileSync(join(dir, name), rows.map((m) => JSON.stringify(m)).join('\n') + '\n')
  }
}

beforeEach(() => {
  rmSync(join(userData, 'workspaces'), { recursive: true, force: true })
})
afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('snippetAround', () => {
  it('keeps the match with context on one line and says where it is', () => {
    const text = `${'a'.repeat(200)}\n\nthe flaky   retry loop\nin CI${'b'.repeat(200)}`
    const at = text.indexOf('retry loop')
    const { snippet, start } = snippetAround(text, at, 'retry loop'.length)
    expect(snippet.slice(start, start + 'retry loop'.length)).toBe('retry loop')
    expect(snippet).not.toMatch(/\n/)
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.length).toBeLessThanOrEqual(124)
  })
})

describe('searchRuns', () => {
  it('finds titles first, then words said in a task, newest task first, one hit per task', async () => {
    seedRun('r-old', { goal: 'Old work', updatedAt: '2026-09-01T00:00:00Z' }, [
      { role: 'user', content: 'Please fix the retry loop in CI' },
      { role: 'assistant', content: 'I changed the retry loop to back off.' }
    ])
    seedRun('r-new', { goal: 'Tidy the retry loop docs', updatedAt: '2026-09-20T00:00:00Z' }, [
      { role: 'user', content: 'nothing relevant' }
    ])
    seedRun('r-none', { goal: 'Unrelated', updatedAt: '2026-09-25T00:00:00Z' }, [{ role: 'user', content: 'hello' }])

    const result = await searchRuns({ workspacePaths: [WS], query: 'Retry Loop', maxResults: 50 })
    expect(result.truncated).toBe(false)
    expect(result.scannedRuns).toBe(3)
    expect(result.hits.map((h) => [h.runId, h.where])).toEqual([
      ['r-new', 'title'],
      ['r-old', 'agent']
    ])
    const agent = result.hits[1]!
    // The last (newest) mention in the task, with the match located in the line.
    expect(agent.snippet).toContain('I changed the retry loop')
    expect(agent.snippet.slice(agent.matchStart, agent.matchStart + agent.matchLength).toLowerCase()).toBe('retry loop')
    expect(agent.title).toBe('Old work')
  })

  it('reads rotated archives, and skips system, synthetic, attachment-only and instance matches', async () => {
    seedRun(
      'r-archived',
      { goal: 'Long task', updatedAt: '2026-09-10T00:00:00Z' },
      [{ role: 'assistant', content: 'recent words only' }],
      { 'messages.archive.2026-09-09T00-00-00.000Z.jsonl': [{ role: 'user', content: 'the needle was here long ago' }] }
    )
    seedRun('r-noise', { goal: 'Noise', updatedAt: '2026-09-11T00:00:00Z' }, [
      { role: 'system', content: 'needle in the system prompt' },
      { role: 'user', content: 'needle from a nudge', synthetic: true },
      // base64 that happens to contain the letters: only real text counts.
      { role: 'user', content: [{ type: 'image', url: 'data:image/png;base64,needleneedle' }] }
    ])
    seedRun('r-child', { goal: 'Instance', updatedAt: '2026-09-12T00:00:00Z', inlineInstance: true, parentRunId: 'r-archived' }, [
      { role: 'assistant', content: 'needle inside an instance' }
    ])
    const result = await searchRuns({ workspacePaths: [WS], query: 'needle', maxResults: 50 })
    expect(result.hits.map((h) => [h.runId, h.where])).toEqual([['r-archived', 'you']])
  })

  it('stops at the result cap, says so, and stops when a newer query supersedes it', async () => {
    for (let i = 0; i < 5; i++) {
      seedRun(`r${i}`, { goal: `match ${i}`, updatedAt: `2026-09-0${i + 1}T00:00:00Z` }, [])
    }
    const capped = await searchRuns({ workspacePaths: [WS], query: 'match', maxResults: 2 })
    expect(capped.hits.map((h) => h.runId)).toEqual(['r4', 'r3'])
    expect(capped.truncated).toBe(true)

    const superseded = await searchRuns({ workspacePaths: [WS], query: 'match', maxResults: 50 }, { isCurrent: () => false })
    expect(superseded.hits).toEqual([])

    const outOfTime = await searchRuns({ workspacePaths: [WS], query: 'match', maxResults: 50 }, { budgetMs: -1 })
    expect(outOfTime.truncated).toBe(true)
  })

  it('is empty, not an error, for a workspace with no tasks', async () => {
    await expect(searchRuns({ workspacePaths: [join(userData, 'nowhere')], query: 'x y', maxResults: 5 })).resolves.toEqual({
      hits: [],
      truncated: false,
      scannedRuns: 0
    })
  })
})
