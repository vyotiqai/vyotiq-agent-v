import { readFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * gh is answered by a router keyed on its arguments. A `--body-file` is read
 * while gh "runs", so each test sees the exact text that would reach GitHub.
 */
const { ghRoute, bodies } = vi.hoisted(() => ({
  ghRoute: vi.fn<(args: string[]) => string | Error>(),
  bodies: [] as string[]
}))

vi.mock('@main/git/ghBinary', () => ({
  ghAvailable: async () => true,
  resolveGhExecutable: async () => 'gh-fake',
  resetGhBinaryCacheForTests: () => undefined
}))

vi.mock('@main/git/githubAuth', () => ({
  resolveGhTokenForCli: () => undefined,
  setupGithubGitAuth: async () => undefined
}))

vi.mock('@main/git/repoCommandGuard', () => ({
  guardGitInvocation: async (args: string[], _cwd: string, env: NodeJS.ProcessEnv) => ({ args, env })
}))

vi.mock('@main/agent/tools/terminal', () => ({
  commandOnPath: vi.fn(() => false),
  invalidateCommandOnPathCache: vi.fn(),
  sanitizedTerminalEnv: vi.fn(() => ({ PATH: process.env.PATH ?? '' }))
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const util = await import('util')
  const fs = await import('fs')
  const fake = Object.assign(
    (..._args: unknown[]) => {
      throw new Error('callback execFile is not used by gh.ts')
    },
    {
      [util.promisify.custom]: async (bin: string, args: string[]) => {
        if (bin !== 'gh-fake') throw new Error(`unexpected binary ${bin} ${args.join(' ')}`)
        const fileAt = args.indexOf('--body-file')
        if (fileAt >= 0) bodies.push(fs.readFileSync(args[fileAt + 1]!, 'utf8'))
        const answer = ghRoute(args)
        if (answer instanceof Error) throw answer
        return { stdout: answer, stderr: '' }
      }
    }
  )
  return { ...actual, execFile: fake }
})

import {
  prComment,
  prEditBody,
  prEditReviewers,
  prReviewerSuggestions,
  prSetAutoMerge,
  prView,
  resetAutoMergeCacheForTests
} from '@main/git/gh'

/** `gh pr view 63 --json …` on this repository, 2026-10-08 (gh 2.98): a closed PR with one bot comment. */
const REAL_PR_63 = JSON.parse(readFileSync(join(__dirname, '../../fixtures/github/pr-view-63-conversation.json'), 'utf8')) as Record<
  string,
  unknown
>
/**
 * `autoMergeRequest` as gh 2.98 returned it for an open PR with auto-merge on
 * (microsoft/vscode#340326, 2026-10-08); the person's name and email are
 * replaced, the shape is as returned.
 */
const REAL_AUTO_MERGE = {
  authorEmail: 'someone@example.com',
  commitBody: '* a change\n\nFixes #1',
  commitHeadline: 'a change (#2)',
  mergeMethod: 'SQUASH',
  enabledAt: '2026-10-07T16:50:07Z',
  enabledBy: { id: 'MDQ6VXNlcjE=', is_bot: false, login: 'octocat', name: 'The Octocat' }
}

function ghError(stderr: string): Error {
  return Object.assign(new Error(`Command failed: gh\n${stderr}`), { stderr, code: 1 })
}

const isGraphql = (args: string[]): boolean => args[0] === 'api' && args[1] === 'graphql'
const graphqlQuery = (args: string[]): string => args[args.indexOf('-f') + 1] ?? ''

beforeEach(() => {
  ghRoute.mockReset()
  bodies.length = 0
  resetAutoMergeCacheForTests()
})

describe('prView: the conversation and auto-merge', () => {
  it('maps the real comment shape and leaves auto-merge off; a closed PR asks GitHub nothing more', async () => {
    ghRoute.mockImplementation((args) => (args[0] === 'pr' && args[1] === 'view' ? JSON.stringify(REAL_PR_63) : new Error(`unexpected ${args.join(' ')}`)))
    const pr = await prView('/repo', 63)
    expect(pr?.comments).toEqual([
      {
        author: 'dependabot',
        body: 'Looks like @lezer/highlight is updatable in another way, so this is no longer needed.',
        createdAt: '2026-10-04T13:16:09Z',
        url: 'https://github.com/vyotiqai/vyotiq-agent-v/pull/63#issuecomment-5980353356',
        minimized: false
      }
    ])
    expect(pr?.commentCount).toBe(1)
    expect(pr?.autoMerge).toBeNull()
    expect(pr?.canAutoMerge).toBeUndefined()
    expect(ghRoute).toHaveBeenCalledTimes(1)
    // The two fields ride the one `pr view` call.
    expect(ghRoute.mock.calls[0]![0].join(' ')).toMatch(/--json .*comments,autoMergeRequest/)
  })

  it('maps auto-merge as gh reports it', async () => {
    ghRoute.mockImplementation(() => JSON.stringify({ ...REAL_PR_63, state: 'OPEN', mergeStateStatus: 'BLOCKED', autoMergeRequest: REAL_AUTO_MERGE }))
    const pr = await prView('/repo', 63)
    expect(pr?.autoMerge).toEqual({ method: 'SQUASH', enabledBy: 'octocat' })
    // Already on: nothing more to ask.
    expect(ghRoute).toHaveBeenCalledTimes(1)
  })

  it('offers auto-merge only when GitHub says the viewer can enable it', async () => {
    const open = { ...REAL_PR_63, state: 'OPEN', mergeStateStatus: 'BLOCKED' }
    ghRoute.mockImplementation((args) => {
      if (isGraphql(args)) {
        expect(graphqlQuery(args)).toContain('viewerCanEnableAutoMerge')
        expect(args).toContain('number=63')
        return JSON.stringify({ data: { repository: { autoMergeAllowed: true, pullRequest: { viewerCanEnableAutoMerge: true } } } })
      }
      return JSON.stringify(open)
    })
    expect((await prView('/repo', 63))?.canAutoMerge).toBe(true)
  })

  it('a repository that does not allow auto-merge is asked once, not on every poll', async () => {
    const open = { ...REAL_PR_63, state: 'OPEN', mergeStateStatus: 'BLOCKED' }
    let graphqlCalls = 0
    ghRoute.mockImplementation((args) => {
      if (isGraphql(args)) {
        graphqlCalls += 1
        // What GitHub answered for this repository on 2026-10-08.
        return JSON.stringify({ data: { repository: { autoMergeAllowed: false, pullRequest: { viewerCanEnableAutoMerge: false } } } })
      }
      return JSON.stringify(open)
    })
    expect((await prView('/repo', 63))?.canAutoMerge).toBe(false)
    expect((await prView('/repo', 63))?.canAutoMerge).toBe(false)
    expect(graphqlCalls).toBe(1)
  })

  it('a failed auto-merge question leaves the PR readable and the offer absent', async () => {
    ghRoute.mockImplementation((args) =>
      isGraphql(args) ? ghError('gh: Could not resolve to a Repository') : JSON.stringify({ ...REAL_PR_63, state: 'OPEN' })
    )
    const pr = await prView('/repo', 63)
    expect(pr?.number).toBe(63)
    expect(pr?.canAutoMerge).toBeUndefined()
  })
})

describe('prComment', () => {
  it('posts the text through a file and returns the comment link gh printed', async () => {
    ghRoute.mockImplementation(() => 'https://github.com/o/r/pull/7#issuecomment-123\n')
    const result = await prComment('/repo', 7, '  Looks good — one question below.\n\n```ts\nconst a = 1\n```  ')
    expect(result).toEqual({ detail: 'Comment posted', url: 'https://github.com/o/r/pull/7#issuecomment-123' })
    const args = ghRoute.mock.calls[0]![0]
    expect(args.slice(0, 3)).toEqual(['pr', 'comment', '7'])
    expect(bodies).toEqual(['Looks good — one question below.\n\n```ts\nconst a = 1\n```'])
  })

  it('refuses an empty comment without calling gh', async () => {
    await expect(prComment('/repo', 7, '   \n ')).rejects.toThrow('Comment cannot be empty')
    expect(ghRoute).not.toHaveBeenCalled()
  })
})

describe('prEditBody', () => {
  it('writes the new description when GitHub still has the one editing began from', async () => {
    ghRoute.mockImplementation((args) => (args[1] === 'view' ? JSON.stringify({ body: 'Old line\r\nsecond' }) : ''))
    // GitHub hands back CRLF bodies; the panel compares them as text.
    expect(await prEditBody('/repo', 9, 'New body', 'Old line\nsecond')).toEqual({ body: 'New body' })
    expect(ghRoute.mock.calls.map((c) => c[0].slice(0, 3).join(' '))).toEqual(['pr view 9', 'pr edit 9'])
    expect(bodies).toEqual(['New body'])
  })

  it('refuses, writing nothing, when someone changed it on GitHub meanwhile', async () => {
    ghRoute.mockImplementation((args) => (args[1] === 'view' ? JSON.stringify({ body: 'Edited on github.com' }) : ''))
    await expect(prEditBody('/repo', 9, 'Mine', 'Old')).rejects.toThrow(/changed on GitHub after you started editing/)
    expect(ghRoute).toHaveBeenCalledTimes(1)
    expect(bodies).toEqual([])
  })

  it('an unchanged description is not written', async () => {
    ghRoute.mockImplementation(() => JSON.stringify({ body: 'Same' }))
    expect(await prEditBody('/repo', 9, 'Same', 'Same')).toEqual({ body: 'Same' })
    expect(ghRoute).toHaveBeenCalledTimes(1)
  })
})

describe('prEditReviewers', () => {
  it('requests and withdraws in one edit, then reads back who is requested', async () => {
    ghRoute.mockImplementation((args) =>
      args[1] === 'view' ? JSON.stringify({ reviewRequests: [{ __typename: 'User', login: 'alice' }, { __typename: 'Team', login: 'org/core' }] }) : ''
    )
    const result = await prEditReviewers('/repo', 5, ['alice', 'org/core'], ['bob'])
    expect(ghRoute.mock.calls[0]![0]).toEqual(['pr', 'edit', '5', '--add-reviewer', 'alice', '--add-reviewer', 'org/core', '--remove-reviewer', 'bob'])
    expect(result).toEqual({ detail: 'Reviewers updated', reviewRequests: ['alice', 'org/core'] })
  })

  it("passes gh's refusal on", async () => {
    ghRoute.mockImplementation(() => ghError("GraphQL: Could not resolve to a User with the login of 'nobody'. (u0)"))
    await expect(prEditReviewers('/repo', 5, ['nobody'], [])).rejects.toThrow(/Could not resolve to a User/)
  })
})

describe('prReviewerSuggestions', () => {
  it("lists the repository's assignable users, sorted and once each", async () => {
    ghRoute.mockImplementation(() =>
      JSON.stringify({ data: { repository: { assignableUsers: { nodes: [{ login: 'zed' }, { login: 'amy' }, null, { login: 'amy' }] } } } })
    )
    expect(await prReviewerSuggestions('/repo')).toEqual({ logins: ['amy', 'zed'] })
    expect(graphqlQuery(ghRoute.mock.calls[0]![0])).toContain('assignableUsers(first: 100)')
  })
})

describe('prSetAutoMerge', () => {
  it('turns it on by the method asked and reads back what GitHub set', async () => {
    ghRoute.mockImplementation((args) =>
      args[1] === 'view' ? JSON.stringify({ state: 'OPEN', autoMergeRequest: { ...REAL_AUTO_MERGE, mergeMethod: 'REBASE' } }) : ''
    )
    const result = await prSetAutoMerge('/repo', 4, true, 'rebase')
    expect(ghRoute.mock.calls[0]![0]).toEqual(['pr', 'merge', '4', '--auto', '--rebase', '--delete-branch=false'])
    expect(result).toEqual({
      detail: 'Auto-merge on: it will rebase and merge once its requirements are met',
      autoMerge: { method: 'REBASE', enabledBy: 'octocat' }
    })
  })

  it('turns it off', async () => {
    ghRoute.mockImplementation((args) => (args[1] === 'view' ? JSON.stringify({ state: 'OPEN', autoMergeRequest: null }) : ''))
    expect(await prSetAutoMerge('/repo', 4, false)).toEqual({ detail: 'Auto-merge off', autoMerge: null })
    expect(ghRoute.mock.calls[0]![0]).toEqual(['pr', 'merge', '4', '--disable-auto'])
  })

  it('says so when GitHub did not take it, rather than claiming it is on', async () => {
    ghRoute.mockImplementation((args) => (args[1] === 'view' ? JSON.stringify({ state: 'OPEN', autoMergeRequest: null }) : ''))
    await expect(prSetAutoMerge('/repo', 4, true)).rejects.toThrow('GitHub did not turn auto-merge on')
  })

  it("passes gh's refusal on", async () => {
    ghRoute.mockImplementation(() => ghError('GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)'))
    await expect(prSetAutoMerge('/repo', 4, true)).rejects.toThrow(/Auto merge is not allowed/)
  })
})
