import type { GitChangedFile, GitStatus } from '@shared/ipc'

/** Shared default commit message for Changes panel (and any legacy callers). */
export function defaultCommitMessage(
  files: Array<Pick<GitChangedFile, 'path'> | { path: string }>,
  fileCount = files.length
): string {
  const first = files[0]
  if (fileCount === 1 && first) {
    const base = first.path.includes('/') ? first.path.slice(first.path.lastIndexOf('/') + 1) : first.path
    return `Update ${base}`
  }
  return `Update ${fileCount} files`
}

export function defaultCommitMessageFromStatus(status: GitStatus): string {
  return defaultCommitMessage(status.files, status.fileCount)
}
