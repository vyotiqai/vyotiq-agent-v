import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatus } from '@shared/ipc'
import { parseViewSpec } from '@shared/viewSpec'

/*
  show_view tells the model what its live blocks show the user, read the way
  the record reads them, so the words it writes next agree with the view.
*/

const reads = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitLog: vi.fn(),
  prView: vi.fn()
}))
vi.mock('@main/git/gitStatusCache', () => ({ readGitStatusCached: reads.gitStatus, invalidateGitStatusCache: vi.fn() }))
vi.mock('@main/git/git', () => ({ readGitLog: reads.gitLog }))
vi.mock('@main/git/gh', () => ({ prView: reads.prView }))

import { describeLiveBlocks } from '@main/agent/tools/viewLiveReads'

const status = (files: Array<{ path: string; added: number }>): GitStatus =>
  ({
    branch: 'main',
    files: files.map((f) => ({ ...f, status: 'modified', removed: 0, addedStaged: 0, removedStaged: 0, addedUnstaged: f.added, removedUnstaged: 0, binary: false, staged: false, unstaged: true })),
    truncated: false,
    fileCount: files.length,
    added: 0,
    removed: 0,
    hasRemote: true,
    hasCommits: true
  }) as GitStatus

const view = (blocks: unknown[]) => parseViewSpec(JSON.stringify({ id: 'v', title: 'V', blocks }))!

beforeEach(() => {
  reads.gitStatus.mockReset()
  reads.gitLog.mockReset()
  reads.prView.mockReset()
})

describe('what show_view says its live blocks show', () => {
  it('says nothing for a view with no live block', async () => {
    expect(await describeLiveBlocks(view([{ type: 'note', text: 'hi' }]), 'C:/w', 'r1')).toBe('')
  })

  it('gives each live block’s read as the record would draw it', async () => {
    reads.gitStatus.mockResolvedValue({ kind: 'ok', status: status([{ path: 'src/a.ts', added: 3 }]) })
    const text = await describeLiveBlocks(view([{ type: 'live', source: 'git.changes' }]), 'C:/w', 'r1')
    expect(text).toContain('What its live blocks show the user now')
    expect(text).toContain('git.changes:')
    expect(text).toContain('**Uncommitted** (1)')
    expect(text).toContain('- src/a.ts · +3 −0')
    expect(reads.gitStatus).toHaveBeenCalledWith('C:/w')
  })

  it('says a read failed, in a line, and that the user’s view reads it itself', async () => {
    reads.prView.mockRejectedValue(new Error('no git remotes found\nCommand failed: gh pr view --json number,title'))
    const text = await describeLiveBlocks(view([{ type: 'live', source: 'pr.checks' }]), 'C:/w', 'r1')
    expect(text).toContain("pr.checks: not read here (this workspace has no git remote, so no pull request); the user's view reads it itself")
    expect(text).not.toContain('Command failed')
  })

  it('says when there is no pull request rather than inventing checks', async () => {
    reads.prView.mockResolvedValue(null)
    const text = await describeLiveBlocks(view([{ type: 'live', source: 'pr.checks', title: 'CI' }]), 'C:/w', 'r1')
    expect(text).toContain('pr.checks ("CI"):\nNo pull request for this branch')
  })

  it('says a task’s own changes need a task', async () => {
    const text = await describeLiveBlocks(view([{ type: 'live', source: 'task.changes' }]), 'C:/w', undefined)
    expect(text).toContain('Only a task has changes of its own')
  })

  it('keeps a long read short', async () => {
    reads.gitStatus.mockResolvedValue({ kind: 'ok', status: status(Array.from({ length: 40 }, (_, i) => ({ path: `src/file${i}.ts`, added: i + 1 }))) })
    const text = await describeLiveBlocks(view([{ type: 'live', source: 'git.changes', limit: 40 }]), 'C:/w', 'r1')
    expect(text).toContain('more lines')
    expect(text.length).toBeLessThan(2_200)
  })
})
