/**
 * Normalize `git rev-parse --abbrev-ref HEAD` output.
 * Detached HEAD returns the literal `HEAD`, which is not a branch name.
 */
export function namedGitBranch(abbrevRef: string | null | undefined): string | null {
  const branch = abbrevRef?.trim() || null
  if (!branch || branch === 'HEAD') return null
  return branch
}

/**
 * Why `name` cannot be a new branch, or null when it can — git's
 * `check-ref-format --branch` rules, said in words, so the field can answer
 * while it is typed. Main still asks git itself before creating anything.
 */
export function branchNameProblem(raw: string): string | null {
  const name = raw.trim()
  if (!name) return 'Name the branch'
  if (name.startsWith('-')) return 'A branch name can’t start with -'
  if (name === 'HEAD' || name === '@') return `“${name}” is reserved`
  // eslint-disable-next-line no-control-regex
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)) return 'No spaces or ~ ^ : ? * [ \\'
  if (name.includes('..')) return 'No “..” in a branch name'
  if (name.includes('@{')) return 'No “@{” in a branch name'
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return 'Slashes go between words'
  if (name.endsWith('.')) return 'A branch name can’t end with .'
  if (name.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) {
    return 'No part can start with . or end with .lock'
  }
  return null
}
