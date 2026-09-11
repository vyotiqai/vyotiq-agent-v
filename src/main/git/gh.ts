import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import type { PrChangeType, PrCreateResult, PrReview, PrView } from '../../shared/ipc'
import { resolveGhTokenForCli, setupGithubGitAuth } from '@main/git/githubAuth'
import {
  ghAvailable,
  resetGhBinaryCacheForTests,
  resolveGhExecutable
} from './ghBinary'
import {
  addGitRemote,
  commitAll,
  commitEmpty,
  createBranch,
  currentGitBranch,
  hasGitCommits,
  hasGitRemote,
  isGitRepo,
  parseGitObjectId,
  pushCurrentBranch,
  sanitizeRelativePaths
} from './git'
import { sanitizedTerminalEnv } from '../agent/tools/terminal'

const execFile = promisify(execFileCb)

const TIMEOUT_MS = 30_000
const DIFF_TIMEOUT_MS = 60_000
const MERGE_TIMEOUT_MS = 120_000
const PR_CREATE_TIMEOUT_MS = 120_000
const MAX_BUFFER = 8 * 1024 * 1024
const DIFF_CAP_CHARS = 200_000

function capDiff(text: string): string {
  if (text.length <= DIFF_CAP_CHARS) return text
  return `${text.slice(0, DIFF_CAP_CHARS)}\n[diff truncated]`
}

function buildGhEnv(): NodeJS.ProcessEnv {
  const token = resolveGhTokenForCli()
  return {
    ...sanitizedTerminalEnv(),
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    ...(token ? { GH_TOKEN: token } : {})
  }
}

const GIT_ENV = {
  ...sanitizedTerminalEnv(),
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GCM_INTERACTIVE: 'never'
}

async function gh(args: string[], cwd: string, timeout = TIMEOUT_MS): Promise<string> {
  const executable = await resolveGhExecutable()
  if (!executable) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  const { stdout } = await execFile(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    env: buildGhEnv()
  })
  return stdout
}

async function git(args: string[], cwd: string, timeout = TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFile('git', args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    env: GIT_ENV
  })
  return stdout
}

export { ghAvailable }

/** @internal */
export function resetGhAvailableCacheForTests(): void {
  resetGhBinaryCacheForTests()
}

type GhReviewJson = {
  author?: { login?: string } | null
  state?: string
  body?: string
  submittedAt?: string | null
}

type GhPrJson = {
  number?: number
  title?: string
  url?: string
  state?: string
  baseRefName?: string
  headRefName?: string
  baseRefOid?: string
  headRefOid?: string
  body?: string
  additions?: number
  deletions?: number
  files?: Array<{
    path?: string
    additions?: number
    deletions?: number
    changeType?: string
  }>
  commits?: Array<{
    oid?: string
    messageHeadline?: string
    authors?: Array<{ name?: string; login?: string }>
  }>
  statusCheckRollup?: Array<{
    name?: string
    state?: string
    conclusion?: string | null
  }>
  reviews?: GhReviewJson[]
  latestReviews?: GhReviewJson[]
  reviewDecision?: string
  reviewRequests?: Array<{ login?: string } | string | null>
  isDraft?: boolean
}

function mapChangeType(raw: string | undefined): PrChangeType {
  switch ((raw ?? '').toUpperCase()) {
    case 'ADDED':
      return 'ADDED'
    case 'DELETED':
      return 'DELETED'
    case 'MODIFIED':
      return 'MODIFIED'
    case 'RENAMED':
      return 'RENAMED'
    case 'COPIED':
      return 'COPIED'
    case 'CHANGED':
      return 'CHANGED'
    default:
      return 'UNKNOWN'
  }
}

function mapReview(r: GhReviewJson): PrReview {
  return {
    author: r.author?.login ?? 'unknown',
    state: r.state ?? 'PENDING',
    body: r.body ?? '',
    submittedAt: r.submittedAt ?? null
  }
}

function mapReviewRequest(r: { login?: string } | string | null | undefined): string | null {
  if (!r) return null
  if (typeof r === 'string') return r || null
  return r.login || null
}

const PR_VIEW_JSON_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'baseRefName',
  'headRefName',
  'baseRefOid',
  'headRefOid',
  'body',
  'additions',
  'deletions',
  'files',
  'commits',
  'statusCheckRollup',
  'reviews',
  'latestReviews',
  'reviewDecision',
  'reviewRequests',
  'isDraft'
] as const

/** Older gh / reduced GraphQL surface when optional review fields are unsupported. */
const PR_VIEW_JSON_FIELDS_FALLBACK = [
  'number',
  'title',
  'url',
  'state',
  'baseRefName',
  'headRefName',
  'baseRefOid',
  'headRefOid',
  'body',
  'additions',
  'deletions',
  'files',
  'commits',
  'statusCheckRollup'
] as const

function execErrorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const withIo = err as Error & { stderr?: string; stdout?: string }
  return [err.message, withIo.stderr, withIo.stdout].filter(Boolean).join('\n')
}

/** Expected “no PR / no GitHub repo” outcomes — return null instead of failing IPC. */
function isExpectedPrAbsence(message: string): boolean {
  return /no pull requests found|no open pull requests|could not find a pull request|no pull request/i.test(
    message
  )
}

function isUnknownJsonFieldError(message: string): boolean {
  return /unknown json field|unknown field|is not a valid field/i.test(message)
}

function mapPrView(data: GhPrJson): PrView | null {
  if (typeof data.number !== 'number') return null
  return {
    number: data.number,
    title: data.title ?? '',
    url: data.url ?? '',
    state: data.state ?? 'OPEN',
    baseRefName: data.baseRefName ?? '',
    headRefName: data.headRefName ?? '',
    baseRefOid: data.baseRefOid ?? '',
    headRefOid: data.headRefOid ?? '',
    body: data.body ?? '',
    additions: data.additions ?? 0,
    deletions: data.deletions ?? 0,
    files: (data.files ?? []).map((f) => ({
      path: f.path ?? '',
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      changeType: mapChangeType(f.changeType)
    })),
    commits: (data.commits ?? []).map((c) => ({
      oid: c.oid ?? '',
      messageHeadline: c.messageHeadline ?? '',
      authors: (c.authors ?? [])
        .map((a) => a.name || a.login || '')
        .filter(Boolean)
    })),
    checks: (data.statusCheckRollup ?? []).map((c) => ({
      name: c.name ?? 'check',
      state: c.state ?? 'UNKNOWN',
      conclusion: c.conclusion ?? null
    })),
    reviews: (data.reviews ?? []).map(mapReview),
    latestReviews: (data.latestReviews ?? []).map(mapReview),
    reviewDecision: data.reviewDecision ?? '',
    reviewRequests: (data.reviewRequests ?? [])
      .map(mapReviewRequest)
      .filter((login): login is string => Boolean(login)),
    isDraft: data.isDraft === true
  }
}

/** Current branch PR, or null when none exists for this branch. Throws on gh/auth/network errors. */
export async function prView(cwd: string): Promise<PrView | null> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }

  const fetchJson = async (fields: readonly string[]): Promise<PrView | null> => {
    const raw = await gh(['pr', 'view', '--json', fields.join(',')], cwd)
    return mapPrView(JSON.parse(raw) as GhPrJson)
  }

  try {
    return await fetchJson(PR_VIEW_JSON_FIELDS)
  } catch (err) {
    const message = execErrorText(err)
    if (isExpectedPrAbsence(message)) return null
    if (isUnknownJsonFieldError(message)) {
      try {
        return await fetchJson(PR_VIEW_JSON_FIELDS_FALLBACK)
      } catch (fallbackErr) {
        const fallbackMessage = execErrorText(fallbackErr)
        if (isExpectedPrAbsence(fallbackMessage)) return null
        throw new Error(fallbackMessage)
      }
    }
    throw new Error(message)
  }
}

async function githubDefaultBranch(cwd: string): Promise<string> {
  const raw = await gh(['repo', 'view', '--json', 'defaultBranchRef'], cwd)
  let data: { defaultBranchRef?: { name?: unknown } | null }
  try {
    data = JSON.parse(raw) as { defaultBranchRef?: { name?: unknown } | null }
  } catch {
    throw new Error('GitHub CLI returned an invalid repository response')
  }
  const branch = data.defaultBranchRef?.name
  if (typeof branch !== 'string' || !branch.trim()) {
    throw new Error('GitHub repository default branch is unavailable')
  }
  return branch.trim()
}

type GithubRepositoryInfo = {
  nameWithOwner: string
  url: string
}

type GithubRemoteSetup = {
  created: boolean
  repository: string
}

function suggestedRepositoryName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const basename = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const slug = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
  return slug || 'vyotiq-project'
}

function isGithubRepositoryNotFound(message: string): boolean {
  return /HTTP 404|could not resolve to a repository|repository .*not found|repository .*does not exist/i.test(
    message
  )
}

async function githubRepository(cwd: string, name: string): Promise<GithubRepositoryInfo> {
  const raw = await gh(['repo', 'view', name, '--json', 'nameWithOwner,url'], cwd)
  let data: { nameWithOwner?: unknown; url?: unknown }
  try {
    data = JSON.parse(raw) as { nameWithOwner?: unknown; url?: unknown }
  } catch {
    throw new Error('GitHub CLI returned an invalid repository response')
  }
  if (typeof data.nameWithOwner !== 'string' || !data.nameWithOwner.trim()) {
    throw new Error('GitHub repository owner/name is unavailable')
  }
  if (typeof data.url !== 'string' || !data.url.trim()) {
    throw new Error('GitHub repository URL is unavailable')
  }
  return {
    nameWithOwner: data.nameWithOwner.trim(),
    url: data.url.trim()
  }
}

/** Connect an existing same-name repository or create a private one for this workspace. */
async function ensureGithubRemote(cwd: string): Promise<GithubRemoteSetup> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  if (await hasGitRemote(cwd)) return { created: false, repository: '' }

  const name = suggestedRepositoryName(cwd)
  let repository: GithubRepositoryInfo
  let created = false
  try {
    repository = await githubRepository(cwd, name)
  } catch (err) {
    const message = execErrorText(err)
    if (!isGithubRepositoryNotFound(message)) throw new Error(message)
    await gh(
      ['repo', 'create', name, '--private', '--source', cwd, '--remote', 'origin'],
      cwd,
      PR_CREATE_TIMEOUT_MS
    )
    repository = await githubRepository(cwd, name)
    created = true
  }

  await addGitRemote(cwd, repository.url)
  return { created, repository: repository.nameWithOwner }
}

async function prepareCreatedRepositoryBase(
  cwd: string,
  setup: GithubRemoteSetup,
  needsChangeCommit: boolean
): Promise<void> {
  if (!setup.created) return
  const branch = await currentGitBranch(cwd)
  if (!branch) throw new Error('Cannot create a GitHub repository from a detached HEAD')
  if (!(await hasGitCommits(cwd))) {
    if (!needsChangeCommit) {
      throw new Error('The new GitHub repository has no initial commit yet')
    }
    await commitEmpty(cwd, 'chore: initialize repository')
  }
  await pushCurrentBranch(cwd)
}

function pullRequestUrl(output: string): string {
  const match = output.match(/https:\/\/[^\s]+\/pull\/\d+/i)
  if (!match?.[0]) throw new Error('GitHub CLI did not return a pull request URL')
  return match[0].replace(/[),.;]+$/, '')
}

function generatedPrBranch(message: string): string {
  const slug = message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `vyotiq/${slug || 'changes'}-${Date.now().toString(36)}`
}

async function assertPrRepository(cwd: string): Promise<GithubRemoteSetup> {
  const setup = await ensureGithubRemote(cwd)
  await setupGithubGitAuth()
  return setup
}

async function createPrForBranch(
  cwd: string,
  branch: string,
  baseBranch: string,
  draft: boolean,
  setup: GithubRemoteSetup
): Promise<PrCreateResult> {
  const args = ['pr', 'create', '--base', baseBranch, '--head', branch, '--fill']
  if (draft) args.push('--draft')
  const output = await gh(args, cwd, PR_CREATE_TIMEOUT_MS)
  const url = pullRequestUrl(output)
  const detail = draft ? 'Draft pull request created' : 'Pull request created'
  return {
    url,
    branch,
    baseBranch,
    draft,
    detail: setup.created
      ? `Created private GitHub repository ${setup.repository}; ${detail}`
      : detail
  }
}

/** Push the current topic branch and create a draft/ready PR without prompts. */
export async function prCreate(
  cwd: string,
  opts: { draft?: boolean } = {}
): Promise<PrCreateResult> {
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  if (!(await hasGitCommits(cwd))) {
    throw new Error(
      'The repository has no initial commit yet. Commit changes first, then create a pull request.'
    )
  }
  const setup = await assertPrRepository(cwd)
  await prepareCreatedRepositoryBase(cwd, setup, false)
  const branch = await currentGitBranch(cwd)
  if (!branch) throw new Error('Cannot create a pull request from a detached HEAD')
  const baseBranch = await githubDefaultBranch(cwd)
  if (branch === baseBranch) {
    throw new Error(
      `Cannot create a pull request from the default branch "${baseBranch}" into itself. Use Commit & Create PR to create a topic branch.`
    )
  }
  const existing = await prView(cwd)
  if (existing) {
    throw new Error(`Pull request #${existing.number} already exists for branch "${branch}"`)
  }
  await pushCurrentBranch(cwd)
  return createPrForBranch(cwd, branch, baseBranch, opts.draft !== false, setup)
}

/** Commit selected changes, create a topic branch when needed, push, and create a PR. */
export async function prCreateFromChanges(
  cwd: string,
  message: string,
  mode: 'all' | 'staged' = 'all',
  opts: { draft?: boolean } = {}
): Promise<PrCreateResult> {
  const commitMessage = message.trim()
  if (!commitMessage) throw new Error('Commit message is required')
  const setup = await assertPrRepository(cwd)
  await prepareCreatedRepositoryBase(cwd, setup, true)

  const baseBranch = await githubDefaultBranch(cwd)
  let branch = await currentGitBranch(cwd)
  const originalBranch = branch
  // Captured only for detached HEAD, so switching back restores the exact commit.
  let originalHead: string | null = null
  let existing: PrView | null = null
  let createdBranch = false
  if (branch && branch !== baseBranch) existing = await prView(cwd)

  if (!branch || branch === baseBranch) {
    if (!branch) originalHead = (await git(['rev-parse', 'HEAD'], cwd)).trim()
    branch = generatedPrBranch(commitMessage)
    await createBranch(cwd, branch)
    createdBranch = true
  }

  const outcome = await commitAll(cwd, commitMessage, true, mode)
  if (!outcome.committed) {
    if (existing) {
      return {
        url: existing.url,
        branch,
        baseBranch: existing.baseRefName || baseBranch,
        draft: existing.isDraft,
        detail: 'Pull request already exists; there were no new changes to commit'
      }
    }
    if (createdBranch) {
      // The staged set emptied after we created the topic branch (e.g. a
      // concurrent commit). Never strand the user on an empty vyotiq/...
      // branch: switch back and delete it, then surface why nothing committed.
      try {
        const restore = originalBranch
          ? ['switch', originalBranch]
          : ['switch', '--detach', originalHead ?? 'HEAD']
        await git(restore, cwd)
        await git(['branch', '--delete', branch], cwd)
      } catch {
        // Best-effort cleanup; the primary failure below still applies.
      }
      throw new Error(outcome.detail)
    }
    await pushCurrentBranch(cwd)
    return createPrForBranch(cwd, branch, baseBranch, opts.draft !== false, setup)
  }
  if (!outcome.pushed) throw new Error(outcome.detail)
  if (existing) {
    return {
      url: existing.url,
      branch,
      baseBranch: existing.baseRefName || baseBranch,
      draft: existing.isDraft,
      detail: 'Committed and updated pull request'
    }
  }
  return createPrForBranch(cwd, branch, baseBranch, opts.draft !== false, setup)
}

function prNumberArg(number: number): string {
  if (!Number.isInteger(number) || number < 1) {
    throw new Error('Invalid pull request number')
  }
  return String(number)
}

function sanitizePrDiffPath(path: string | undefined): string | undefined {
  const requested = path?.trim()
  if (!requested) return undefined
  const clean = sanitizeRelativePaths([requested])[0]
  if (!clean) throw new Error('Invalid path')
  return clean
}

async function ghPrPatch(cwd: string, number: string, path?: string): Promise<string> {
  let out = await gh(['pr', 'diff', number, '--patch', '--color=never'], cwd, DIFF_TIMEOUT_MS)
  if (path) out = extractFilePatch(out, path)
  return capDiff(out)
}

export async function prDiff(
  cwd: string,
  opts: { number: number; path?: string; ignoreWhitespace?: boolean }
): Promise<{ content: string }> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }

  const number = prNumberArg(opts.number)
  const path = sanitizePrDiffPath(opts.path)

  let baseOid: string | null = null
  let headOid: string | null = null
  try {
    const raw = await gh(['pr', 'view', number, '--json', 'baseRefOid,headRefOid'], cwd)
    const data = JSON.parse(raw) as { baseRefOid?: string; headRefOid?: string }
    baseOid = parseGitObjectId(data.baseRefOid)
    headOid = parseGitObjectId(data.headRefOid)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(message)
  }

  if (!baseOid || !headOid) {
    return { content: await ghPrPatch(cwd, number, path) }
  }

  const args = ['diff', '--no-color', '--no-ext-diff', '--binary']
  if (opts.ignoreWhitespace) args.push('--ignore-all-space')
  args.push('--end-of-options', `${baseOid}...${headOid}`)
  if (path) args.push('--', path)

  try {
    const content = await git(args, cwd, DIFF_TIMEOUT_MS)
    return { content: capDiff(content) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    try {
      return { content: await ghPrPatch(cwd, number, path) }
    } catch {
      throw new Error(message)
    }
  }
}

function unquoteGitPath(raw: string): string {
  const t = raw.trim()
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  return t
}

function diffGitPaths(line: string): { a: string; b: string } | null {
  if (!line.startsWith('diff --git ')) return null
  const rest = line.slice('diff --git '.length)
  const quoted = rest.match(/^"a\/(.+)" "b\/(.+)"$/)
  if (quoted?.[1] && quoted[2]) {
    return { a: unquoteGitPath(quoted[1]), b: unquoteGitPath(quoted[2]) }
  }
  const sep = rest.indexOf(' b/')
  if (sep === -1) return null
  const aRaw = rest.slice(0, sep)
  const bRaw = rest.slice(sep + 1)
  const a = unquoteGitPath(aRaw.startsWith('a/') ? aRaw.slice(2) : aRaw)
  const b = unquoteGitPath(bRaw.startsWith('b/') ? bRaw.slice(2) : bRaw)
  return { a, b }
}

/** Keep only the unified-diff hunks for one path from a multi-file patch. */
export function extractFilePatch(patch: string, path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const lines = patch.split(/\r?\n/)
  const out: string[] = []
  let include = false
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const paths = diffGitPaths(line)
      include = Boolean(paths && (paths.a === normalized || paths.b === normalized))
    }
    if (include) out.push(line)
  }
  return out.join('\n')
}

export async function prMerge(
  cwd: string,
  method: 'squash' | 'merge' | 'rebase',
  number: number
): Promise<{ detail: string }> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  const flag =
    method === 'squash' ? '--squash' : method === 'rebase' ? '--rebase' : '--merge'
  try {
    const out = await gh(
      ['pr', 'merge', prNumberArg(number), flag, '--delete-branch=false'],
      cwd,
      MERGE_TIMEOUT_MS
    )
    return { detail: out.trim() || `Merged with ${method}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(message)
  }
}

export async function prClose(cwd: string, number: number): Promise<{ detail: string }> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  try {
    const out = await gh(['pr', 'close', prNumberArg(number)], cwd, TIMEOUT_MS)
    return { detail: out.trim() || 'Pull request closed' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(message)
  }
}

export async function prEditTitle(
  cwd: string,
  title: string,
  number: number
): Promise<{ title: string }> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  const trimmed = title.trim()
  if (!trimmed) throw new Error('Title cannot be empty')
  try {
    await gh(['pr', 'edit', prNumberArg(number), '--title', trimmed], cwd, TIMEOUT_MS)
    return { title: trimmed }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(message)
  }
}

export async function reviewPullRequest(
  cwd: string,
  event: 'approve' | 'request-changes' | 'comment',
  body?: string,
  number?: number
): Promise<{ detail: string }> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  const args = ['pr', 'review']
  if (number) args.push(prNumberArg(number))
  if (event === 'approve') args.push('--approve')
  else if (event === 'request-changes') args.push('--request-changes')
  else args.push('--comment')
  const text = body?.trim()
  if (text) args.push('--body', text)
  else if (event !== 'approve') args.push('--body', event === 'request-changes' ? 'Requested changes' : 'Comment')
  await gh(args, cwd, TIMEOUT_MS)
  return { detail: 'Review submitted' }
}

export async function listGithubIssues(
  cwd: string
): Promise<{ issues: Array<{ number: number; title: string; url: string; state: string }> }> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  const raw = await gh(
    ['issue', 'list', '--json', 'number,title,url,state', '--limit', '30'],
    cwd,
    TIMEOUT_MS
  )
  const parsed = JSON.parse(raw) as Array<{
    number?: number
    title?: string
    url?: string
    state?: string
  }>
  return {
    issues: parsed
      .filter((row) => typeof row.number === 'number' && row.number > 0)
      .map((row) => ({
        number: row.number!,
        title: row.title ?? '',
        url: row.url ?? '',
        state: row.state ?? ''
      }))
  }
}

export async function createGithubIssue(
  cwd: string,
  title: string,
  body?: string
): Promise<{ url: string; detail: string }> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  const trimmed = title.trim()
  if (!trimmed) throw new Error('Title cannot be empty')
  const args = ['issue', 'create', '--title', trimmed]
  if (body?.trim()) args.push('--body', body.trim())
  const output = (await gh(args, cwd, TIMEOUT_MS)).trim()
  return { url: output, detail: 'Issue created' }
}
