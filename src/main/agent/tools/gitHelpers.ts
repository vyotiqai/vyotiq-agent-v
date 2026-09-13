import { readGitDiff } from '../../git/git'
import { readGitStatusCached } from '../../git/gitStatusCache'

export async function toolGitStatusAsync(workspace: string): Promise<string> {
  const result = await readGitStatusCached(workspace)
  if (result.kind === 'unavailable') return result.detail
  if (result.kind === 'not_repo') return 'Not a git repository'
  const status = result.status
  const lines = [
    `branch: ${status.branch ?? '(detached)'}`,
    `commits: ${status.hasCommits ? 'yes' : 'no'}`,
    `remote: ${status.hasRemote ? 'yes' : 'no'}`,
    `files: ${status.fileCount}${status.truncated ? ' (truncated)' : ''}`,
    `+${status.added} -${status.removed}`,
    ''
  ]
  for (const f of status.files) {
    lines.push(`${f.status.padEnd(10)} +${f.added} -${f.removed}  ${f.path}`)
  }
  if (status.files.length === 0) lines.push('(clean)')
  return lines.join('\n')
}

export async function toolGitDiffAsync(
  workspace: string,
  opts: { path?: string; staged?: boolean }
): Promise<{ ok: boolean; content: string }> {
  const result = await readGitDiff(workspace, opts)
  if (!result.ok) return { ok: false, content: result.error }
  return { ok: true, content: result.content }
}
