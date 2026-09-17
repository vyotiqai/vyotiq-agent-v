import type { AgentToolName } from '../schemas/tools'
import { toolGitStatusAsync, toolGitDiffAsync } from './gitHelpers'
import { toolApplyPatchAsync } from './applyPatch'
import { commitPaths } from '@main/git/git'
import { prCreate, reviewPullRequest, listGithubIssues, createGithubIssue } from '@main/git/gh'
import { readTrimmed } from './argAccess'
import { invalidateAfterWorkspaceMutation, throwIfAborted, toolOk, toolFail } from './index'
import type { ToolHandler } from './index'

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
  git_apply: async (workspace, args, signal) => {
    throwIfAborted(signal)
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
  github_issue: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const action = args.action as 'list' | 'create'
    try {
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
