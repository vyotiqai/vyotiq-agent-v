export type GithubReleaseEntry = {
  tag: string
  version: string
  htmlUrl: string
  publishedAt: string
  body: string
}

const bakedModules = import.meta.glob('./github-releases.json', { eager: true }) as Record<
  string,
  GithubReleaseEntry[] | { default: GithubReleaseEntry[] }
>

function sanitizeEntry(value: unknown): GithubReleaseEntry | null {
  if (value == null || typeof value !== 'object') return null
  const entry = value as Partial<GithubReleaseEntry>
  if (typeof entry.tag !== 'string' || !entry.tag.trim()) return null
  if (typeof entry.version !== 'string' || !entry.version.trim()) return null
  if (typeof entry.htmlUrl !== 'string' || !entry.htmlUrl.startsWith('https://')) return null
  if (typeof entry.body !== 'string' || !entry.body.trim()) return null
  return {
    tag: entry.tag.trim(),
    version: entry.version.trim(),
    htmlUrl: entry.htmlUrl,
    publishedAt: typeof entry.publishedAt === 'string' ? entry.publishedAt : '',
    body: entry.body
  }
}

function unwrap(
  mod: GithubReleaseEntry[] | { default: GithubReleaseEntry[] } | undefined
): GithubReleaseEntry[] {
  const value = mod == null ? [] : 'default' in mod && mod.default ? mod.default : mod
  if (!Array.isArray(value)) return []
  return value
    .map(sanitizeEntry)
    .filter((entry): entry is GithubReleaseEntry => entry != null)
}

export const githubReleases: GithubReleaseEntry[] = unwrap(
  Object.values(bakedModules)[0]
)
