import { execFile as execFileCb } from 'child_process'
import { randomUUID } from 'crypto'
import { unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type {
  GithubIssueDetail,
  PrAutoMerge,
  PrAutoMergeResult,
  PrChangeType,
  PrComment,
  PrCommentResult,
  PrEditBodyResult,
  PrReviewersResult,
  PrReviewerSuggestionsResult,
  PrCheckLogResult,
  PrCheckRerunResult,
  PrCheckoutResult,
  PrCleanupMergedResult,
  PrCreateResult,
  PrListResult,
  PrReview,
  PrReviewThread,
  PrReviewThreadComment,
  PrReviewThreadReplyResult,
  PrReviewThreadResolveResult,
  PrReviewThreadsResult,
  PrView
} from '../../shared/ipc'
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
  pullCurrentBranch,
  pushCurrentBranch,
  readGitUpstream,
  runGit,
  sanitizeRelativePaths,
  type CommitOutcome
} from './git'
import { sanitizedTerminalEnv } from '../agent/tools/terminal'
import { guardGitInvocation } from './repoCommandGuard'

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

async function gh(args: string[], cwd: string, timeout = TIMEOUT_MS, maxBuffer = MAX_BUFFER): Promise<string> {
  const executable = await resolveGhExecutable()
  if (!executable) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  // gh runs git in this repository itself (`pr create --fill` reads the log,
  // `pr merge` checks out and pulls), so its git gets the app's guard too.
  const { env } = await guardGitInvocation(['push'], cwd, buildGhEnv())
  const { stdout } = await execFile(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer,
    windowsHide: true,
    env
  })
  return stdout
}

async function git(args: string[], cwd: string, timeout = TIMEOUT_MS): Promise<string> {
  const guarded = await guardGitInvocation(args, cwd, GIT_ENV)
  const { stdout } = await execFile('git', guarded.args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    env: guarded.env
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
  /**
   * Two node shapes share the rollup: a CheckRun (`name`, `status`,
   * `conclusion`, `detailsUrl`, `startedAt`, `completedAt`) and a
   * StatusContext (`context`, `state`, `targetUrl`, `description`).
   */
  statusCheckRollup?: Array<{
    name?: string
    context?: string
    state?: string
    status?: string
    conclusion?: string | null
    detailsUrl?: string | null
    targetUrl?: string | null
    startedAt?: string | null
    completedAt?: string | null
    description?: string | null
  }>
  mergeStateStatus?: string
  reviews?: GhReviewJson[]
  latestReviews?: GhReviewJson[]
  reviewDecision?: string
  reviewRequests?: Array<{ login?: string } | string | null>
  isDraft?: boolean
  comments?: GhCommentJson[]
  autoMergeRequest?: GhAutoMergeJson | null
}

type GhCommentJson = {
  author?: { login?: string | null } | null
  body?: string | null
  createdAt?: string | null
  url?: string | null
  isMinimized?: boolean | null
}

type GhAutoMergeJson = {
  mergeMethod?: string | null
  enabledBy?: { login?: string | null } | null
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
  'isDraft',
  'mergeStateStatus',
  'comments',
  'autoMergeRequest'
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
  // Lead with what gh said. Node's message opens with `Command failed:` and the
  // whole command line, which for `pr view` is 25 JSON field names, so anything
  // that shortens this text (the log keeps 200 characters, a panel shows a
  // line) kept the command and dropped the reason, e.g. "no git remotes found".
  return [withIo.stderr?.trim(), withIo.stdout?.trim(), err.message].filter(Boolean).join('\n')
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

/** A check's link, when GitHub gave one the app may open. */
function httpsUrl(raw: string | null | undefined): string | null {
  const url = raw?.trim()
  return url && /^https:\/\//i.test(url) ? url : null
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
      name: c.name ?? c.context ?? 'check',
      state: c.state ?? c.status ?? 'UNKNOWN',
      conclusion: c.conclusion ?? null,
      url: httpsUrl(c.detailsUrl ?? c.targetUrl),
      startedAt: c.startedAt ?? null,
      completedAt: c.completedAt ?? null,
      description: c.description?.trim() || null
    })),
    mergeStateStatus: data.mergeStateStatus ?? '',
    reviews: (data.reviews ?? []).map(mapReview),
    latestReviews: (data.latestReviews ?? []).map(mapReview),
    reviewDecision: data.reviewDecision ?? '',
    reviewRequests: (data.reviewRequests ?? [])
      .map(mapReviewRequest)
      .filter((login): login is string => Boolean(login)),
    isDraft: data.isDraft === true,
    ...(Array.isArray(data.comments)
      ? {
          comments: data.comments.slice(-PR_COMMENTS_KEPT).map(mapPrComment),
          commentCount: data.comments.length
        }
      : {}),
    ...('autoMergeRequest' in data ? { autoMerge: mapAutoMerge(data.autoMergeRequest) } : {})
  }
}

/** The conversation's latest comments kept for the panel; the count still says how many there are. */
const PR_COMMENTS_KEPT = 50
/** One comment's text, as the panel keeps it. */
const PR_COMMENT_BODY_CAP = 20_000

function mapPrComment(c: GhCommentJson): PrComment {
  return {
    // A deleted account's comments keep their text and lose their author.
    author: c.author?.login?.trim() || 'ghost',
    body: capChars(c.body ?? '', PR_COMMENT_BODY_CAP),
    createdAt: c.createdAt ?? null,
    url: httpsUrl(c.url),
    minimized: c.isMinimized === true
  }
}

function mapAutoMerge(raw: GhAutoMergeJson | null | undefined): PrAutoMerge | null {
  if (!raw) return null
  return {
    method: (raw.mergeMethod ?? '').trim().toUpperCase() || 'MERGE',
    enabledBy: raw.enabledBy?.login?.trim() || null
  }
}

/**
 * Current branch PR (or pull request `number`), or null when none exists.
 * Throws on gh/auth/network errors.
 */
export async function prView(cwd: string, number?: number): Promise<PrView | null> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  const which = number === undefined ? [] : [prNumberArg(number)]

  const fetchJson = async (fields: readonly string[]): Promise<PrView | null> => {
    const raw = await gh(['pr', 'view', ...which, '--json', fields.join(',')], cwd)
    return mapPrView(JSON.parse(raw) as GhPrJson)
  }

  try {
    const view = await fetchJson(PR_VIEW_JSON_FIELDS)
    // Auto-merge is offered only where GitHub says it would take it: the
    // repository allows it and the pull request still waits on something.
    if (view && view.autoMerge === null && !view.isDraft && view.state.toUpperCase() === 'OPEN') {
      const can = await viewerCanEnableAutoMerge(cwd, view.number)
      if (can !== null) view.canAutoMerge = can
    }
    return view
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

/** A title and description written for the PR; without a title, gh fills both from the commits. */
export type PrCreateText = { title?: string; body?: string }

/**
 * `gh pr create` with the given title and description, or `--fill` when no
 * title was written. The description goes through a file of its own in the
 * OS temp folder — an argument would hit the Windows command-line limit — and
 * only that file is removed afterwards.
 */
async function ghPrCreate(args: string[], cwd: string, text: PrCreateText): Promise<string> {
  const title = text.title?.trim()
  const body = text.body?.trim() ?? ''
  if (!title) return gh([...args, '--fill'], cwd, PR_CREATE_TIMEOUT_MS)
  const bodyFile = join(tmpdir(), `vyotiq-pr-body-${randomUUID()}.md`)
  await writeFile(bodyFile, body ? `${body}\n` : '', { encoding: 'utf8', flag: 'wx' })
  try {
    return await gh([...args, `--title=${title}`, '--body-file', bodyFile], cwd, PR_CREATE_TIMEOUT_MS)
  } finally {
    await unlink(bodyFile).catch(() => undefined)
  }
}

async function createPrForBranch(
  cwd: string,
  branch: string,
  baseBranch: string,
  draft: boolean,
  setup: GithubRemoteSetup,
  text: PrCreateText = {}
): Promise<PrCreateResult> {
  const args = ['pr', 'create', '--base', baseBranch, '--head', branch]
  if (draft) args.push('--draft')
  const output = await ghPrCreate(args, cwd, text)
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
  opts: { draft?: boolean } & PrCreateText = {}
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
  return createPrForBranch(cwd, branch, baseBranch, opts.draft !== false, setup, opts)
}

/** Commit selected changes, create a topic branch when needed, push, and create a PR. */
export async function prCreateFromChanges(
  cwd: string,
  message: string,
  mode: 'all' | 'staged' = 'all',
  opts: {
    draft?: boolean
    /**
     * Runs once the commit has landed, before the push is checked or the PR
     * opened, while HEAD is that commit: what settles a task's edits with it.
     */
    onCommitted?: (outcome: CommitOutcome) => Promise<void>
  } & PrCreateText = {}
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
  if (outcome.committed) await opts.onCommitted?.(outcome)
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
    return createPrForBranch(cwd, branch, baseBranch, opts.draft !== false, setup, opts)
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
  return createPrForBranch(cwd, branch, baseBranch, opts.draft !== false, setup, opts)
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

/** `gh pr ready`: a draft becomes ready for review. */
export async function prReady(cwd: string, number: number): Promise<{ detail: string }> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  try {
    const out = await gh(['pr', 'ready', prNumberArg(number)], cwd, TIMEOUT_MS)
    return { detail: out.trim() || 'Marked ready for review' }
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

// ── Review threads ──────────────────────────────────────────────────────────
//
// Inline review conversations come from GraphQL: REST lists the comments but
// not whether a thread was resolved, which is the one thing worth sorting by.

const REVIEW_THREADS_PAGE = 100
const REVIEW_THREAD_COMMENTS = 50
/** 300 threads is past any review a person reads; the panel says when there are more. */
const REVIEW_THREADS_MAX_PAGES = 3
const PR_CHECKOUT_TIMEOUT_MS = 120_000

/** One line: a multi-line argument is one more thing for Windows quoting to get wrong. */
function graphqlText(query: string): string {
  return query.replace(/\s+/g, ' ').trim()
}

const REVIEW_THREAD_COMMENT_FIELDS = 'id author { login } body createdAt url'

const REVIEW_THREADS_QUERY = graphqlText(`
  query($owner: String!, $name: String!, $number: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: ${REVIEW_THREADS_PAGE}, after: $after) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes {
            id isResolved isOutdated path line originalLine startLine diffSide
            resolvedBy { login }
            viewerCanResolve viewerCanUnresolve viewerCanReply
            comments(first: ${REVIEW_THREAD_COMMENTS}) {
              totalCount
              nodes { ${REVIEW_THREAD_COMMENT_FIELDS} }
            }
          }
        }
      }
    }
  }
`)

const RESOLVE_THREAD_MUTATION = graphqlText(`
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
  }
`)

const UNRESOLVE_THREAD_MUTATION = graphqlText(`
  mutation($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
  }
`)

const REPLY_THREAD_MUTATION = graphqlText(`
  mutation($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
      comment { ${REVIEW_THREAD_COMMENT_FIELDS} }
    }
  }
`)

type GhReviewThreadCommentJson = {
  id?: string | null
  author?: { login?: string | null } | null
  body?: string | null
  createdAt?: string | null
  url?: string | null
}

type GhReviewThreadJson = {
  id?: string | null
  isResolved?: boolean | null
  isOutdated?: boolean | null
  path?: string | null
  line?: number | null
  originalLine?: number | null
  startLine?: number | null
  diffSide?: string | null
  resolvedBy?: { login?: string | null } | null
  viewerCanResolve?: boolean | null
  viewerCanUnresolve?: boolean | null
  viewerCanReply?: boolean | null
  comments?: { totalCount?: number | null; nodes?: Array<GhReviewThreadCommentJson | null> | null } | null
}

type GhReviewThreadsPageJson = {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          totalCount?: number | null
          pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null
          nodes?: Array<GhReviewThreadJson | null> | null
        } | null
      } | null
    } | null
  } | null
  errors?: Array<{ message?: string; type?: string }> | null
}

const THREAD_ID_RE = /^[A-Za-z0-9_=-]{1,200}$/

function intOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function mapReviewThreadComment(c: GhReviewThreadCommentJson): PrReviewThreadComment {
  return {
    id: c.id ?? '',
    // A deleted account's comments keep their text and lose their author.
    author: c.author?.login?.trim() || 'ghost',
    body: c.body ?? '',
    createdAt: c.createdAt ?? null,
    url: httpsUrl(c.url)
  }
}

/** One GraphQL thread node in the panel's shape; null for a node with no usable id. */
export function mapReviewThread(node: GhReviewThreadJson | null | undefined): PrReviewThread | null {
  if (!node || typeof node.id !== 'string' || !THREAD_ID_RE.test(node.id)) return null
  const comments = (node.comments?.nodes ?? [])
    .filter((c): c is GhReviewThreadCommentJson => Boolean(c))
    .map(mapReviewThreadComment)
  const total = intOrNull(node.comments?.totalCount)
  return {
    id: node.id,
    path: (node.path ?? '').replace(/\\/g, '/'),
    line: intOrNull(node.line),
    originalLine: intOrNull(node.originalLine),
    startLine: intOrNull(node.startLine),
    diffSide: (node.diffSide ?? '').trim().toUpperCase(),
    isResolved: node.isResolved === true,
    isOutdated: node.isOutdated === true,
    resolvedBy: node.resolvedBy?.login?.trim() || null,
    viewerCanResolve: node.viewerCanResolve === true,
    viewerCanUnresolve: node.viewerCanUnresolve === true,
    viewerCanReply: node.viewerCanReply === true,
    comments,
    commentCount: Math.max(comments.length, total ?? 0)
  }
}

export type ReviewThreadsPage = {
  threads: PrReviewThread[]
  totalCount: number
  hasNextPage: boolean
  endCursor: string | null
}

/**
 * One page of `gh api graphql` output. Null when the repository has no such
 * pull request; throws on a GraphQL error that is not that.
 */
export function parseReviewThreadsPage(raw: string): ReviewThreadsPage | null {
  let data: GhReviewThreadsPageJson
  try {
    data = JSON.parse(raw) as GhReviewThreadsPageJson
  } catch {
    throw new Error('GitHub CLI returned an invalid review threads response')
  }
  const errors = (data.errors ?? []).map((e) => e.message?.trim() ?? '').filter(Boolean)
  const reviewThreads = data.data?.repository?.pullRequest?.reviewThreads
  if (!reviewThreads) {
    if (errors.some(isMissingPullRequest) || (errors.length === 0 && data.data?.repository)) return null
    throw new Error(errors.join('\n') || 'GitHub returned no review threads')
  }
  const threads = (reviewThreads.nodes ?? [])
    .map(mapReviewThread)
    .filter((t): t is PrReviewThread => t !== null)
  const pageInfo = reviewThreads.pageInfo
  return {
    threads,
    totalCount: Math.max(threads.length, intOrNull(reviewThreads.totalCount) ?? 0),
    hasNextPage: pageInfo?.hasNextPage === true && Boolean(pageInfo.endCursor),
    endCursor: pageInfo?.endCursor ?? null
  }
}

function isMissingPullRequest(message: string): boolean {
  return /could not resolve to a pullrequest/i.test(message)
}

function reviewThreadIdArg(threadId: string): string {
  const id = threadId.trim()
  if (!THREAD_ID_RE.test(id)) throw new Error('Invalid review thread id')
  return id
}

/** `gh api graphql`: gh exits non-zero on a GraphQL error, with the reason on stderr. */
async function ghGraphql(fields: Array<[flag: '-f' | '-F', value: string]>, cwd: string): Promise<string> {
  const args = ['api', 'graphql']
  for (const [flag, value] of fields) args.push(flag, value)
  return gh(args, cwd, TIMEOUT_MS)
}

/**
 * The pull request's inline review threads, oldest first as GitHub keeps them.
 * Null when the repository has no such pull request. `{owner}`/`{repo}` are
 * gh's own placeholders: the same base repository `gh pr view` resolves.
 */
export async function prReviewThreads(cwd: string, number: number): Promise<PrReviewThreadsResult | null> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  const prNumber = prNumberArg(number)
  const threads: PrReviewThread[] = []
  let totalCount = 0
  let after: string | null = null
  let truncated = false
  for (let page = 0; page < REVIEW_THREADS_MAX_PAGES; page += 1) {
    const fields: Array<['-f' | '-F', string]> = [
      ['-f', `query=${REVIEW_THREADS_QUERY}`],
      ['-F', 'owner={owner}'],
      ['-F', 'name={repo}'],
      ['-F', `number=${prNumber}`]
    ]
    if (after) fields.push(['-f', `after=${after}`])
    let raw: string
    try {
      raw = await ghGraphql(fields, cwd)
    } catch (err) {
      const message = execErrorText(err)
      if (isMissingPullRequest(message) || isExpectedPrAbsence(message)) return null
      throw new Error(message)
    }
    const parsed = parseReviewThreadsPage(raw)
    if (!parsed) return null
    threads.push(...parsed.threads)
    totalCount = Math.max(totalCount, parsed.totalCount)
    if (!parsed.hasNextPage) break
    after = parsed.endCursor
    truncated = page === REVIEW_THREADS_MAX_PAGES - 1
  }
  return {
    number: Number(prNumber),
    threads,
    totalCount: Math.max(totalCount, threads.length),
    truncated: truncated || totalCount > threads.length
  }
}

/** Resolve or reopen one thread. Only from a button: it changes the review on GitHub. */
export async function prReviewThreadResolve(
  cwd: string,
  threadId: string,
  resolved: boolean
): Promise<PrReviewThreadResolveResult> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  const id = reviewThreadIdArg(threadId)
  let raw: string
  try {
    raw = await ghGraphql(
      [
        ['-f', `query=${resolved ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION}`],
        ['-f', `threadId=${id}`]
      ],
      cwd
    )
  } catch (err) {
    throw new Error(execErrorText(err))
  }
  let data: {
    data?: Record<string, { thread?: { id?: string; isResolved?: boolean } | null } | null> | null
  }
  try {
    data = JSON.parse(raw) as typeof data
  } catch {
    throw new Error('GitHub CLI returned an invalid response')
  }
  const thread = data.data?.[resolved ? 'resolveReviewThread' : 'unresolveReviewThread']?.thread
  if (!thread || typeof thread.isResolved !== 'boolean') {
    throw new Error('GitHub did not confirm the change to the review thread')
  }
  return { threadId: id, isResolved: thread.isResolved }
}

/**
 * Reply on a thread. This posts publicly under the signed-in account, so it
 * is wired to one explicit Send button and nothing else.
 */
export async function prReviewThreadReply(
  cwd: string,
  threadId: string,
  body: string
): Promise<PrReviewThreadReplyResult> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  const id = reviewThreadIdArg(threadId)
  const text = body.trim()
  if (!text) throw new Error('Reply cannot be empty')
  let raw: string
  try {
    raw = await ghGraphql(
      [
        ['-f', `query=${REPLY_THREAD_MUTATION}`],
        ['-f', `threadId=${id}`],
        ['-f', `body=${text}`]
      ],
      cwd
    )
  } catch (err) {
    throw new Error(execErrorText(err))
  }
  let data: {
    data?: { addPullRequestReviewThreadReply?: { comment?: GhReviewThreadCommentJson | null } | null } | null
  }
  try {
    data = JSON.parse(raw) as typeof data
  } catch {
    throw new Error('GitHub CLI returned an invalid response')
  }
  const comment = data.data?.addPullRequestReviewThreadReply?.comment
  if (!comment?.id) throw new Error('GitHub did not confirm the reply')
  return { comment: mapReviewThreadComment(comment) }
}

type GhPrListJson = Array<{
  number?: number
  title?: string
  headRefName?: string
  author?: { login?: string | null } | null
  updatedAt?: string | null
  url?: string | null
  isDraft?: boolean
}>

/** Recent open pull requests in the repository (gh's default order: newest first). */
export async function prList(cwd: string): Promise<PrListResult> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  let raw: string
  try {
    raw = await gh(
      ['pr', 'list', '--json', 'number,title,headRefName,author,updatedAt,url,isDraft', '--limit', '20'],
      cwd
    )
  } catch (err) {
    throw new Error(execErrorText(err))
  }
  let rows: GhPrListJson
  try {
    rows = JSON.parse(raw) as GhPrListJson
  } catch {
    throw new Error('GitHub CLI returned an invalid pull request list')
  }
  return {
    prs: (Array.isArray(rows) ? rows : [])
      .filter((row) => typeof row.number === 'number' && Number.isInteger(row.number) && row.number > 0)
      .slice(0, 20)
      .map((row) => ({
        number: row.number!,
        title: row.title ?? '',
        headRefName: row.headRefName ?? '',
        author: row.author?.login?.trim() || 'ghost',
        updatedAt: row.updatedAt ?? null,
        url: httpsUrl(row.url),
        isDraft: row.isDraft === true
      }))
  }
}

/** Tracked files with changes (staged or not); untracked files survive a checkout. */
async function trackedChanges(cwd: string): Promise<string[]> {
  const out = await git(['status', '--porcelain=v1', '--untracked-files=no'], cwd)
  return out.split(/\r?\n/).filter((line) => line.trim().length > 0)
}

/**
 * `gh pr checkout`. Refused while tracked files have uncommitted changes, so a
 * checkout never carries one branch's work onto another. gh runs git itself;
 * it gets the same repository-program guard as the app's own git calls.
 */
export async function prCheckout(cwd: string, number: number): Promise<PrCheckoutResult> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  const prNumber = prNumberArg(number)
  const changed = await trackedChanges(cwd)
  if (changed.length > 0) {
    throw new Error(
      `Commit or discard the ${changed.length} uncommitted change${changed.length === 1 ? '' : 's'} before checking out pull request #${prNumber}.`
    )
  }
  const executable = await resolveGhExecutable()
  if (!executable) throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  const { env } = await guardGitInvocation(['checkout'], cwd, buildGhEnv())
  try {
    await execFile(executable, ['pr', 'checkout', prNumber], {
      cwd,
      encoding: 'utf8',
      timeout: PR_CHECKOUT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      env
    })
  } catch (err) {
    throw new Error(execErrorText(err))
  }
  const branch = await currentGitBranch(cwd)
  return { detail: branch ? `Checked out #${prNumber} on ${branch}` : `Checked out #${prNumber}` }
}

// ── Issues: one issue, read in full ─────────────────────────────────────────

const ISSUE_BODY_CAP = 20_000
const ISSUE_COMMENT_CAP = 4_000
/** The latest comments shown; an issue with more says how many it has. */
const ISSUE_COMMENTS_SHOWN = 20

type GhIssueJson = {
  number?: number
  title?: string
  body?: string | null
  state?: string
  url?: string
  createdAt?: string | null
  author?: { login?: string | null } | null
  labels?: Array<{ name?: string | null } | null> | null
  comments?: Array<{ author?: { login?: string | null } | null; body?: string | null; createdAt?: string | null } | null> | null
}

function capChars(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap).trimEnd()}\n\n[…cut at ${cap} characters]` : text
}

/** @internal Exported for unit tests. */
export function mapGithubIssue(data: GhIssueJson): GithubIssueDetail | null {
  if (typeof data.number !== 'number' || !Number.isInteger(data.number) || data.number < 1) return null
  const comments = (data.comments ?? []).filter((c): c is NonNullable<typeof c> => Boolean(c))
  return {
    number: data.number,
    title: data.title ?? '',
    url: httpsUrl(data.url) ?? '',
    state: data.state ?? '',
    // A deleted account's issues keep their text and lose their author.
    author: data.author?.login?.trim() || 'ghost',
    body: capChars(data.body ?? '', ISSUE_BODY_CAP),
    labels: (data.labels ?? []).map((l) => l?.name?.trim() ?? '').filter(Boolean),
    createdAt: data.createdAt ?? null,
    comments: comments.slice(-ISSUE_COMMENTS_SHOWN).map((c) => ({
      author: c.author?.login?.trim() || 'ghost',
      body: capChars(c.body ?? '', ISSUE_COMMENT_CAP),
      createdAt: c.createdAt ?? null
    })),
    commentCount: comments.length
  }
}

/** `gh issue view`: an issue's text, labels and latest comments. */
export async function viewGithubIssue(cwd: string, number: number): Promise<GithubIssueDetail> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  if (!Number.isInteger(number) || number < 1) throw new Error('Invalid issue number')
  let raw: string
  try {
    raw = await gh(
      ['issue', 'view', String(number), '--json', 'number,title,body,state,url,author,labels,comments,createdAt'],
      cwd
    )
  } catch (err) {
    throw new Error(execErrorText(err))
  }
  let data: GhIssueJson
  try {
    data = JSON.parse(raw) as GhIssueJson
  } catch {
    throw new Error('GitHub CLI returned an invalid issue')
  }
  const issue = mapGithubIssue(data)
  if (!issue) throw new Error(`GitHub returned no issue #${number}`)
  return issue
}

// ── CI: a failed check's log, and running its job again ────────────────────
//
// Only a GitHub Actions job has a log gh can read and a job gh can re-run.
// Its check links to `…/actions/runs/<run id>/job/<job id>`, and that job id
// is the job's databaseId, which is what `gh run view --job` and
// `gh run rerun --job` take. Any other check (an external CI, a bot) only
// links out.

const ACTIONS_JOB_URL_RE = /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/actions\/runs\/(\d{1,20})\/job\/(\d{1,20})(?:[/?#]|$)/i
const CHECK_LOG_TIMEOUT_MS = 60_000
/** A whole job's log can run to megabytes; it is only read to find one step. */
const CHECK_LOG_MAX_BUFFER = 32 * 1024 * 1024
const CHECK_LOG_MAX_LINES = 150
const CHECK_LOG_MAX_CHARS = 12_000
/** Lines kept from the end of a log that has no `##[error]` line. */
const CHECK_LOG_TAIL_LINES = 60

/** The run and job a GitHub Actions check links to; null for any other link. */
export function parseActionsJobUrl(url: string | null | undefined): { runId: string; jobId: string } | null {
  const match = ACTIONS_JOB_URL_RE.exec(url?.trim() ?? '')
  return match ? { runId: match[1]!, jobId: match[2]! } : null
}

/**
 * One line of `gh run view --log`: `<job>\t<step>\t<timestamp> <text>`. gh
 * 2.98 names every step "UNKNOWN STEP", so the step is read from the log's
 * own `##[group]Run …` headers instead. Colour codes arrive either as ESC
 * sequences or spelled out as `^[[36;1m`.
 */
function cleanLogLine(line: string): string {
  return line
    .replace(/^[^\t\r\n]*\t[^\t\r\n]*\t/, '')
    .replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/, '')
    // eslint-disable-next-line no-control-regex -- ESC opens the colour codes being removed
    .replace(/(?:\x1b|\^\[)\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\s+$/, '')
}

function shownLogLine(line: string): string | null {
  if (line.startsWith('##[endgroup]')) return null
  if (line.startsWith('##[group]')) return line.slice('##[group]'.length)
  if (line.startsWith('##[error]')) return `Error: ${line.slice('##[error]'.length)}`
  if (line.startsWith('##[warning]')) return `Warning: ${line.slice('##[warning]'.length)}`
  return line
}

/**
 * The part of a job log that says why it failed: the step around the last
 * `##[error]` line, from that step's `Run …` header (its echoed command and
 * `shell:` lines skipped) to the error. With no error line, the log's tail.
 * Capped from the front, so the error itself is always kept.
 */
export function extractFailedStepLog(raw: string): PrCheckLogResult {
  const lines = raw.split(/\r?\n/).map(cleanLogLine)
  while (lines.length > 0 && !lines[lines.length - 1]) lines.pop()
  let errorAt = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]!.startsWith('##[error]')) {
      errorAt = i
      break
    }
  }
  let step: string | null = null
  let body: string[]
  if (errorAt === -1) {
    body = lines.slice(-CHECK_LOG_TAIL_LINES)
  } else {
    let start = 0
    for (let i = errorAt; i >= 0; i -= 1) {
      if (lines[i]!.startsWith('##[group]Run ')) {
        start = i
        step = lines[i]!.slice('##[group]Run '.length).trim() || null
        break
      }
    }
    let from = start
    if (step) {
      // Past the header's own group: the echoed command, `shell:` and `env:`.
      const close = lines.findIndex((line, i) => i > start && i < errorAt && line.startsWith('##[endgroup]'))
      if (close !== -1) from = close + 1
    }
    body = lines.slice(from, errorAt + 1)
  }
  const shown = body.map(shownLogLine).filter((line): line is string => line !== null)
  const kept = shown.length > CHECK_LOG_MAX_LINES ? shown.slice(-CHECK_LOG_MAX_LINES) : shown
  let truncated = kept.length < shown.length
  let excerpt = kept.join('\n')
  if (excerpt.length > CHECK_LOG_MAX_CHARS) {
    excerpt = excerpt.slice(-CHECK_LOG_MAX_CHARS)
    excerpt = excerpt.slice(excerpt.indexOf('\n') + 1)
    truncated = true
  }
  return { step, excerpt, truncated, foundError: errorAt !== -1 }
}

function actionsJobIds(url: string): { runId: string; jobId: string } {
  const ids = parseActionsJobUrl(url)
  if (!ids) {
    throw new Error('Only a GitHub Actions check has a log and a job the app can read or re-run. Open this check on its own site.')
  }
  return ids
}

/** The failing step of a GitHub Actions check, from its job's log. */
export async function prCheckLog(cwd: string, url: string): Promise<PrCheckLogResult> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  const { jobId } = actionsJobIds(url)
  try {
    // `--log-failed` is empty for a job that did not fail; the whole log then.
    let raw = await gh(['run', 'view', '--job', jobId, '--log-failed'], cwd, CHECK_LOG_TIMEOUT_MS, CHECK_LOG_MAX_BUFFER)
    if (!raw.trim()) {
      raw = await gh(['run', 'view', '--job', jobId, '--log'], cwd, CHECK_LOG_TIMEOUT_MS, CHECK_LOG_MAX_BUFFER)
    }
    return extractFailedStepLog(raw)
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new Error('The job log is larger than 32 MB. Open the check on GitHub to read it.')
    }
    throw new Error(execErrorText(err))
  }
}

type GhRunJobsJson = { jobs?: Array<{ databaseId?: number; name?: string; url?: string } | null> | null }

/**
 * Run one GitHub Actions job again (`gh run rerun --job`). The job is looked
 * up in its run first, so a link whose id is not a job's databaseId is
 * refused here rather than by a 404 from GitHub.
 */
export async function prCheckRerun(cwd: string, url: string): Promise<PrCheckRerunResult> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  const { runId, jobId } = actionsJobIds(url)
  let jobs: GhRunJobsJson
  try {
    jobs = JSON.parse(await gh(['run', 'view', runId, '--json', 'jobs'], cwd)) as GhRunJobsJson
  } catch (err) {
    throw new Error(err instanceof SyntaxError ? 'GitHub CLI returned an invalid run' : execErrorText(err))
  }
  const target = url.trim().replace(/[?#].*$/, '')
  const job = (jobs.jobs ?? []).find(
    (j) => j && (String(j.databaseId) === jobId || (j.url ?? '').replace(/[?#].*$/, '') === target)
  )
  if (!job || typeof job.databaseId !== 'number') {
    throw new Error(`Run ${runId} has no job ${jobId}; refresh the checks and try again.`)
  }
  try {
    await gh(['run', 'rerun', runId, '--job', String(job.databaseId)], cwd)
  } catch (err) {
    throw new Error(execErrorText(err))
  }
  return { detail: `Re-running ${job.name?.trim() || 'the job'}` }
}

// ── After a merge: tidy the branch away ─────────────────────────────────────

type GhMergedPrJson = {
  state?: string
  headRefName?: string
  baseRefName?: string
  headRefOid?: string
  isCrossRepository?: boolean
}

/** A branch name safe to hand git and GitHub's refs API: no option, no `..`, no spaces. */
function safeBranchName(raw: string | undefined, what: string): string {
  const name = raw?.trim() ?? ''
  if (!name || name.startsWith('-') || name.includes('..') || /[\s\\~^:?*[]/.test(name)) {
    throw new Error(`GitHub reported an unusable ${what} branch name`)
  }
  return name
}

async function gitOut(args: string[], cwd: string): Promise<string | null> {
  try {
    return await runGit(args, cwd)
  } catch {
    return null
  }
}

function refsApiPath(branch: string): string {
  return `repos/{owner}/{repo}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * After a pull request merged: switch the workspace from its branch to the
 * base and fast-forward it, then delete the branch here and on GitHub —
 * what GitHub's "Delete branch" button and a `git switch` + `git pull` do.
 *
 * Nothing is lost on the way: the local branch goes only when every commit on
 * it is in the merged pull request, the GitHub branch only when it still
 * points at the merged head, a fork's branch is never touched, and the switch
 * is refused while tracked files have uncommitted changes.
 */
export async function prCleanupMerged(cwd: string, number: number): Promise<PrCleanupMergedResult> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
  if (!isGitRepo(cwd)) throw new Error('Not a git repository')
  const prNumber = prNumberArg(number)
  let pr: GhMergedPrJson
  try {
    pr = JSON.parse(
      await gh(['pr', 'view', prNumber, '--json', 'state,headRefName,baseRefName,headRefOid,isCrossRepository'], cwd)
    ) as GhMergedPrJson
  } catch (err) {
    throw new Error(err instanceof SyntaxError ? 'GitHub CLI returned an invalid pull request' : execErrorText(err))
  }
  if ((pr.state ?? '').toUpperCase() !== 'MERGED') {
    throw new Error(`Pull request #${prNumber} is not merged; its branch stays.`)
  }
  const head = safeBranchName(pr.headRefName, 'head')
  const base = safeBranchName(pr.baseRefName, 'base')
  const headOid = parseGitObjectId(pr.headRefOid)
  const notes: string[] = []
  let switchedTo: string | null = null
  let deletedLocal = false
  let deletedRemote = false

  // 1. Off the merged branch, onto the base, up to date.
  if ((await currentGitBranch(cwd)) === head) {
    const changed = await trackedChanges(cwd)
    if (changed.length > 0) {
      throw new Error(
        `Commit or discard the ${changed.length} uncommitted change${changed.length === 1 ? '' : 's'} on ${head} before cleaning it up.`
      )
    }
    try {
      // With no local base, git's own guess makes one tracking the remote's.
      await runGit(['switch', base], cwd)
      switchedTo = base
    } catch (err) {
      const said = execErrorText(err)
      const elsewhere = /already (checked out|used by worktree) at '([^']+)'/i.exec(said)
      notes.push(
        elsewhere
          ? `${base} is checked out in another worktree (${elsewhere[2]}), so this one stays on ${head}`
          : `Could not switch to ${base}: ${said.split('\n')[0]}`
      )
    }
    if (switchedTo && (await readGitUpstream(cwd))) {
      try {
        const pulled = await pullCurrentBranch(cwd, 'ff-only')
        notes.push(pulled.kind === 'diverged' ? `${base} has diverged from its upstream; pull it yourself` : pulled.detail)
      } catch (err) {
        notes.push(err instanceof Error ? err.message : String(err))
      }
    }
  }

  // 2. The local branch, only when nothing on it is missing from the merge.
  const localTip = (await gitOut(['rev-parse', '--verify', '--quiet', `refs/heads/${head}`], cwd))?.trim() || null
  if (localTip && (await currentGitBranch(cwd)) !== head) {
    const contained =
      headOid != null &&
      (localTip === headOid || (await gitOut(['merge-base', '--is-ancestor', localTip, headOid], cwd)) !== null)
    if (contained) {
      await runGit(['branch', '-D', head], cwd)
      deletedLocal = true
    } else {
      notes.push(`Kept the local ${head}: it has commits that are not in the pull request`)
    }
  }

  // 3. The branch on GitHub, never a fork's, only while it is the merged head.
  if (pr.isCrossRepository) {
    notes.push(`${head} lives on a fork, so it was left there`)
  } else {
    let remoteSha: string | null = null
    let remoteGone = false
    try {
      const ref = JSON.parse(await gh(['api', refsApiPath(head).replace('/git/refs/', '/git/ref/')], cwd)) as {
        object?: { sha?: string }
      }
      remoteSha = parseGitObjectId(ref.object?.sha)
    } catch (err) {
      const said = execErrorText(err)
      if (/HTTP 404|Not Found/i.test(said)) remoteGone = true
      else notes.push(`Could not read ${head} on GitHub: ${said.split('\n')[0]}`)
    }
    if (remoteGone) {
      notes.push(`${head} was already deleted on GitHub`)
    } else if (remoteSha && headOid && remoteSha !== headOid) {
      notes.push(`Kept ${head} on GitHub: it has commits pushed after the merge`)
    } else if (remoteSha) {
      try {
        await gh(['api', '-X', 'DELETE', refsApiPath(head)], cwd)
        deletedRemote = true
      } catch (err) {
        notes.push(`Could not delete ${head} on GitHub: ${execErrorText(err).split('\n')[0]}`)
      }
    }
    if (deletedRemote || remoteGone) {
      // The remote-tracking ref it leaves behind, so the branch list says it is gone.
      for (const remote of ((await gitOut(['remote'], cwd)) ?? '').split(/\r?\n/).map((r) => r.trim()).filter(Boolean)) {
        if (!remote.startsWith('-')) await gitOut(['branch', '--delete', '--remotes', `${remote}/${head}`], cwd)
      }
    }
  }

  const deleted =
    deletedLocal && deletedRemote
      ? `deleted ${head} here and on GitHub`
      : deletedLocal
        ? `deleted ${head}`
        : deletedRemote
          ? `deleted ${head} on GitHub`
          : null
  const done = [switchedTo ? `Switched to ${switchedTo}` : null, deleted].filter(Boolean)
  const lead = done.length > 0 ? done.join(', ') : 'Nothing to clean up'
  return {
    detail: [lead.charAt(0).toUpperCase() + lead.slice(1), ...notes].join('. ') + '.',
    switchedTo,
    deletedLocal,
    deletedRemote
  }
}

// ── The PR conversation, reviewers and auto-merge ───────────────────────────
//
// Each one changes the pull request on GitHub under the signed-in account, so
// each is wired to one explicit button and nothing calls it on its own.

/**
 * Hand gh a text through a file of its own in the OS temp folder — an argument
 * would hit the Windows command-line limit — and remove only that file.
 */
async function withTextFile<T>(text: string, run: (file: string) => Promise<T>): Promise<T> {
  const file = join(tmpdir(), `vyotiq-gh-text-${randomUUID()}.md`)
  await writeFile(file, text, { encoding: 'utf8', flag: 'wx' })
  try {
    return await run(file)
  } finally {
    await unlink(file).catch(() => undefined)
  }
}

async function requireGh(): Promise<void> {
  if (!(await ghAvailable())) {
    throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  }
}

/** Post a comment on the pull request's conversation. */
export async function prComment(cwd: string, number: number, body: string): Promise<PrCommentResult> {
  await requireGh()
  const text = body.trim()
  if (!text) throw new Error('Comment cannot be empty')
  let out: string
  try {
    out = await withTextFile(text, (file) => gh(['pr', 'comment', prNumberArg(number), '--body-file', file], cwd))
  } catch (err) {
    throw new Error(execErrorText(err))
  }
  const url = /https:\/\/\S+#issuecomment-\d+/i.exec(out)?.[0] ?? null
  return { detail: 'Comment posted', url }
}

const sameText = (a: string, b: string): boolean => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n')

/**
 * Replace the pull request's description. GitHub has no compare-and-swap for
 * it, so the description is read again first: when someone changed it since
 * `expected` was shown, nothing is written and the edit is refused.
 */
export async function prEditBody(
  cwd: string,
  number: number,
  body: string,
  expected: string
): Promise<PrEditBodyResult> {
  await requireGh()
  const n = prNumberArg(number)
  let current: string
  try {
    const raw = await gh(['pr', 'view', n, '--json', 'body'], cwd)
    current = (JSON.parse(raw) as { body?: string | null }).body ?? ''
  } catch (err) {
    throw new Error(execErrorText(err))
  }
  if (!sameText(current, expected)) {
    throw new Error('The description was changed on GitHub after you started editing. Refresh to see it, then edit again.')
  }
  if (sameText(current, body)) return { body: current }
  try {
    await withTextFile(body, (file) => gh(['pr', 'edit', n, '--body-file', file], cwd))
  } catch (err) {
    throw new Error(execErrorText(err))
  }
  return { body }
}

async function readReviewRequests(cwd: string, n: string): Promise<string[]> {
  const raw = await gh(['pr', 'view', n, '--json', 'reviewRequests'], cwd)
  const data = JSON.parse(raw) as Pick<GhPrJson, 'reviewRequests'>
  return (data.reviewRequests ?? []).map(mapReviewRequest).filter((login): login is string => Boolean(login))
}

/**
 * Ask for (or withdraw) reviews. Returns who GitHub has review requested from
 * afterwards, read back rather than assumed: a reviewer GitHub would not take
 * makes gh fail, and one who already reviewed drops off the list.
 */
export async function prEditReviewers(
  cwd: string,
  number: number,
  add: readonly string[],
  remove: readonly string[]
): Promise<PrReviewersResult> {
  await requireGh()
  const n = prNumberArg(number)
  const args = ['pr', 'edit', n]
  for (const login of add) args.push('--add-reviewer', login)
  for (const login of remove) args.push('--remove-reviewer', login)
  try {
    await gh(args, cwd)
  } catch (err) {
    throw new Error(execErrorText(err))
  }
  const reviewRequests = await readReviewRequests(cwd, n).catch(() => [])
  const detail =
    add.length > 0 && remove.length === 0
      ? `Review requested from ${add.join(', ')}`
      : remove.length > 0 && add.length === 0
        ? `Review request withdrawn from ${remove.join(', ')}`
        : 'Reviewers updated'
  return { detail, reviewRequests }
}

const ASSIGNABLE_USERS_QUERY = graphqlText(`
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) { assignableUsers(first: 100) { nodes { login } } }
  }
`)

/** People who can be asked for a review here: the repository's assignable users, at most 100. */
export async function prReviewerSuggestions(cwd: string): Promise<PrReviewerSuggestionsResult> {
  await requireGh()
  let raw: string
  try {
    raw = await ghGraphql(
      [
        ['-f', `query=${ASSIGNABLE_USERS_QUERY}`],
        ['-F', 'owner={owner}'],
        ['-F', 'name={repo}']
      ],
      cwd
    )
  } catch (err) {
    throw new Error(execErrorText(err))
  }
  const data = JSON.parse(raw) as {
    data?: { repository?: { assignableUsers?: { nodes?: Array<{ login?: string | null } | null> | null } | null } | null }
  }
  const logins = (data.data?.repository?.assignableUsers?.nodes ?? [])
    .map((node) => node?.login?.trim() ?? '')
    .filter(Boolean)
  return { logins: [...new Set(logins)].sort((a, b) => a.localeCompare(b)) }
}

const AUTO_MERGE_QUERY = graphqlText(`
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      autoMergeAllowed
      pullRequest(number: $number) { viewerCanEnableAutoMerge }
    }
  }
`)

/** Repositories that do not allow auto-merge, so the PR poll does not ask GitHub again every 15 seconds. */
const autoMergeOff = new Map<string, number>()
const AUTO_MERGE_OFF_TTL_MS = 10 * 60_000

/** @internal */
export function resetAutoMergeCacheForTests(): void {
  autoMergeOff.clear()
}

/**
 * Whether GitHub would take an auto-merge request on this pull request from
 * the signed-in account: the repository allows auto-merge and the PR cannot
 * merge yet. Null when GitHub could not be asked.
 */
async function viewerCanEnableAutoMerge(cwd: string, number: number): Promise<boolean | null> {
  const off = autoMergeOff.get(cwd)
  if (off !== undefined && Date.now() - off < AUTO_MERGE_OFF_TTL_MS) return false
  try {
    const raw = await ghGraphql(
      [
        ['-f', `query=${AUTO_MERGE_QUERY}`],
        ['-F', 'owner={owner}'],
        ['-F', 'name={repo}'],
        ['-F', `number=${prNumberArg(number)}`]
      ],
      cwd
    )
    const repo = (
      JSON.parse(raw) as {
        data?: { repository?: { autoMergeAllowed?: boolean; pullRequest?: { viewerCanEnableAutoMerge?: boolean } | null } | null }
      }
    ).data?.repository
    if (!repo) return null
    if (repo.autoMergeAllowed === false) {
      autoMergeOff.set(cwd, Date.now())
      return false
    }
    autoMergeOff.delete(cwd)
    return repo.pullRequest?.viewerCanEnableAutoMerge === true
  } catch {
    return null
  }
}

const AUTO_MERGE_FLAG: Record<'squash' | 'merge' | 'rebase', string> = {
  squash: '--squash',
  merge: '--merge',
  rebase: '--rebase'
}

/**
 * Turn auto-merge on (GitHub merges the PR by `method` once its requirements
 * are met) or off. The branch is never deleted by it. What GitHub has set
 * afterwards is read back, not assumed.
 */
export async function prSetAutoMerge(
  cwd: string,
  number: number,
  enable: boolean,
  method: 'squash' | 'merge' | 'rebase' = 'squash'
): Promise<PrAutoMergeResult> {
  await requireGh()
  const n = prNumberArg(number)
  const args = enable
    ? ['pr', 'merge', n, '--auto', AUTO_MERGE_FLAG[method], '--delete-branch=false']
    : ['pr', 'merge', n, '--disable-auto']
  try {
    await gh(args, cwd, MERGE_TIMEOUT_MS)
  } catch (err) {
    throw new Error(execErrorText(err))
  }
  let after: Pick<GhPrJson, 'autoMergeRequest' | 'state'>
  try {
    after = JSON.parse(await gh(['pr', 'view', n, '--json', 'autoMergeRequest,state'], cwd)) as typeof after
  } catch (err) {
    throw new Error(`gh accepted the change, but reading it back failed: ${execErrorText(err).split('\n')[0]}`)
  }
  const autoMerge = mapAutoMerge(after.autoMergeRequest)
  if ((after.state ?? '').toUpperCase() === 'MERGED') return { detail: 'Merged', autoMerge: null }
  if (enable && !autoMerge) throw new Error('GitHub did not turn auto-merge on for this pull request')
  if (!enable && autoMerge) throw new Error('GitHub still has auto-merge on for this pull request')
  return {
    detail: enable ? `Auto-merge on: it will ${method === 'squash' ? 'squash and merge' : method === 'rebase' ? 'rebase and merge' : 'merge'} once its requirements are met` : 'Auto-merge off',
    autoMerge
  }
}
