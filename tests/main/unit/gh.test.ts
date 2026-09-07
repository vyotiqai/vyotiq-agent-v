import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileAsync } = vi.hoisted(() => ({
  execFileAsync: vi.fn()
}))

vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>()
  return {
    ...actual,
    promisify: () => execFileAsync
  }
})

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' }))
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/vyotiq-userdata'
  }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    readdirSync: vi.fn(() => [])
  }
})

vi.mock('@main/agent/tools/terminal', () => ({
  commandOnPath: vi.fn(() => false),
  invalidateCommandOnPathCache: vi.fn(),
  sanitizedTerminalEnv: vi.fn(() => ({ PATH: '/bin' }))
}))

import { existsSync } from 'fs'
import {
  extractFilePatch,
  ghAvailable,
  prClose,
  prCreate,
  prCreateFromChanges,
  prDiff,
  prEditTitle,
  prMerge,
  prView,
  resetGhAvailableCacheForTests
} from '@main/git/gh'

const bundledGhPath =
  process.platform === 'win32'
    ? '/tmp/vyotiq-userdata/bin/gh.exe'
    : '/tmp/vyotiq-userdata/bin/gh'

function mockGhInstalled(): void {
  vi.mocked(existsSync).mockImplementation((target) => {
    return String(target).replace(/\\/g, '/') === bundledGhPath
  })
}

describe('gh helpers', () => {
  beforeEach(() => {
    execFileAsync.mockReset()
    vi.mocked(existsSync).mockReturnValue(false)
    resetGhAvailableCacheForTests()
  })

  it('ghAvailable is false when gh is missing', async () => {
    execFileAsync.mockRejectedValue(new Error('not found'))
    await expect(ghAvailable()).resolves.toBe(false)
  })

  it('prView throws when gh is unavailable', async () => {
    execFileAsync.mockRejectedValue(new Error('not found'))
    await expect(prView('/ws')).rejects.toThrow(/GitHub CLI/)
  })

  it('prView returns null for genuine no-PR errors', async () => {
    mockGhInstalled()
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockRejectedValueOnce(new Error('no pull requests found for branch "feat"'))
    await expect(prView('/ws')).resolves.toBeNull()
  })

  it('prView throws when cwd is not a git/GitHub repo', async () => {
    mockGhInstalled()
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockRejectedValueOnce(
        Object.assign(new Error('Command failed: gh pr view --json number'), {
          stderr: 'failed to run git: fatal: not a git repository'
        })
      )
    await expect(prView('/ws')).rejects.toThrow(/not a git repository/i)
  })

  it('prView throws when the repo has no git remotes', async () => {
    mockGhInstalled()
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            'Command failed: gh pr view --json number,title,url,state,baseRefName,headRefName,baseRefOid,headRefOid,body,additions,deletions\nno git remotes found\n'
          ),
          { stderr: 'no git remotes found\n' }
        )
      )
    await expect(prView('/ws')).rejects.toThrow(/no git remotes found/i)
  })

  it('prView falls back when optional JSON fields are unknown', async () => {
    mockGhInstalled()
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockRejectedValueOnce(new Error('Unknown JSON field: "reviewRequests"'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 7,
          title: 'Fallback',
          url: 'https://example.com/pr/7',
          state: 'OPEN',
          baseRefName: 'main',
          headRefName: 'feat',
          baseRefOid: 'base',
          headRefOid: 'head',
          body: '',
          additions: 1,
          deletions: 0,
          files: [],
          commits: [],
          statusCheckRollup: []
        }),
        stderr: ''
      })
    const view = await prView('/ws')
    expect(view?.number).toBe(7)
    expect(view?.reviews).toEqual([])
    expect(view?.reviewRequests).toEqual([])
  })

  it('prView maps gh JSON into PrView', async () => {
    mockGhInstalled()
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 12,
          title: 'Dock WIP',
          url: 'https://example.com/pr/12',
          state: 'OPEN',
          baseRefName: 'main',
          headRefName: 'feat',
          baseRefOid: 'baseoid',
          headRefOid: 'headoid',
          body: 'notes',
          additions: 3,
          deletions: 1,
          files: [{ path: 'a.ts', additions: 3, deletions: 1, changeType: 'ADDED' }],
          commits: [{ oid: 'abc', messageHeadline: 'wip', authors: [{ login: 'u' }] }],
          statusCheckRollup: [{ name: 'ci', state: 'SUCCESS', conclusion: 'SUCCESS' }],
          reviews: [
            {
              author: { login: 'rev' },
              state: 'APPROVED',
              body: 'lgtm',
              submittedAt: '2026-01-01T00:00:00Z'
            }
          ],
          latestReviews: [
            {
              author: { login: 'rev' },
              state: 'APPROVED',
              body: 'lgtm',
              submittedAt: '2026-01-01T00:00:00Z'
            }
          ],
          reviewDecision: 'APPROVED',
          reviewRequests: [{ login: 'alice' }]
        }),
        stderr: ''
      })
    const view = await prView('/ws')
    expect(view?.number).toBe(12)
    expect(view?.files[0]?.path).toBe('a.ts')
    expect(view?.files[0]?.changeType).toBe('ADDED')
    expect(view?.commits[0]?.authors).toEqual(['u'])
    expect(view?.checks[0]?.name).toBe('ci')
    expect(view?.reviews[0]?.author).toBe('rev')
    expect(view?.reviewDecision).toBe('APPROVED')
    expect(view?.reviewRequests).toEqual(['alice'])
    expect(view?.baseRefOid).toBe('baseoid')
    expect(view?.isDraft).toBe(false)
  })

  it('prView throws on HTTP 404 instead of treating it as no PR', async () => {
    mockGhInstalled()
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockRejectedValueOnce(
        Object.assign(new Error('Command failed: gh pr view'), {
          stderr: 'HTTP 404: Not Found\nrepository not found'
        })
      )
    await expect(prView('/ws')).rejects.toThrow()
  })

  it('prCreate pushes a topic branch and creates a draft non-interactively', async () => {
    mockGhInstalled()
    vi.mocked(existsSync).mockImplementation((target) => {
      const normalized = String(target).replace(/\\/g, '/')
      return normalized === bundledGhPath || normalized.endsWith('/ws/.git')
    })
    execFileAsync.mockImplementation(async (_executable, rawArgs) => {
      const args = rawArgs as string[]
      if (args[0] === '--version') return { stdout: 'gh version 2.0', stderr: '' }
      if (args[0] === 'auth' && args[1] === 'setup-git') return { stdout: '', stderr: '' }
      if (args[0] === 'remote') return { stdout: 'origin\n', stderr: '' }
      if (args[0] === 'symbolic-ref') return { stdout: 'feat/panels\n', stderr: '' }
      if (args[0] === 'repo' && args[1] === 'view') {
        return { stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }), stderr: '' }
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        throw new Error('no pull requests found for branch "feat/panels"')
      }
      if (args[0] === 'rev-parse' && args.includes('@{upstream}')) {
        throw new Error('no upstream configured')
      }
      if (args[0] === 'rev-parse') return { stdout: 'feat/panels\n', stderr: '' }
      if (args[0] === 'push') return { stdout: '', stderr: '' }
      if (args[0] === 'pr' && args[1] === 'create') {
        return { stdout: 'https://github.com/ex/repo/pull/11\n', stderr: '' }
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    })

    await expect(prCreate('/ws')).resolves.toEqual({
      url: 'https://github.com/ex/repo/pull/11',
      branch: 'feat/panels',
      baseBranch: 'main',
      draft: true,
      detail: 'Draft pull request created'
    })
    const createArgs = execFileAsync.mock.calls.find(
      (call) => (call[1] as string[] | undefined)?.[1] === 'create'
    )?.[1] as string[] | undefined
    expect(createArgs).toEqual(
      expect.arrayContaining(['pr', 'create', '--base', 'main', '--head', 'feat/panels', '--fill', '--draft'])
    )
  })

  it('prCreate does not create a GitHub repository when the repo has no commits', async () => {
    mockGhInstalled()
    vi.mocked(existsSync).mockImplementation((target) => {
      const normalized = String(target).replace(/\\/g, '/')
      return normalized === bundledGhPath || normalized.endsWith('/ws/.git')
    })
    execFileAsync.mockImplementation(async (_executable, rawArgs) => {
      const args = rawArgs as string[]
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        throw new Error('fatal: Needed a single revision')
      }
      if (args[0] === 'repo' && args[1] === 'create') {
        throw new Error('should not create a GitHub repository')
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    })

    await expect(prCreate('/ws')).rejects.toThrow(/no initial commit/i)
    expect(
      execFileAsync.mock.calls.some((call) => (call[1] as string[] | undefined)?.[1] === 'create')
    ).toBe(false)
  })

  it('prCreateFromChanges creates a topic branch before committing from the default branch', async () => {
    mockGhInstalled()
    vi.mocked(existsSync).mockImplementation((target) => {
      const normalized = String(target).replace(/\\/g, '/')
      return normalized === bundledGhPath || normalized.endsWith('/ws/.git')
    })
    execFileAsync.mockImplementation(async (_executable, rawArgs) => {
      const args = rawArgs as string[]
      if (args[0] === '--version') return { stdout: 'gh version 2.0', stderr: '' }
      if (args[0] === 'auth' && args[1] === 'setup-git') return { stdout: '', stderr: '' }
      if (args[0] === 'remote') return { stdout: 'origin\n', stderr: '' }
      if (args[0] === 'symbolic-ref') return { stdout: 'main\n', stderr: '' }
      if (args[0] === 'repo' && args[1] === 'view') {
        return { stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }), stderr: '' }
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        throw new Error('no pull requests found for branch "main"')
      }
      if (args[0] === 'check-ref-format') return { stdout: `${args[2]}\n`, stderr: '' }
      if (args[0] === 'show-ref') throw new Error('branch does not exist')
      if (args[0] === 'switch') return { stdout: '', stderr: '' }
      if (args[0] === 'status') return { stdout: ' M file.ts\0', stderr: '' }
      if (args[0] === 'add') return { stdout: '', stderr: '' }
      if (args[0] === 'diff' && args.includes('--cached')) {
        return { stdout: 'file.ts\n', stderr: '' }
      }
      if (args[0] === 'commit') return { stdout: '[branch abc] ship it\n', stderr: '' }
      if (args[0] === 'rev-parse') {
        if (args.includes('@{upstream}')) throw new Error('no upstream configured')
        return { stdout: 'vyotiq/ship-it-abc\n', stderr: '' }
      }
      if (args[0] === 'push') return { stdout: '', stderr: '' }
      if (args[0] === 'pr' && args[1] === 'create') {
        return { stdout: 'https://github.com/ex/repo/pull/12\n', stderr: '' }
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    })

    const result = await prCreateFromChanges('/ws', 'ship it', 'all')
    expect(result).toMatchObject({
      url: 'https://github.com/ex/repo/pull/12',
      baseBranch: 'main',
      draft: true,
      detail: 'Draft pull request created'
    })
    expect(result.branch).toMatch(/^vyotiq\/ship-it-/)
    const createArgs = execFileAsync.mock.calls.find(
      (call) => (call[1] as string[] | undefined)?.[1] === 'create'
    )?.[1] as string[] | undefined
    expect(createArgs).toEqual(
      expect.arrayContaining(['pr', 'create', '--base', 'main', '--head', result.branch, '--fill', '--draft'])
    )
  })

  it('automatically creates a private repository when no remote exists', async () => {
    mockGhInstalled()
    vi.mocked(existsSync).mockImplementation((target) => {
      const normalized = String(target).replace(/\\/g, '/')
      return normalized === bundledGhPath || normalized.endsWith('/ws/.git')
    })

    let remoteConfigured = false
    let repositoryCreated = false
    execFileAsync.mockImplementation(async (_executable, rawArgs) => {
      const args = rawArgs as string[]
      if (args[0] === '--version') return { stdout: 'gh version 2.0', stderr: '' }
      if (args[0] === 'auth' && args[1] === 'setup-git') return { stdout: '', stderr: '' }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        if (remoteConfigured) return { stdout: 'https://github.com/vyotiqai/ws.git\n', stderr: '' }
        throw new Error('No such remote')
      }
      if (args[0] === 'remote' && args[1] === 'add') {
        remoteConfigured = true
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: remoteConfigured ? 'origin\n' : '', stderr: '' }
      }
      if (args[0] === 'repo' && args[1] === 'view' && args.includes('nameWithOwner,url')) {
        if (!repositoryCreated) throw new Error('Could not resolve to a Repository')
        return {
          stdout: JSON.stringify({
            nameWithOwner: 'vyotiqai/ws',
            url: 'https://github.com/vyotiqai/ws'
          }),
          stderr: ''
        }
      }
      if (args[0] === 'repo' && args[1] === 'create') {
        repositoryCreated = true
        return { stdout: 'https://github.com/vyotiqai/ws\n', stderr: '' }
      }
      if (args[0] === 'repo' && args[1] === 'view') {
        return { stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }), stderr: '' }
      }
      if (args[0] === 'symbolic-ref') return { stdout: 'main\n', stderr: '' }
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        return { stdout: 'a'.repeat(40) + '\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('@{upstream}')) {
        throw new Error('no upstream configured')
      }
      if (args[0] === 'rev-parse') return { stdout: 'vyotiq/ws-branch\n', stderr: '' }
      if (args[0] === 'check-ref-format') return { stdout: `${args[2]}\n`, stderr: '' }
      if (args[0] === 'pr' && args[1] === 'view') {
        throw new Error('no pull requests found for branch')
      }
      if (args[0] === 'show-ref') throw new Error('branch does not exist')
      if (args[0] === 'switch') return { stdout: '', stderr: '' }
      if (args[0] === 'status') return { stdout: ' M file.ts\0', stderr: '' }
      if (args[0] === 'add') return { stdout: '', stderr: '' }
      if (args[0] === 'diff' && args.includes('--cached')) {
        return { stdout: 'file.ts\n', stderr: '' }
      }
      if (args[0] === 'commit') return { stdout: '[branch abc] ship it\n', stderr: '' }
      if (args[0] === 'push') return { stdout: '', stderr: '' }
      if (args[0] === 'pr' && args[1] === 'create') {
        return { stdout: 'https://github.com/vyotiqai/ws/pull/13\n', stderr: '' }
      }
      throw new Error(`unexpected command: ${args.join(' ')}`)
    })

    const result = await prCreateFromChanges('/ws', 'ship it', 'all')
    expect(result).toMatchObject({
      url: 'https://github.com/vyotiqai/ws/pull/13',
      baseBranch: 'main',
      draft: true,
      detail: 'Created private GitHub repository vyotiqai/ws; Draft pull request created'
    })
    expect(
      execFileAsync.mock.calls.some(
        (call) =>
          (call[1] as string[] | undefined)?.includes('create') &&
          (call[1] as string[] | undefined)?.includes('--private')
      )
    ).toBe(true)
    expect(
      execFileAsync.mock.calls.some((call) => {
        const args = call[1] as string[] | undefined
        return args?.[0] === 'remote' && args[1] === 'add' && args[2] === 'origin'
      })
    ).toBe(true)
  })

  it('prMerge throws when gh is missing', async () => {
    execFileAsync.mockRejectedValue(new Error('not found'))
    await expect(prMerge('/ws', 'squash', 12)).rejects.toThrow(/GitHub CLI/i)
  })

  it('prDiff uses git between base and head OIDs', async () => {
    mockGhInstalled()
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          baseRefOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          headRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
        }),
        stderr: ''
      })
      .mockResolvedValueOnce({ stdout: '@@ -1 +1 @@\n+hi\n', stderr: '' })
    const result = await prDiff('/ws', { number: 12, path: 'a.ts', ignoreWhitespace: true })
    expect(result.content).toContain('+hi')
    const argsList = execFileAsync.mock.calls.map((c) => c[1] as string[] | undefined)
    expect(argsList.some((a) => a?.includes('diff') && a?.includes('--ignore-all-space'))).toBe(
      true
    )
    expect(
      argsList.some(
        (a) =>
          a?.includes('--end-of-options') &&
          a?.includes(
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa...bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
          )
      )
    ).toBe(true)
    expect(argsList.some((a) => a?.includes('12') && a?.includes('pr'))).toBe(true)
  })

  it('prMerge includes the PR number', async () => {
    mockGhInstalled()
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'merged\n', stderr: '' })
    await expect(prMerge('/ws', 'squash', 12)).resolves.toEqual({ detail: 'merged' })
    const mergeArgs = execFileAsync.mock.calls.find((c) => (c[1] as string[])[1] === 'merge')
    expect(mergeArgs?.[1]).toEqual(expect.arrayContaining(['merge', '12']))
  })

  it('prClose includes the PR number', async () => {
    mockGhInstalled()
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'closed\n', stderr: '' })
    await expect(prClose('/ws', 12)).resolves.toEqual({ detail: 'closed' })
    const closeArgs = execFileAsync.mock.calls.find((c) => (c[1] as string[])[1] === 'close')
    expect(closeArgs?.[1]).toEqual(expect.arrayContaining(['close', '12']))
  })

  it('prEditTitle includes the PR number', async () => {
    mockGhInstalled()
    execFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
    await expect(prEditTitle('/ws', 'New title', 12)).resolves.toEqual({ title: 'New title' })
    const editArgs = execFileAsync.mock.calls.find((c) => (c[1] as string[])[1] === 'edit')
    expect(editArgs?.[1]).toEqual(expect.arrayContaining(['edit', '12', '--title', 'New title']))
  })

  it('extractFilePatch matches quoted diff --git paths', () => {
    const patch = [
      'diff --git "a/foo bar.ts" "b/foo bar.ts"',
      '--- "a/foo bar.ts"',
      '+++ "b/foo bar.ts"',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/other.ts b/other.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y'
    ].join('\n')
    const extracted = extractFilePatch(patch, 'foo bar.ts')
    expect(extracted).toContain('foo bar.ts')
    expect(extracted).toContain('+new')
    expect(extracted).not.toContain('other.ts')
  })
})
