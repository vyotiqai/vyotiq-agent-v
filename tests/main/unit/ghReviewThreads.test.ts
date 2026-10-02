import { join } from 'node:path'
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

vi.mock('@main/git/repoCommandGuard', () => ({
  guardGitInvocation: vi.fn(async (args: readonly string[], _cwd: string, env: NodeJS.ProcessEnv) => ({
    args: [...args],
    env: { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: '' }
  }))
}))

import { existsSync } from 'fs'
import {
  mapReviewThread,
  parseReviewThreadsPage,
  prCheckout,
  prList,
  prReviewThreadReply,
  prReviewThreadResolve,
  prReviewThreads,
  resetGhAvailableCacheForTests
} from '@main/git/gh'

// The real fs: `fs` is mocked for the code under test.
const { readFileSync: readFixtureSync } = await vi.importActual<typeof import('fs')>('fs')
const fixtureDir = join(__dirname, '../../fixtures/github')
const page1 = readFixtureSync(join(fixtureDir, 'reviewThreadsPage1.json'), 'utf8')
const page2 = readFixtureSync(join(fixtureDir, 'reviewThreadsPage2.json'), 'utf8')

const bundledGhPath =
  process.platform === 'win32' ? '/tmp/vyotiq-userdata/bin/gh.exe' : '/tmp/vyotiq-userdata/bin/gh'

function mockFs(): void {
  vi.mocked(existsSync).mockImplementation((target) => {
    const p = String(target).replace(/\\/g, '/')
    return p === bundledGhPath || p.endsWith('/ws/.git')
  })
}

type Route = (args: string[]) => { stdout: string } | Error | undefined

function routeExec(route: Route): void {
  execFileAsync.mockImplementation(async (_bin: string, args: string[]) => {
    if (args[0] === '--version') return { stdout: 'gh version 2.60.0', stderr: '' }
    const out = route(args)
    if (out instanceof Error) throw out
    if (!out) throw new Error(`unexpected call: ${args.join(' ')}`)
    return { stderr: '', ...out }
  })
}

function ghError(stderr: string): Error {
  return Object.assign(new Error('Command failed: gh api graphql -f query=…'), { stderr })
}

function graphqlField(args: string[], name: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`${name}=`))
  return hit?.slice(name.length + 1)
}

describe('review thread mapping', () => {
  it('maps a GraphQL page into threads, skipping null and unusable nodes', () => {
    const page = parseReviewThreadsPage(page1)!
    expect(page.totalCount).toBe(4)
    expect(page.hasNextPage).toBe(true)
    expect(page.endCursor).toBe('Y3Vyc29yOjM=')
    expect(page.threads.map((t) => t.id)).toEqual(['PRRT_kwDOAbc123', 'PRRT_kwDOAbc124', 'PRRT_kwDOAbc125'])

    const [open, resolved, outdated] = page.threads
    expect(open).toMatchObject({
      path: 'src/main/app.ts',
      line: 42,
      originalLine: 40,
      startLine: 40,
      diffSide: 'RIGHT',
      isResolved: false,
      isOutdated: false,
      viewerCanResolve: true,
      viewerCanReply: true,
      commentCount: 3
    })
    expect(open!.comments[0]).toEqual({
      id: 'PRRC_1',
      author: 'alice',
      body: 'Rename this to `startApp`.\n\nIt reads better.',
      createdAt: '2026-10-01T10:00:00Z',
      url: 'https://github.com/acme/app/pull/12#discussion_r1'
    })
    // A deleted account reads as GitHub shows it; a non-https link is dropped.
    expect(open!.comments[2]).toMatchObject({ author: 'ghost', url: null })
    expect(resolved).toMatchObject({ isResolved: true, resolvedBy: 'carol', viewerCanUnresolve: true })
    expect(outdated).toMatchObject({ isOutdated: true, line: null, originalLine: 3, viewerCanReply: false })
  })

  it('normalizes backslash paths and diff side case', () => {
    const page = parseReviewThreadsPage(page2)!
    expect(page.threads[0]).toMatchObject({ path: 'src/renderer/view.tsx', diffSide: 'RIGHT' })
  })

  it('counts comments past the fetched 50 from totalCount', () => {
    const thread = mapReviewThread({
      id: 'PRRT_x',
      comments: { totalCount: 73, nodes: [{ id: 'c', author: { login: 'a' }, body: 'hi' }] }
    })
    expect(thread?.commentCount).toBe(73)
    expect(thread?.comments).toHaveLength(1)
  })

  it('reads a missing pull request as null and other GraphQL errors as errors', () => {
    expect(
      parseReviewThreadsPage(
        JSON.stringify({
          data: { repository: { pullRequest: null } },
          errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest with the number of 99.' }]
        })
      )
    ).toBeNull()
    expect(() =>
      parseReviewThreadsPage(JSON.stringify({ data: null, errors: [{ message: 'Something went wrong' }] }))
    ).toThrow(/Something went wrong/)
    expect(() => parseReviewThreadsPage('not json')).toThrow(/invalid review threads response/)
  })
})

describe('prReviewThreads', () => {
  beforeEach(() => {
    execFileAsync.mockReset()
    vi.mocked(existsSync).mockReturnValue(false)
    resetGhAvailableCacheForTests()
  })

  it('throws the shared message when gh is missing', async () => {
    execFileAsync.mockRejectedValue(new Error('not found'))
    await expect(prReviewThreads('/ws', 12)).rejects.toThrow(/GitHub CLI \(gh\) is not installed/)
  })

  it('pages through threads with gh api graphql and the repo placeholders', async () => {
    mockFs()
    const calls: string[][] = []
    routeExec((args) => {
      if (args[0] !== 'api') return undefined
      calls.push(args)
      return { stdout: graphqlField(args, 'after') ? page2 : page1 }
    })
    const result = await prReviewThreads('/ws', 12)
    expect(result).not.toBeNull()
    expect(result!.number).toBe(12)
    expect(result!.threads.map((t) => t.id)).toEqual([
      'PRRT_kwDOAbc123',
      'PRRT_kwDOAbc124',
      'PRRT_kwDOAbc125',
      'PRRT_kwDOAbc126'
    ])
    expect(result!.totalCount).toBe(4)
    expect(result!.truncated).toBe(false)
    expect(calls).toHaveLength(2)
    const first = calls[0]!
    expect(first.slice(0, 2)).toEqual(['api', 'graphql'])
    expect(first).toContain('owner={owner}')
    expect(first).toContain('name={repo}')
    expect(first).toContain('number=12')
    const query = graphqlField(first, 'query')!
    expect(query).toContain('reviewThreads(first: 100')
    expect(query).toContain('comments(first: 50)')
    expect(query).toContain('isResolved')
    expect(query).not.toContain('\n')
    expect(graphqlField(calls[1]!, 'after')).toBe('Y3Vyc29yOjM=')
  })

  it('stops after three pages and says the list is truncated', async () => {
    mockFs()
    let n = 0
    routeExec((args) => {
      if (args[0] !== 'api') return undefined
      n += 1
      return { stdout: page1.replace('"totalCount": 4', '"totalCount": 900') }
    })
    const result = await prReviewThreads('/ws', 12)
    expect(n).toBe(3)
    expect(result!.truncated).toBe(true)
    expect(result!.totalCount).toBe(900)
  })

  it('returns null when GitHub has no such pull request', async () => {
    mockFs()
    routeExec(() => ghError('gh: Could not resolve to a PullRequest with the number of 12.'))
    await expect(prReviewThreads('/ws', 12)).resolves.toBeNull()
  })

  it('passes auth failures through with gh’s own words first', async () => {
    mockFs()
    routeExec(() => ghError('gh: Bad credentials (HTTP 401)'))
    await expect(prReviewThreads('/ws', 12)).rejects.toThrow(/^gh: Bad credentials \(HTTP 401\)/)
  })

  it('rejects a bad pull request number before calling gh', async () => {
    mockFs()
    routeExec(() => undefined)
    await expect(prReviewThreads('/ws', 0)).rejects.toThrow(/Invalid pull request number/)
  })
})

describe('review thread mutations', () => {
  beforeEach(() => {
    execFileAsync.mockReset()
    vi.mocked(existsSync).mockReturnValue(false)
    resetGhAvailableCacheForTests()
    mockFs()
  })

  it('resolves and unresolves with the matching mutation', async () => {
    const seen: string[] = []
    routeExec((args) => {
      const query = graphqlField(args, 'query') ?? ''
      seen.push(query)
      expect(graphqlField(args, 'threadId')).toBe('PRRT_kwDOAbc123')
      return query.includes('unresolveReviewThread')
        ? { stdout: JSON.stringify({ data: { unresolveReviewThread: { thread: { id: 'PRRT_kwDOAbc123', isResolved: false } } } }) }
        : { stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'PRRT_kwDOAbc123', isResolved: true } } } }) }
    })
    await expect(prReviewThreadResolve('/ws', 'PRRT_kwDOAbc123', true)).resolves.toEqual({
      threadId: 'PRRT_kwDOAbc123',
      isResolved: true
    })
    await expect(prReviewThreadResolve('/ws', 'PRRT_kwDOAbc123', false)).resolves.toEqual({
      threadId: 'PRRT_kwDOAbc123',
      isResolved: false
    })
    expect(seen[0]).toMatch(/mutation\(\$threadId: ID!\) \{ resolveReviewThread/)
    expect(seen[1]).toContain('unresolveReviewThread')
  })

  it('refuses an id that is not a GraphQL node id', async () => {
    routeExec(() => undefined)
    await expect(prReviewThreadResolve('/ws', 'x; rm -rf /', true)).rejects.toThrow(/Invalid review thread id/)
  })

  it('replies with the body as a raw field and maps the new comment', async () => {
    routeExec((args) => {
      expect(args).toContain('body=Done in abc123')
      expect(graphqlField(args, 'query')).toContain('addPullRequestReviewThreadReply')
      return {
        stdout: JSON.stringify({
          data: {
            addPullRequestReviewThreadReply: {
              comment: {
                id: 'PRRC_9',
                author: { login: 'me' },
                body: 'Done in abc123',
                createdAt: '2026-10-02T00:00:00Z',
                url: 'https://github.com/acme/app/pull/12#discussion_r9'
              }
            }
          }
        })
      }
    })
    const res = await prReviewThreadReply('/ws', 'PRRT_kwDOAbc123', '  Done in abc123  ')
    expect(res.comment).toMatchObject({ id: 'PRRC_9', author: 'me', body: 'Done in abc123' })
  })

  it('refuses an empty reply', async () => {
    routeExec(() => undefined)
    await expect(prReviewThreadReply('/ws', 'PRRT_kwDOAbc123', '   ')).rejects.toThrow(/Reply cannot be empty/)
  })
})

describe('prList and prCheckout', () => {
  beforeEach(() => {
    execFileAsync.mockReset()
    vi.mocked(existsSync).mockReturnValue(false)
    resetGhAvailableCacheForTests()
    mockFs()
  })

  it('lists recent open pull requests', async () => {
    routeExec((args) => {
      if (args[0] !== 'pr' || args[1] !== 'list') return undefined
      expect(args).toEqual([
        'pr',
        'list',
        '--json',
        'number,title,headRefName,author,updatedAt,url,isDraft',
        '--limit',
        '20'
      ])
      return {
        stdout: JSON.stringify([
          {
            number: 7,
            title: 'Add thing',
            headRefName: 'feat/thing',
            author: { login: 'alice' },
            updatedAt: '2026-10-01T00:00:00Z',
            url: 'https://github.com/acme/app/pull/7',
            isDraft: true
          },
          { number: 0, title: 'bad' },
          { number: 8, title: 'No author', headRefName: 'fix/x', author: null }
        ])
      }
    })
    const res = await prList('/ws')
    expect(res.prs).toEqual([
      {
        number: 7,
        title: 'Add thing',
        headRefName: 'feat/thing',
        author: 'alice',
        updatedAt: '2026-10-01T00:00:00Z',
        url: 'https://github.com/acme/app/pull/7',
        isDraft: true
      },
      { number: 8, title: 'No author', headRefName: 'fix/x', author: 'ghost', updatedAt: null, url: null, isDraft: false }
    ])
  })

  it('refuses to check out over uncommitted tracked changes', async () => {
    const seen: string[][] = []
    routeExec((args) => {
      seen.push(args)
      if (args[0] === 'status') return { stdout: ' M src/a.ts\nM  src/b.ts\n' }
      return undefined
    })
    await expect(prCheckout('/ws', 7)).rejects.toThrow(/Commit or discard the 2 uncommitted changes before checking out pull request #7/)
    expect(seen.some((a) => a[0] === 'pr' && a[1] === 'checkout')).toBe(false)
    // Untracked files do not count: they survive a checkout.
    expect(seen.find((a) => a[0] === 'status')).toContain('--untracked-files=no')
  })

  it('checks out with gh under the repository-program guard', async () => {
    const envs: NodeJS.ProcessEnv[] = []
    execFileAsync.mockImplementation(
      async (_bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
        if (args[0] === '--version') return { stdout: 'gh version 2.60.0', stderr: '' }
        if (args[0] === 'status') return { stdout: '', stderr: '' }
        if (args[0] === 'pr' && args[1] === 'checkout') {
          expect(args).toEqual(['pr', 'checkout', '7'])
          envs.push(opts.env ?? {})
          return { stdout: '', stderr: "Switched to branch 'feat/thing'" }
        }
        if (args.includes('symbolic-ref')) return { stdout: 'feat/thing\n', stderr: '' }
        throw new Error(`unexpected call: ${args.join(' ')}`)
      }
    )
    await expect(prCheckout('/ws', 7)).resolves.toEqual({ detail: 'Checked out #7 on feat/thing' })
    expect(envs[0]).toMatchObject({ GH_PROMPT_DISABLED: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor' })
  })
})
