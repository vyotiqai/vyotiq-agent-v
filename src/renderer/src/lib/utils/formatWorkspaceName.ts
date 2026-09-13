/** Last path segment for display; drive roots and empty paths use fallback. */
export function formatWorkspaceName(path: string | null, fallback = 'No workspace'): string {
  if (!path?.trim()) return fallback
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
  const base = parts[parts.length - 1] ?? ''
  if (!base || /^[a-zA-Z]:$/.test(base) || base.toLowerCase() === 'this pc') {
    return fallback
  }
  return base
}
