import { describe, expect, it } from 'vitest'
import type { GitStatus, HomeActivityResult, PrView } from '@shared/ipc'
import type { ViewBlockOf } from '@shared/viewSpec'
import {
  branchBlock,
  changesBlock,
  checkState,
  checksBlock,
  commitsBlock,
  daysBlock,
  localDayKey,
  spendBlock,
  taskChangesBlock
} from '@shared/viewLiveBlocks'

const live = (source: ViewBlockOf<'live'>['source'], over: Partial<ViewBlockOf<'live'>> = {}): ViewBlockOf<'live'> => ({ type: 'live', source, ...over })

const file = (path: string, added: number, removed: number, over: Partial<GitStatus['files'][number]> = {}): GitStatus['files'][number] => ({
  path,
  status: 'modified',
  added,
  removed,
  addedStaged: 0,
  removedStaged: 0,
  addedUnstaged: added,
  removedUnstaged: removed,
  binary: false,
  staged: false,
  unstaged: true,
  ...over
})

const status = (files: GitStatus['files'], over: Partial<GitStatus> = {}): GitStatus => ({
  branch: 'main',
  files,
  truncated: false,
  fileCount: files.length,
  added: files.reduce((s, f) => s + f.added, 0),
  removed: files.reduce((s, f) => s + f.removed, 0),
  hasRemote: true,
  hasCommits: true,
  ...over
})

describe('git.changes', () => {
  it('lists uncommitted files biggest first, split at the folder, each opening its diff', () => {
    const block = changesBlock(status([file('src/a.ts', 1, 0), file('src/deep/b.ts', 40, 2), file('gone.ts', 0, 9, { status: 'deleted' })]), live('git.changes'))
    expect(block.type).toBe('rows')
    if (block.type !== 'rows') return
    expect(block.items.map((r) => `${r.lead ?? ''}${r.title}`)).toEqual(['src/deep/b.ts', 'gone.ts', 'src/a.ts'])
    expect(block.items[0]).toMatchObject({ lead: 'src/deep/', title: 'b.ts', diff: { add: 40, del: 2 }, do: { action: 'diff', path: 'src/deep/b.ts' } })
    // A deleted file has no diff to open in the editor; its row says what happened.
    expect(block.items[1]).toMatchObject({ meta: 'deleted' })
    expect(block.items[1]!.do).toBeUndefined()
  })

  it('caps at its limit and counts the rest, and says so when there is nothing', () => {
    const many = Array.from({ length: 5 }, (_, i) => file(`f${i}.ts`, i, 0))
    const block = changesBlock(status(many), live('git.changes', { limit: 2 }))
    // The title counts all of them, not the rows shown.
    expect(block.type === 'rows' && [block.items.length, block.more, block.total]).toEqual([2, '3 more', 5])
    expect(changesBlock(status([]), live('git.changes'))).toEqual({ type: 'note', text: 'Nothing uncommitted', tone: 'muted' })
  })

  it('marks staged and new files, and leaves a binary file without line counts', () => {
    const block = changesBlock(status([file('n.ts', 3, 0, { status: 'untracked' }), file('s.ts', 2, 0, { staged: true, unstaged: false }), file('img.png', 0, 0, { binary: true })]), live('git.changes'))
    const meta = block.type === 'rows' ? Object.fromEntries(block.items.map((r) => [r.title, r.meta])) : {}
    expect(meta).toEqual({ 'n.ts': 'new', 's.ts': 'staged', 'img.png': 'binary' })
    expect(block.type === 'rows' && block.items.find((r) => r.title === 'img.png')?.diff).toBeUndefined()
  })
})

describe('git.branch', () => {
  it('says where the branch stands against its upstream', () => {
    const block = branchBlock(status([file('a.ts', 3, 1)], { ahead: 2, behind: 0, upstream: 'origin/main' }))
    expect(block.type === 'stats' && block.items.map((s) => [s.label, s.value])).toEqual([
      ['Branch', 'main'],
      ['Changed files', '1'],
      ['Ahead', '2'],
      ['Behind', '0']
    ])
  })

  it('says a branch with no upstream is not published', () => {
    const block = branchBlock(status([], { upstream: undefined }))
    expect(block.type === 'stats' && block.items.at(-1)).toMatchObject({ label: 'Upstream', value: 'none', hint: 'not published' })
  })
})

describe('git.commits', () => {
  it('is a table of the latest commits', () => {
    const block = commitsBlock([{ sha: 'abc1234def', shortSha: 'abc1234', subject: 'Fix it', author: 'Ann', relativeDate: '2 hours ago' }], live('git.commits'))
    expect(block).toMatchObject({
      type: 'table',
      rows: [{ id: 'abc1234def', cells: { sha: 'abc1234', subject: 'Fix it', author: 'Ann', when: '2 hours ago' }, do: { action: 'commit', sha: 'abc1234def' } }]
    })
  })
})

describe('pr.checks', () => {
  const check = (name: string, state: string, conclusion: string | null): PrView['checks'][number] => ({ name, state, conclusion })

  it('reads GitHub’s states into pass, fail, running and pending', () => {
    expect(checkState(check('a', 'COMPLETED', 'SUCCESS'))).toBe('pass')
    expect(checkState(check('a', 'COMPLETED', 'SKIPPED'))).toBe('pass')
    expect(checkState(check('a', 'COMPLETED', 'FAILURE'))).toBe('fail')
    expect(checkState(check('a', 'COMPLETED', 'TIMED_OUT'))).toBe('fail')
    expect(checkState(check('a', 'IN_PROGRESS', null))).toBe('running')
    expect(checkState(check('a', 'QUEUED', null))).toBe('pending')
    // A commit status context reports its state alone.
    expect(checkState(check('ctx', 'FAILURE', null))).toBe('fail')
  })

  it('lists failures first, under the pull request’s number', () => {
    const pr = { number: 7, checks: [check('lint', 'COMPLETED', 'SUCCESS'), check('test', 'COMPLETED', 'FAILURE'), check('build', 'IN_PROGRESS', null)] } as unknown as PrView
    const block = checksBlock(pr, live('pr.checks'))
    expect(block).toMatchObject({ type: 'checks', title: 'Checks on #7' })
    expect(block.type === 'checks' && block.items.map((c) => `${c.label}:${c.state}`)).toEqual(['test:fail', 'build:running', 'lint:pass'])
  })

  it('counts every check past the limit, cuts only passing ones, and says how many', () => {
    const passing = Array.from({ length: 25 }, (_, i) => check(`ok-${String(i).padStart(2, '0')}`, 'COMPLETED', 'SUCCESS'))
    const pr = { number: 9, checks: [...passing, check('test', 'COMPLETED', 'FAILURE')] } as unknown as PrView
    const block = checksBlock(pr, live('pr.checks'))
    expect(block).toMatchObject({ type: 'checks', total: 26, passed: 25, more: '6 more passed' })
    expect(block.type === 'checks' && block.items).toHaveLength(20)
    expect(block.type === 'checks' && block.items[0]!.label).toBe('test')
  })

  it('keeps two checks of the same name apart', () => {
    const pr = { number: 3, checks: [check('build', 'COMPLETED', 'SUCCESS'), check('build', 'COMPLETED', 'FAILURE')] } as unknown as PrView
    const block = checksBlock(pr, live('pr.checks'))
    const ids = block.type === 'checks' ? block.items.map((c) => c.id) : []
    expect(new Set(ids).size).toBe(2)
  })
})

describe('task.changes', () => {
  it('lists the task’s files with what it did to each', () => {
    const block = taskChangesBlock([{ path: 'src/new.ts', action: 'created', add: 10, del: 0 }, { path: 'old.ts', action: 'deleted' }], live('task.changes'))
    expect(block.type === 'rows' && block.items.map((r) => [r.title, r.meta, r.do?.action])).toEqual([
      ['new.ts', 'new', 'diff'],
      ['old.ts', 'deleted', undefined]
    ])
  })
})

describe('usage', () => {
  const now = new Date(2026, 9, 9, 15, 0)
  const day = (offset: number, billed: number, runs = 1): HomeActivityResult['days'][number] => {
    const d = new Date(now)
    d.setDate(d.getDate() - offset)
    return { date: localDayKey(d), runs, billedInputTokens: 0, outputTokens: 0, billedCost: billed }
  }
  const activity = (days: HomeActivityResult['days']): HomeActivityResult => ({ days }) as unknown as HomeActivityResult

  it('sums today, the last 7 days and the last 30 from the days read', () => {
    const block = spendBlock(activity([day(0, 1.5, 2), day(3, 2), day(10, 4), day(40, 100)]), now)
    expect(block.type === 'stats' && block.items.map((s) => [s.label, s.value, s.hint])).toEqual([
      ['Today', '$1.50', '2 runs'],
      ['Last 7 days', '$3.50', '3 runs'],
      ['Last 30 days', '$7.50', '4 runs']
    ])
  })

  it('draws one bar a day, a day without spend a zero rather than a gap', () => {
    const block = daysBlock(activity([day(0, 2), day(2, 1)]), live('usage.days', { limit: 3 }), now)
    expect(block.type === 'chart' && block.spec).toMatchObject({ type: 'bar', labels: ['7/10', '8/10', '9/10'], values: [1, 0, 2] })
  })

  it('says there was no spend rather than drawing empty bars', () => {
    expect(daysBlock(activity([day(0, 0, 5)]), live('usage.days'), now)).toEqual({ type: 'note', text: 'No spend in the last 14 days', tone: 'muted' })
  })
})
