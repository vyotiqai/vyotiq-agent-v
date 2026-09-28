/**
 * Releases, read from the GitHub API at build time. The release body is the
 * changelog (the app's update panel reads the same text), so the Changelog and
 * Download pages are rebuilt from it on every deploy.
 *
 * In CI a failed fetch, or a repository with no published release, fails the
 * build: baking "no downloads" into the site is worse than not deploying.
 * Locally it warns and renders the pages without data.
 */
import { RELEASES_REPO } from '@/data/site'

export type Asset = { name: string; size: number; url: string }
export type Release = {
  version: string
  tag: string
  title: string
  date: string
  url: string
  body: string
  assets: Asset[]
}

type ApiRelease = {
  tag_name: string
  name: string | null
  published_at: string | null
  html_url: string
  body: string | null
  draft: boolean
  prerelease: boolean
  assets: { name: string; size: number; browser_download_url: string }[]
}

let cache: Promise<Release[]> | null = null

export function releases(): Promise<Release[]> {
  cache ??= load()
  return cache
}

export async function latestRelease(): Promise<Release | null> {
  return (await releases())[0] ?? null
}

export async function latestVersion(): Promise<string | null> {
  return (await latestRelease())?.version ?? null
}

async function load(): Promise<Release[]> {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  try {
    const res = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=100`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'vyotiq-site',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    })
    if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`)
    const list = (await res.json()) as ApiRelease[]
    const published = list
      .filter((r) => !r.draft && !r.prerelease && r.published_at)
      .map((r) => ({
        version: r.tag_name.replace(/^v/, ''),
        tag: r.tag_name,
        title: r.name ?? r.tag_name,
        date: r.published_at!,
        url: r.html_url,
        body: r.body ?? '',
        assets: r.assets.map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }))
      }))
      .sort((a, b) => b.date.localeCompare(a.date))
    // A reachable repository with nothing published is as bad as an
    // unreachable one: the Download page would link to a release that is not there.
    if (published.length === 0) throw new Error('GitHub releases: no published release')
    return published
  } catch (err) {
    if (process.env.CI) throw err
    console.warn(`[releases] ${err instanceof Error ? err.message : err}; building without release data`)
    return []
  }
}

/** One heading and its bullets, the only shapes the app's update panel reads. */
export type NoteSection = { heading: string; items: { claim: string; rest: string }[] }

/** The lede above the first heading, then `## Heading` / `- bullet` sections. */
export function parseNotes(body: string): { lede: string; sections: NoteSection[] } {
  const lede: string[] = []
  const sections: NoteSection[] = []
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    const heading = line.match(/^##\s+(.+)/)
    if (heading) {
      sections.push({ heading: heading[1].trim(), items: [] })
      continue
    }
    const bullet = line.match(/^[-*]\s+(.+)/)
    if (bullet && sections.length) {
      const text = bullet[1].trim()
      const bold = text.match(/^\*\*(.+?)\*\*[\s.:–-]*(.*)$/)
      sections[sections.length - 1].items.push(bold ? { claim: bold[1], rest: bold[2] } : { claim: '', rest: text })
      continue
    }
    if (!sections.length && line && !line.startsWith('#')) lede.push(line)
  }
  return { lede: lede.join(' '), sections }
}

export type Platform = 'windows' | 'mac-arm' | 'mac-intel' | 'appimage' | 'deb' | 'rpm'

/** Picks each platform's installer out of a release's assets by the builder's file names. */
export function installers(release: Release | null): Partial<Record<Platform, Asset>> {
  if (!release) return {}
  const find = (test: (n: string) => boolean) => release.assets.find((a) => test(a.name))
  return {
    windows: find((n) => /setup\.exe$/i.test(n)),
    'mac-arm': find((n) => /arm64\.dmg$/i.test(n)),
    'mac-intel': find((n) => /(x64|intel)\.dmg$/i.test(n)),
    appimage: find((n) => /\.AppImage$/.test(n)),
    deb: find((n) => /\.deb$/.test(n)),
    rpm: find((n) => /\.rpm$/.test(n))
  }
}

export const formatSize = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
