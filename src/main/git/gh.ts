import { execFile as execFileCb } from 'child_process'
import { randomUUID } from 'crypto'
import { unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type {
  PrChangeType,
  PrCheckoutResult,
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
  pushCurrentBranch,
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

async function gh(args: string[], cwd: string, timeout = TIMEOUT_MS): Promise<string> {
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
    maxBuffer: MAX_BUFFER,
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
  'mergeStateStatus'
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
