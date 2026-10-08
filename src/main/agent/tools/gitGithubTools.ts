import type { AgentToolName } from '../schemas/tools'
import { toolGitStatusAsync, toolGitDiffAsync } from './gitHelpers'
import { patchTouchedPaths, toolApplyPatchAsync } from './applyPatch'
import { getWriteCheckpoint } from '../checkpoints'
import { commitPaths } from '@main/git/git'
import {
  prCreate,
  prCheckLog,
  prView,
  parseActionsJobUrl,
  reviewPullRequest,
  listGithubIssues,
  createGithubIssue,
  viewGithubIssue
} from '@main/git/gh'
import { wrapUntrustedContent } from '../untrustedContent'
import { readTrimmed } from './argAccess'
import { invalidateAfterWorkspaceMutation, throwIfAborted, toolOk, toolFail } from './index'
import type { ToolHandler } from './index'

/** Conclusions GitHub reports for a check that failed (the PR panel's own set). */
const FAILED_CHECK_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])
/** Job logs read per call: each is a `gh run view` of up to megabytes. */
const CHECK_LOGS_READ = 3

export const gitGithubHandlers = {
  git_status: async (workspace, _args, signal) => {
    throwIfAborted(signal)
    const content = await toolGitStatusAsync(workspace)
    throwIfAborted(signal)
    return toolOk('git_status', 'git status', content)
  },
  git_diff: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const path = typeof args.path === 'string' ? args.path : undefined
    const staged = args.staged === true
    const result = await toolGitDiffAsync(workspace, { path, staged })
    throwIfAborted(signal)
    const summary = path ? `git diff ${path}` : staged ? 'git diff --staged' : 'git diff'
    // Match git_status: non-repo is informative ok content, not a hard tool failure.
    if (!result.ok && result.content === 'Not a git repository') {
      return toolOk('git_diff', summary, result.content)
    }
    if (!result.ok) return toolFail('git_diff', summary, result.content)
    return toolOk('git_diff', summary, result.content)
  },
  git_commit: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const message = readTrimmed(args, 'message')
    if (!message) return toolFail('git_commit', 'git commit', 'Commit message is required')
    const push = args.push === true
    const extraPaths = Array.isArray(args.paths)
      ? args.paths.filter((p): p is string => typeof p === 'string')
      : []
    try {
      // Scope staging to files this run actually changed (plus any paths the
      // model names explicitly) so unrelated user edits are not swept into
      // the commit. Refuse an empty scope — never fall back to staging all.
      const touched = new Set<string>([...(context.mutationPaths ?? []), ...extraPaths])
      if (touched.size === 0) {
        return toolFail(
          'git_commit',
          'git commit',
          'No run-touched files to commit. Pass paths: [...] for explicit paths, or edit/delete files in this run first.'
        )
      }
      const summary = push ? 'git commit + push' : 'git commit'
      const lines: string[] = []
      const outcome = await commitPaths(workspace, message, push, [...touched])
      const committed = outcome.committed
      const pushed = outcome.pushed
      lines.push(
        outcome.detail,
        `committed: ${outcome.committed}`,
        `pushed: ${outcome.pushed}`,
        `message: ${message}`
      )
      if (outcome.skipped.length > 0) {
        const shown = outcome.skipped.slice(0, 20)
        const more = outcome.skipped.length - shown.length
        lines.push(
          `left uncommitted (${outcome.skipped.length} unrelated dirty path${outcome.skipped.length === 1 ? '' : 's'}): ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`,
          'To include any of these, call git_commit again with paths: [...].'
        )
      }
      if (committed) invalidateAfterWorkspaceMutation(workspace)
      return toolOk('git_commit', summary, lines.join('\n'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('git_commit', 'git commit', msg)
    }
  },
  git_apply: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    // Snapshot every file the patch names first, like the edit tools do, so
    // the write shows in Changes, can be undone, and dates the run's checks.
    const cp = args.check === true || context.skipWriteCheckpoint ? undefined : getWriteCheckpoint(context.runDir)
    if (cp) {
      // Same extraction the dispatch guard reads (index.ts): one parser, so the
      // undo record covers exactly the writes the path_scope check approved.
      const patchText = typeof args.patch === 'string' ? args.patch : ''
      for (const touched of patchTouchedPaths(patchText)) {
        try {
          await cp.recordPrior(touched.path, touched.kind, { nonEditTool: true })
        } catch {
          // A path outside the workspace: git apply refuses it too.
        }
      }
    }
    const result = await toolApplyPatchAsync(workspace, args, signal)
    throwIfAborted(signal)
    if (!result.ok) return toolFail('git_apply', result.summary, result.content)
    invalidateAfterWorkspaceMutation(workspace)
    return toolOk('git_apply', result.summary, result.content)
  },
  github_pr_create: async (workspace, args, signal) => {
    throwIfAborted(signal)
    try {
      const result = await prCreate(workspace, { draft: args.draft !== false })
      throwIfAborted(signal)
      return toolOk(
        'github_pr_create',
        result.url,
        [result.detail, result.url].filter(Boolean).join('\n')
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('github_pr_create', 'gh pr create', msg)
    }
  },
  github_pr_review: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const event = args.event as 'approve' | 'request-changes' | 'comment'
    try {
      const result = await reviewPullRequest(
        workspace,
        event,
        typeof args.body === 'string' ? args.body : undefined,
        typeof args.number === 'number' ? args.number : undefined
      )
      throwIfAborted(signal)
      return toolOk('github_pr_review', event, result.detail)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('github_pr_review', 'gh pr review', msg)
    }
  },
  github_pr_checks: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const number = typeof args.number === 'number' ? args.number : undefined
    const summary = number ? `checks on #${number}` : 'checks'
    try {
      const pr = await prView(workspace, number)
      throwIfAborted(signal)
      if (!pr) return toolOk('github_pr_checks', summary, 'This branch has no pull request on GitHub.')
      const lines = [`Pull request #${pr.number} ${pr.title} (${pr.state.toLowerCase()}) ${pr.headRefName} -> ${pr.baseRefName}`, pr.url]
      if (pr.checks.length === 0) {
        lines.push('No CI checks reported.')
        return toolOk('github_pr_checks', `#${pr.number}`, lines.join('\n'))
      }
      for (const check of pr.checks) {
        const verdict = (check.conclusion || check.state || 'unknown').toLowerCase()
        lines.push(`- ${check.name}: ${verdict}${check.description ? ` (${check.description})` : ''}${check.url ? ` ${check.url}` : ''}`)
      }
      const failed = pr.checks.filter((c) => FAILED_CHECK_CONCLUSIONS.has((c.conclusion ?? '').toUpperCase()))
      let read = 0
      for (const check of failed) {
        if (!check.url || !parseActionsJobUrl(check.url)) continue
        if (read >= CHECK_LOGS_READ) {
          lines.push('', `More failed checks have logs; call again after fixing these, or read them with gh run view.`)
          break
        }
        read += 1
        try {
          const log = await prCheckLog(workspace, check.url)
          throwIfAborted(signal)
          const head = `Failing step of "${check.name}"${log.step ? ` (${log.step})` : ''}${log.truncated ? ', last lines' : ''}:`
          lines.push('', head, wrapUntrustedContent(log.excerpt || '(the job logged nothing)', { source: 'github', origin: check.url, kind: 'ci_log' }))
        } catch (err) {
          lines.push('', `Log of "${check.name}" could not be read: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return toolOk('github_pr_checks', `#${pr.number}`, lines.join('\n'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('github_pr_checks', summary, msg)
    }
  },
  github_issue: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const action = args.action as 'list' | 'view' | 'create'
    try {
      if (action === 'view') {
        const number = typeof args.number === 'number' ? args.number : 0
        if (!number) return toolFail('github_issue', 'view', 'number is required when action is view')
        const issue = await viewGithubIssue(workspace, number)
        throwIfAborted(signal)
        const text = [
          `#${issue.number} ${issue.title}`,
          `State: ${issue.state.toLowerCase()} · by ${issue.author}${issue.labels.length ? ` · labels: ${issue.labels.join(', ')}` : ''}`,
          issue.url,
          '',
          issue.body.trim() || '(no description)',
          ...(issue.commentCount > 0
            ? [
                '',
                `Comments (${issue.comments.length === issue.commentCount ? issue.commentCount : `latest ${issue.comments.length} of ${issue.commentCount}`}):`,
                ...issue.comments.map((c) => `--- ${c.author}${c.createdAt ? ` ${c.createdAt}` : ''}\n${c.body.trim()}`)
              ]
            : [])
        ].join('\n')
        return toolOk(
          'github_issue',
          `#${issue.number}`,
          wrapUntrustedContent(text, { source: 'github', origin: issue.url || `issue #${issue.number}`, kind: 'issue' })
        )
      }
      if (action === 'list') {
        const result = await listGithubIssues(workspace)
        throwIfAborted(signal)
        const lines = result.issues.map(
          (issue) => `#${issue.number} ${issue.state} ${issue.title} ${issue.url}`
        )
        return toolOk(
          'github_issue',
          'list',
          lines.length > 0 ? lines.join('\n') : 'No open issues.'
        )
      }
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      if (!title) return toolFail('github_issue', 'create', 'title is required when action is create')
      const result = await createGithubIssue(
        workspace,
        title,
        typeof args.body === 'string' ? args.body : undefined
      )
      throwIfAborted(signal)
      return toolOk('github_issue', result.url, `${result.detail}\n${result.url}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('github_issue', `gh issue ${action}`, msg)
    }
  }
} satisfies Partial<Record<AgentToolName, ToolHandler>>
