/**
 * Allowlist git clone targets for marketplace installs.
 * Rejects file://, ext::, http:, git:, and bare local paths that could turn install into arbitrary I/O.
 */
export function assertSafeGitCloneUrl(target: string): string {
  const t = target.trim()
  if (!t) throw new Error('Git clone URL is required')
  const lower = t.toLowerCase()
  if (lower.startsWith('file:') || lower.startsWith('ext::') || lower.startsWith('ext:')) {
    throw new Error('Git clone URL scheme is not allowed (file/ext)')
  }
  // SCP-like: git@host:path or user@host:path (no scheme)
  if (/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+[:/]/.test(t) && !t.includes('://')) {
    return t
  }
  let parsed: URL
  try {
    parsed = new URL(t)
  } catch {
    throw new Error('Git clone URL must be https://, ssh://, or git@host:path')
  }
  const protocol = parsed.protocol.toLowerCase()
  if (protocol !== 'https:' && protocol !== 'ssh:') {
    throw new Error(`Git clone URL scheme not allowed: ${parsed.protocol}`)
  }
  return t
}
