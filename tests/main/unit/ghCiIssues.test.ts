import { readFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * gh is answered by a router keyed on its arguments, so each test says what
 * GitHub returned rather than the order the code happens to ask in.
 */
const { ghRoute } = vi.hoisted(() => ({
  ghRoute: vi.fn<(args: string[]) => string | Error>()
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
  const fake = Object.assign(
    (..._args: unknown[]) => {
      throw new Error('callback execFile is not used by gh.ts')
    },
    {
      [util.promisify.custom]: async (bin: string, args: string[]) => {
        if (bin !== 'gh-fake') throw new Error(`unexpected binary ${bin} ${args.join(' ')}`)
        const answer = ghRoute(args)
        if (answer instanceof Error) throw answer
        return { stdout: answer, stderr: '' }
      }
    }
  )
  return { ...actual, execFile: fake }
})

import {
  extractFailedStepLog,
  mapGithubIssue,
  parseActionsJobUrl,
  prCheckLog,
  prCheckRerun,
  viewGithubIssue
} from '@main/git/gh'

/** Lines of a real `gh run view --job 111444405036 --log-failed` (gh 2.98, 2026-10-04). */
const REAL_LOG = readFileSync(join(__dirname, '../../fixtures/github/run-view-log-failed.txt'), 'utf8')
/** The same job read from the jobs API (`gh api …/actions/jobs/111444405036/logs`, gh 2.98, 2026-10-08): its head and failing step. */
const REAL_API_LOG = readFileSync(join(__dirname, '../../fixtures/github/job-log-api.txt'), 'utf8')
const JOB_URL = 'https://github.com/vyotiqai/vyotiq-agent-v/actions/runs/37205055756/job/111444405036'
const JOB = { host: 'github.com', owner: 'vyotiqai', repo: 'vyotiq-agent-v', runId: '37205055756', jobId: '111444405036' }
const JOB_LOG_ARGS = 'api --allow-escape-sequences repos/vyotiqai/vyotiq-agent-v/actions/jobs/111444405036/logs'

function ghError(stderr: string): Error {
  return Object.assign(new Error(`Command failed: gh\n${stderr}`), { stderr, code: 1 })
}

beforeEach(() => {
  ghRoute.mockReset()
})

describe('parseActionsJobUrl', () => {
  it('reads the run and job ids from a check link GitHub reported', () => {
    expect(parseActionsJobUrl(JOB_URL)).toEqual(JOB)
    expect(parseActionsJobUrl(`${JOB_URL}?pr=64`)).toEqual(JOB)
    expect(parseActionsJobUrl('https://ghe.example.com/team/app/actions/runs/1/job/2')).toMatchObject({ host: 'ghe.example.com', owner: 'team', repo: 'app' })
  })

  it('refuses links that are not an Actions job', () => {
    // A third-party check from the same rollup (real detailsUrl shape).
    expect(parseActionsJobUrl('https://cursor.com/agents/bc-465f9607-4f14-4ed2-a451-85e100cb59c6')).toBeNull()
    // `/jobs/<n>` is the browser's numbering, which `gh run rerun --job` does not take.
    expect(parseActionsJobUrl('https://github.com/o/r/actions/runs/1/jobs/2')).toBeNull()
    expect(parseActionsJobUrl('http://github.com/o/r/actions/runs/1/job/2')).toBeNull()
    expect(parseActionsJobUrl(null)).toBeNull()
  })
})

describe('extractFailedStepLog', () => {
  it('keeps the failing step of a real job log, without timestamps, prefixes or colour codes', () => {
    const result = extractFailedStepLog(REAL_LOG)
    expect(result.foundError).toBe(true)
    expect(result.step).toBe('node scripts/typecheck-tests-ratchet.mjs')
    expect(result.truncated).toBe(false)
    expect(result.excerpt.split('\n')).toEqual([
      'tsconfig.tests-node.json: 1 file(s) gained type errors:',
      '  tests/main/unit/editTools.test.ts: 2 (was 1)',
      "    tests/main/unit/editTools.test.ts(60,7): error TS2322: Type 'Buffer<ArrayBufferLike>' is not assignable to type 'string | NonSharedBuffer'.",
      '    tests/main/unit/editTools.test.ts(60,40): error TS2769: No overload matches this call.',
      'tsconfig.tests-web.json: 138 errors, none new — down from 139; run with --update to lock that in',
      'tsconfig.tests-e2e.json: 14 errors, none new — down from 16; run with --update to lock that in',
      'Error: Process completed with exit code 1.'
    ])
    expect(result.excerpt).not.toMatch(/UNKNOWN STEP|\d{4}-\d{2}-\d{2}T|\^\[\[|\uFEFF/)
  })

  it('reads the jobs API log (no job and step columns) to the same excerpt', () => {
    const api = extractFailedStepLog(REAL_API_LOG)
    expect(api).toEqual(extractFailedStepLog(REAL_LOG))
    // A tab in a line's own text is not taken for the job and step columns.
    expect(extractFailedStepLog('2026-10-04T13:16:57.1Z a\tb\tc').excerpt).toBe('a\tb\tc')
  })

  it('reads CRLF output the same way', () => {
    expect(extractFailedStepLog(REAL_LOG.replace(/\r?\n/g, '\r\n'))).toEqual(extractFailedStepLog(REAL_LOG))
  })

  it('falls back to the tail when no line is an error', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `job\tUNKNOWN STEP\t2026-10-04T13:16:57.1Z line ${i}`)
    const result = extractFailedStepLog(lines.join('\n'))
    expect(result.foundError).toBe(false)
    expect(result.step).toBeNull()
    expect(result.excerpt.split('\n')).toHaveLength(60)
    expect(result.excerpt.endsWith('line 99')).toBe(true)
  })

  it('caps a long step from the front so the error itself is kept', () => {
    const body = Array.from({ length: 400 }, (_, i) => `j\ts\t2026-10-04T13:16:57.1Z out ${i}`)
    const raw = ['j\ts\t2026-10-04T13:16:57.1Z ##[group]Run make', 'j\ts\t2026-10-04T13:16:57.1Z ##[endgroup]', ...body, 'j\ts\t2026-10-04T13:16:57.1Z ##[error]boom'].join('\n')
    const result = extractFailedStepLog(raw)
    expect(result.truncated).toBe(true)
    expect(result.step).toBe('make')
    expect(result.excerpt.endsWith('Error: boom')).toBe(true)
    expect(result.excerpt.split('\n').length).toBeLessThanOrEqual(150)
  })
})

describe('prCheckLog', () => {
  it("reads the job's own log from the jobs API, for the repository in the link", async () => {
    // Not `gh run view --job --log-failed`: that waits for the whole run and reads its latest attempt.
    ghRoute.mockImplementation((args) => (args.join(' ') === JOB_LOG_ARGS ? REAL_API_LOG : ghError(`unexpected ${args.join(' ')}`)))
    const result = await prCheckLog('/ws', JOB_URL)
    expect(result.step).toBe('node scripts/typecheck-tests-ratchet.mjs')
    expect(result.foundError).toBe(true)
  })

  it('asks the GitHub Enterprise host a check links to', async () => {
    ghRoute.mockImplementation(() => '2026-10-04T13:16:57.1Z all good')
    const result = await prCheckLog('/ws', 'https://ghe.example.com/team/app/actions/runs/1/job/2')
    expect(ghRoute.mock.calls[0]![0]).toEqual(['api', '--hostname', 'ghe.example.com', '--allow-escape-sequences', 'repos/team/app/actions/jobs/2/logs'])
    expect(result).toMatchObject({ foundError: false, excerpt: 'all good' })
  })

  it('refuses a check that is not an Actions job without calling gh', async () => {
    await expect(prCheckLog('/ws', 'https://cursor.com/agents/x')).rejects.toThrow(/Only a GitHub Actions check/)
    expect(ghRoute).not.toHaveBeenCalled()
  })

  it("says what gh said when the log can't be read", async () => {
    ghRoute.mockReturnValue(ghError('job is still in progress; logs will be available when it is complete'))
    await expect(prCheckLog('/ws', JOB_URL)).rejects.toThrow(/still in progress/)
  })
})

describe('prCheckRerun', () => {
  const jobs = JSON.stringify({
    jobs: [
      { databaseId: 111444404993, name: 'windows-latest', url: 'https://github.com/vyotiqai/vyotiq-agent-v/actions/runs/37205055756/job/111444404993' },
      { databaseId: 111444405036, name: 'ubuntu-latest', url: JOB_URL }
    ]
  })

  it("re-runs the link's job by its databaseId once the run lists it", async () => {
    const calls: string[] = []
    ghRoute.mockImplementation((args) => {
      calls.push(args.join(' '))
      return args[1] === 'view' ? jobs : ''
    })
    await expect(prCheckRerun('/ws', JOB_URL)).resolves.toEqual({ detail: 'Re-running ubuntu-latest' })
    expect(calls).toEqual(['run view 37205055756 --json jobs', 'run rerun 37205055756 --job 111444405036'])
  })

  it('refuses a job the run does not have, and re-runs nothing', async () => {
    const calls: string[] = []
    ghRoute.mockImplementation((args) => {
      calls.push(args.join(' '))
      return args[1] === 'view' ? JSON.stringify({ jobs: [] }) : ''
    })
    await expect(prCheckRerun('/ws', JOB_URL)).rejects.toThrow(/has no job 111444405036/)
    expect(calls.some((c) => c.startsWith('run rerun'))).toBe(false)
  })
})

describe('viewGithubIssue', () => {
  it('maps gh issue JSON, keeping the latest comments and counting all of them', async () => {
    const comments = Array.from({ length: 25 }, (_, i) => ({ author: { login: `u${i}` }, body: `c${i}`, createdAt: '2026-10-01T00:00:00Z' }))
    ghRoute.mockImplementation((args) =>
      args.slice(0, 3).join(' ') === 'issue view 12'
        ? JSON.stringify({
            number: 12,
            title: 'Crash on start',
            body: 'Steps…',
            state: 'OPEN',
            url: 'https://github.com/o/r/issues/12',
            author: { login: 'ada' },
            labels: [{ name: 'bug' }, { name: '' }],
            createdAt: '2026-09-30T00:00:00Z',
            comments
          })
        : ghError('unexpected')
    )
    const issue = await viewGithubIssue('/ws', 12)
    expect(issue).toMatchObject({ number: 12, title: 'Crash on start', author: 'ada', labels: ['bug'], commentCount: 25 })
    expect(issue.comments).toHaveLength(20)
    expect(issue.comments[0]!.author).toBe('u5')
    expect(issue.comments[19]!.author).toBe('u24')
  })

  it('says what gh said for an issue that does not exist', async () => {
    ghRoute.mockReturnValue(ghError('GraphQL: Could not resolve to an issue or pull request with the number of 999.'))
    await expect(viewGithubIssue('/ws', 999)).rejects.toThrow(/Could not resolve to an issue/)
  })

  it('maps a deleted author and caps a huge body', () => {
    const issue = mapGithubIssue({ number: 3, title: 't', body: 'x'.repeat(30_000), author: null, comments: null })
    expect(issue?.author).toBe('ghost')
    expect(issue!.body.length).toBeLessThan(20_100)
    expect(issue!.body).toMatch(/cut at 20000 characters/)
    expect(mapGithubIssue({ title: 'no number' })).toBeNull()
  })
})
