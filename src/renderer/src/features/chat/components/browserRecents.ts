/** Persisted agent-browser visit history (renderer-only). */

export type BrowserRecent = {
  url: string
  title: string
  visitedAt: number
}

export const BROWSER_RECENTS_KEY = 'vyotiq.browserRecents'
const MAX_RECENTS = 100

export type RecentsGroup = {
  label: string
  items: BrowserRecent[]
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function loadBrowserRecents(): BrowserRecent[] {
  try {
    const raw = localStorage.getItem(BROWSER_RECENTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item): item is BrowserRecent =>
          Boolean(item) &&
          typeof item === 'object' &&
          typeof (item as BrowserRecent).url === 'string' &&
          typeof (item as BrowserRecent).visitedAt === 'number'
      )
      .map((item) => ({
        url: item.url,
        title: typeof item.title === 'string' ? item.title : '',
        visitedAt: item.visitedAt
      }))
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, MAX_RECENTS)
  } catch {
    return []
  }
}

export function saveBrowserRecents(items: BrowserRecent[]): void {
  try {
    localStorage.setItem(BROWSER_RECENTS_KEY, JSON.stringify(items.slice(0, MAX_RECENTS)))
  } catch {
    /* private mode / blocked storage */
  }
}

export function clearBrowserRecents(): void {
  try {
    localStorage.removeItem(BROWSER_RECENTS_KEY)
  } catch {
    /* ignore */
  }
}

/** Upsert by URL (most recent wins) and persist. */
export function recordBrowserVisit(url: string, title = ''): BrowserRecent[] {
  const trimmed = url.trim()
  if (!trimmed || trimmed === 'about:blank') return loadBrowserRecents()
  const next: BrowserRecent = {
    url: trimmed,
    title: title.trim(),
    visitedAt: Date.now()
  }
  const prev = loadBrowserRecents().filter((item) => item.url !== trimmed)
  const items = [next, ...prev].slice(0, MAX_RECENTS)
  saveBrowserRecents(items)
  return items
}

export function groupBrowserRecents(items: BrowserRecent[]): RecentsGroup[] {
  const now = new Date()
  const todayStart = startOfDay(now)
  const yesterdayStart = todayStart - 86_400_000
  const weekStart = todayStart - 7 * 86_400_000

  const buckets: Record<string, BrowserRecent[]> = {
    Today: [],
    Yesterday: [],
    'Last 7 days': [],
    Older: []
  }

  for (const item of items) {
    if (item.visitedAt >= todayStart) buckets.Today!.push(item)
    else if (item.visitedAt >= yesterdayStart) buckets.Yesterday!.push(item)
    else if (item.visitedAt >= weekStart) buckets['Last 7 days']!.push(item)
    else buckets.Older!.push(item)
  }

  return (['Today', 'Yesterday', 'Last 7 days', 'Older'] as const)
    .map((label) => ({ label, items: buckets[label]! }))
    .filter((group) => group.items.length > 0)
}

export function filterBrowserRecents(items: BrowserRecent[], query: string): BrowserRecent[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter(
    (item) => item.url.toLowerCase().includes(q) || item.title.toLowerCase().includes(q)
  )
}
