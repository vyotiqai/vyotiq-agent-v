/**
 * Normalize `git rev-parse --abbrev-ref HEAD` output.
 * Detached HEAD returns the literal `HEAD`, which is not a branch name.
 */
export function namedGitBranch(abbrevRef: string | null | undefined): string | null {
  const branch = abbrevRef?.trim() || null
  if (!branch || branch === 'HEAD') return null
  return branch
}
