/** Strip leading slash, lowercase, and normalize separators for matching. */
export function normalizeTrigger(raw: string): string {
  return raw
    .trim()
    .replace(/^\/+/, '')
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Collapse to alphanumeric-only key for fuzzy equality of triggers. */
export function triggerKey(raw: string): string {
  return normalizeTrigger(raw).replace(/[^a-z0-9]/g, '')
}

/** Turn snake_case / kebab-case tool or server ids into a short readable label. */
export function humanizeSlashToken(raw: string): string {
  const spaced = raw
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!spaced) return raw.trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}
