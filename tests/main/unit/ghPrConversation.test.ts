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
  prMerge,
  prReviewerSuggestions,
  prSetAutoMerge,
  prView
} from '@main/git/gh'

/** `gh pr view 63 --json …` on this repository, 2026-10-08 (gh 2.98): a closed PR with one bot comment. */
const REAL_PR_63 = JSON.parse(readFileSync(join(__dirname, '../../fixtures/github/pr-view-63-conversation.json'), 'utf8')) as Record<
  string,
  unknown
>
/** The conversation and auto-merge read for #63 (`gh api graphql`, PR_EXTRAS_QUERY, 2026-10-08) — this repository has auto-merge off. */
const REAL_PR_63_EXTRAS = readFileSync(join(__dirname, '../../fixtures/github/pr-63-extras-graphql.json'), 'utf8')
/** The same answer from a repository that allows auto-merge. */
const extrasAllowing = (can: boolean): string => {
  const data = JSON.parse(REAL_PR_63_EXTRAS) as { data: { repository: Record<string, unknown> & { pullRequest: Record<string, unknown> } } }
  data.data.repository.autoMergeAllowed = true
  data.data.repository.pullRequest.viewerCanEnableAutoMerge = can
  return JSON.stringify(data)
}
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

/**
 * A PR in a merge queue, as GitHub returned it for zed-industries/zed#65291
 * (2026-10-08): the read-back after a merge, and the conversation read.
 * `autoMergeRequest` is null for a queued PR, and gh's `pr view --json` has
 * no queue field at all.
 */
const REAL_QUEUED_MERGE_STATE = readFileSync(join(__dirname, '../../fixtures/github/zed-65291-queued-merge-state-graphql.json'), 'utf8')
const REAL_QUEUED_EXTRAS = readFileSync(join(__dirname, '../../fixtures/github/zed-65291-queued-extras-graphql.json'), 'utf8')

/** The merge read-back in the fixture's shape, with fields set for a case. */
function mergeState(pr: Record<string, unknown>): string {
  const data = JSON.parse(REAL_QUEUED_MERGE_STATE) as { data: { repository: { pullRequest: Record<string, unknown> } } }
  Object.assign(data.data.repository.pullRequest, pr)
  return JSON.stringify(data)
}
const NOT_QUEUED = { isMergeQueueEnabled: false, isInMergeQueue: false, mergeQueueEntry: null }

beforeEach(() => {
  ghRoute.mockReset()
  bodies.length = 0
})

describe('prView: the conversation and auto-merge', () => {
  it('reads the latest comments in one GraphQL call, not by paging `pr view --json comments`', async () => {
    ghRoute.mockImplementation((args) => (isGraphql(args) ? REAL_PR_63_EXTRAS : JSON.stringify(REAL_PR_63)))
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
    // Closed: auto-merge is not offered whatever GitHub says.
    expect(pr?.canAutoMerge).toBeUndefined()
    const viewArgs = ghRoute.mock.calls.find((call) => call[0][1] === 'view')![0].join(' ')
    expect(viewArgs).toMatch(/--json .*autoMergeRequest/)
    expect(viewArgs).not.toMatch(/comments/)
    const query = graphqlQuery(ghRoute.mock.calls.find((call) => isGraphql(call[0]))![0])
    expect(query).toContain('comments(last: 50)')
    expect(query).toContain('viewerCanEnableAutoMerge')
  })

  it('lists each requested reviewer once, though GitHub can list one twice', async () => {
    // `gh pr view 13251 -R cli/cli --json reviewRequests`, 2026-10-08: GraphQL returns the same request twice too.
    const twice = [
      { __typename: 'User', login: 'babakks' },
      { __typename: 'User', login: 'babakks' }
    ]
    ghRoute.mockImplementation((args) => (isGraphql(args) ? REAL_PR_63_EXTRAS : JSON.stringify({ ...REAL_PR_63, reviewRequests: twice })))
    expect((await prView('/repo', 63))?.reviewRequests).toEqual(['babakks'])
  })

  it('counts every comment when only the latest are read', async () => {
    const many = JSON.parse(REAL_PR_63_EXTRAS) as { data: { repository: { pullRequest: { comments: { totalCount: number } } } } }
    many.data.repository.pullRequest.comments.totalCount = 908
    ghRoute.mockImplementation((args) => (isGraphql(args) ? JSON.stringify(many) : JSON.stringify(REAL_PR_63)))
    expect((await prView('/repo', 63))?.commentCount).toBe(908)
  })

  it('maps auto-merge as gh reports it', async () => {
    ghRoute.mockImplementation((args) =>
      isGraphql(args) ? extrasAllowing(false) : JSON.stringify({ ...REAL_PR_63, state: 'OPEN', mergeStateStatus: 'BLOCKED', autoMergeRequest: REAL_AUTO_MERGE })
    )
    const pr = await prView('/repo', 63)
    expect(pr?.autoMerge).toEqual({ method: 'SQUASH', enabledBy: 'octocat' })
    // Already on: "Merge when ready" is not offered again.
    expect(pr?.canAutoMerge).toBeUndefined()
  })

  it('offers auto-merge only when GitHub says the viewer can enable it', async () => {
    const open = JSON.stringify({ ...REAL_PR_63, state: 'OPEN', mergeStateStatus: 'BLOCKED' })
    ghRoute.mockImplementation((args) => {
      if (isGraphql(args)) {
        expect(args).toContain('number=63')
        return extrasAllowing(true)
      }
      return open
    })
    expect((await prView('/repo', 63))?.canAutoMerge).toBe(true)
    ghRoute.mockImplementation((args) => (isGraphql(args) ? REAL_PR_63_EXTRAS : open))
    // This repository's real answer: auto-merge not allowed.
    expect((await prView('/repo', 63))?.canAutoMerge).toBe(false)
  })

  it('a draft is not offered auto-merge', async () => {
    ghRoute.mockImplementation((args) => (isGraphql(args) ? extrasAllowing(true) : JSON.stringify({ ...REAL_PR_63, state: 'OPEN', isDraft: true })))
    expect((await prView('/repo', 63))?.canAutoMerge).toBeUndefined()
  })

  it('a failed GraphQL read leaves the PR readable, without its conversation or the offer', async () => {
    ghRoute.mockImplementation((args) =>
      isGraphql(args) ? ghError('gh: Could not resolve to a Repository') : JSON.stringify({ ...REAL_PR_63, state: 'OPEN' })
    )
    const pr = await prView('/repo', 63)
    expect(pr?.number).toBe(63)
    expect(pr?.comments).toBeUndefined()
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
    // gh 2.98's export (api/export_pr.go): a user by login, a team by name and `org/slug`.
    ghRoute.mockImplementation((args) =>
      args[1] === 'view'
        ? JSON.stringify({ reviewRequests: [{ __typename: 'User', login: 'alice' }, { __typename: 'Team', name: 'Core', slug: 'org/core' }] })
        : ''
    )
    const result = await prEditReviewers('/repo', 5, ['alice', 'org/core'], ['bob'])
    expect(ghRoute.mock.calls[0]![0]).toEqual(['pr', 'edit', '5', '--add-reviewer', 'alice', '--add-reviewer', 'org/core', '--remove-reviewer', 'bob'])
    expect(result).toEqual({ detail: 'Reviewers updated', reviewRequests: ['alice', 'org/core'] })
  })

  it('says when GitHub does not list a request it took, as with Copilot', async () => {
    // gh exports no Bot entry, so a Copilot request never reads back.
    ghRoute.mockImplementation((args) => (args[1] === 'view' ? JSON.stringify({ reviewRequests: [] }) : ''))
    const result = await prEditReviewers('/repo', 5, ['@copilot'], [])
    expect(result.reviewRequests).toEqual([])
    expect(result.detail).toBe('Review requested from @copilot. GitHub does not list @copilot among the requests; see it on GitHub')
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
      isGraphql(args) ? mergeState({ ...NOT_QUEUED, autoMergeRequest: { ...REAL_AUTO_MERGE, mergeMethod: 'REBASE' } }) : ''
    )
    const result = await prSetAutoMerge('/repo', 4, true, 'rebase')
    expect(ghRoute.mock.calls[0]![0]).toEqual(['pr', 'merge', '4', '--auto', '--rebase', '--delete-branch=false'])
    expect(result).toEqual({
      detail: 'Auto-merge on: it will rebase and merge once its requirements are met',
      autoMerge: { method: 'REBASE', enabledBy: 'octocat' }
    })
  })

  it('turns it off', async () => {
    ghRoute.mockImplementation((args) => (isGraphql(args) ? mergeState(NOT_QUEUED) : ''))
    expect(await prSetAutoMerge('/repo', 4, false)).toEqual({ detail: 'Auto-merge off', autoMerge: null })
    expect(ghRoute.mock.calls[0]![0]).toEqual(['pr', 'merge', '4', '--disable-auto'])
  })

  it('says so when GitHub did not take it, rather than claiming it is on', async () => {
    ghRoute.mockImplementation((args) => (isGraphql(args) ? mergeState(NOT_QUEUED) : ''))
    await expect(prSetAutoMerge('/repo', 4, true)).rejects.toThrow('GitHub did not turn auto-merge on')
  })

  it('behind a merge queue, a PR GitHub queued at once is a success, not "did not turn auto-merge on"', async () => {
    ghRoute.mockImplementation((args) => (isGraphql(args) ? REAL_QUEUED_MERGE_STATE : ''))
    expect(await prSetAutoMerge('/repo', 65291, true)).toEqual({
      detail: "In the merge queue at position 1: GitHub merges it once the queue's checks pass",
      autoMerge: null
    })
    expect(graphqlQuery(ghRoute.mock.calls.find((call) => isGraphql(call[0]))![0])).toContain('isInMergeQueue')
  })

  it('behind a merge queue, a PR still waiting says it joins the queue, not how it will merge', async () => {
    ghRoute.mockImplementation((args) =>
      isGraphql(args) ? mergeState({ isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: REAL_AUTO_MERGE }) : ''
    )
    expect((await prSetAutoMerge('/repo', 4, true)).detail).toBe('Auto-merge on: it joins the merge queue once its requirements are met')
  })

  it("passes gh's refusal on", async () => {
    ghRoute.mockImplementation(() => ghError('GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)'))
    await expect(prSetAutoMerge('/repo', 4, true)).rejects.toThrow(/Auto merge is not allowed/)
  })
})

describe('merge queue', () => {
  it('prView says the base merges through a queue, and where the PR stands in it', async () => {
    ghRoute.mockImplementation((args) => (isGraphql(args) ? REAL_QUEUED_EXTRAS : JSON.stringify({ ...REAL_PR_63, state: 'OPEN' })))
    const pr = await prView('/repo', 65291)
    expect(pr?.mergeQueueRequired).toBe(true)
    expect(pr?.mergeQueue).toEqual({ position: 1 })
  })

  it('prView without a queue says so', async () => {
    ghRoute.mockImplementation((args) => (isGraphql(args) ? REAL_PR_63_EXTRAS : JSON.stringify(REAL_PR_63)))
    const pr = await prView('/repo', 63)
    expect(pr?.mergeQueueRequired).toBe(false)
    expect(pr?.mergeQueue).toBeNull()
  })

  it('prMerge behind a queue reports the PR queued, not merged', async () => {
    ghRoute.mockImplementation((args) => (isGraphql(args) ? REAL_QUEUED_MERGE_STATE : ''))
    expect(await prMerge('/repo', 'squash', 65291)).toEqual({
      detail: "In the merge queue at position 1: GitHub merges it once the queue's checks pass"
    })
    expect(ghRoute.mock.calls[0]![0]).toEqual(['pr', 'merge', '65291', '--squash', '--delete-branch=false'])
  })

  it('prMerge behind a queue, with checks still running, says it joins the queue later', async () => {
    ghRoute.mockImplementation((args) =>
      isGraphql(args) ? mergeState({ isInMergeQueue: false, mergeQueueEntry: null, autoMergeRequest: REAL_AUTO_MERGE }) : ''
    )
    expect((await prMerge('/repo', 'squash', 4)).detail).toBe('It joins the merge queue once its requirements are met')
  })

  it('prMerge reads back a real merge (gh prints nothing off a terminal)', async () => {
    ghRoute.mockImplementation((args) => (isGraphql(args) ? mergeState({ ...NOT_QUEUED, state: 'MERGED' }) : ''))
    expect(await prMerge('/repo', 'rebase', 4)).toEqual({ detail: 'Rebased and merged' })
  })

  it('prMerge does not claim a merge it could not read back', async () => {
    ghRoute.mockImplementation((args) => (isGraphql(args) ? ghError('HTTP 502: Bad Gateway') : ''))
    expect((await prMerge('/repo', 'squash', 4)).detail).toMatch(/^GitHub took the merge, but reading the pull request back failed: .*Refresh to see it\.$/)
  })
})
