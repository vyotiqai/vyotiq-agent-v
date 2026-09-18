/**
 * Bakes the current release + its downloadable assets from the GitHub API.
 *
 * Installers live in the companion repo `vyotiqai/vyotiq-agent-v-releases`
 * (electron-builder.yml `publish:`), which is also the feed the in-app updater
 * reads. Asset URLs are never constructed from a filename pattern here — only
 * what the API actually returns is written out, so the download page cannot
 * render a button for a file that does not exist.
 *
 * When there is no published release the script writes an explicit empty state
 * rather than failing: the site then says so plainly instead of guessing.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const landing = join(here, '..')
const OWNER = 'vyotiqai'
const REPO = 'vyotiq-agent-v-releases'
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'vyotiq-landing-build',
  'X-GitHub-Api-Version': '2022-11-28'
}
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (token) headers.Authorization = `Bearer ${token}`

/**
 * Classify an asset by the platform and arch it installs on.
 *
 * Driven by the artifact name patterns declared in electron-builder.yml plus
 * electron-builder's own defaults for deb/rpm/zip. Anything unrecognised is
 * returned with platform `null` and is listed under "other files" rather than
 * silently dropped or mislabelled.
 */
function classify(name) {
  if (/\.blockmap$/i.test(name)) return { kind: 'blockmap' }
  if (/^latest.*\.yml$/i.test(name)) return { kind: 'feed' }

  if (/-setup\.exe$/i.test(name)) {
    return { kind: 'installer', platform: 'windows', arch: 'x64', format: 'exe', label: 'Installer (.exe)' }
  }
  if (/\.dmg$/i.test(name)) {
    const arch = /arm64/i.test(name) ? 'arm64' : 'x64'
    return { kind: 'installer', platform: 'macos', arch, format: 'dmg', label: 'Disk image (.dmg)' }
  }
  if (/mac\.zip$/i.test(name)) {
    const arch = /arm64/i.test(name) ? 'arm64' : 'x64'
    return { kind: 'installer', platform: 'macos', arch, format: 'zip', label: 'Archive (.zip)' }
  }
  if (/\.AppImage$/i.test(name)) {
    return { kind: 'installer', platform: 'linux', arch: 'x64', format: 'AppImage', label: 'AppImage' }
  }
  if (/\.deb$/i.test(name)) {
    return { kind: 'installer', platform: 'linux', arch: 'x64', format: 'deb', label: 'Debian package (.deb)' }
  }
  if (/\.rpm$/i.test(name)) {
    return { kind: 'installer', platform: 'linux', arch: 'x64', format: 'rpm', label: 'RPM package (.rpm)' }
  }
  return { kind: 'other' }
}

const empty = {
  source: 'none',
  fetchedAt: new Date().toISOString(),
  version: null,
  tag: null,
  publishedAt: null,
  htmlUrl: `https://github.com/${OWNER}/${REPO}/releases`,
  installers: [],
  feeds: [],
  other: []
}

async function main() {
  let res
  try {
    res = await fetch(API, { headers })
  } catch (err) {
    console.warn(`[bake-release] network error (${err.message}) — writing empty state`)
    return empty
  }

  if (res.status === 404) {
    console.warn('[bake-release] no published release yet — writing empty state')
    return empty
  }
  if (!res.ok) {
    // Rate limits and transient 5xx must not bake a false "no downloads"
    // claim into a production build, so fail loudly instead.
    console.error(`[bake-release] GitHub API returned ${res.status} ${res.statusText}`)
    process.exit(1)
  }

  const rel = await res.json()
  const installers = []
  const feeds = []
  const other = []

  for (const a of rel.assets ?? []) {
    const c = classify(a.name)
    const row = {
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
      downloadCount: a.download_count
    }
    if (c.kind === 'installer') installers.push({ ...row, ...c })
    else if (c.kind === 'feed') feeds.push(row)
    else if (c.kind === 'other') other.push(row)
    // blockmaps are updater plumbing and are deliberately not surfaced
  }

  const order = { windows: 0, macos: 1, linux: 2 }
  installers.sort(
    (a, b) => order[a.platform] - order[b.platform] || a.arch.localeCompare(b.arch) || a.format.localeCompare(b.format)
  )

  return {
    source: 'github',
    fetchedAt: new Date().toISOString(),
    version: String(rel.tag_name ?? '').replace(/^v/, '') || null,
    tag: rel.tag_name ?? null,
    publishedAt: rel.published_at ?? null,
    htmlUrl: rel.html_url,
    installers,
    feeds,
    other
  }
}

const data = await main()
mkdirSync(join(landing, 'src/data'), { recursive: true })
writeFileSync(join(landing, 'src/data/release.json'), JSON.stringify(data, null, 2) + '\n', 'utf8')

console.log(
  data.source === 'github'
    ? `[bake-release] ${data.tag} · ${data.installers.length} installers · ${data.feeds.length} update feeds`
    : '[bake-release] no release published — download page will render its empty state'
)
