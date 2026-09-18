/**
 * Bakes the release history from the GitHub API into the changelog page.
 *
 * There is no CHANGELOG file in this repo — releases are cut from tags and the
 * release body is the only authored note (see RELEASE-RUNBOOK.md). So the
 * changelog page is a view of real published releases, nothing more.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const landing = join(here, '..')
const OWNER = 'vyotiqai'
const REPO = 'vyotiq-agent-v-releases'

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'vyotiq-landing-build',
  'X-GitHub-Api-Version': '2022-11-28'
}
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
if (token) headers.Authorization = `Bearer ${token}`

let releases = []
try {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=100`, { headers })
  if (res.ok) {
    releases = await res.json()
  } else if (res.status === 404) {
    console.warn('[bake-changelog] releases repo has no releases — writing empty history')
  } else {
    console.error(`[bake-changelog] GitHub API returned ${res.status} ${res.statusText}`)
    process.exit(1)
  }
} catch (err) {
  console.warn(`[bake-changelog] network error (${err.message}) — writing empty history`)
}

const entries = releases
  .filter((r) => !r.draft)
  .map((r) => ({
    tag: r.tag_name,
    version: String(r.tag_name ?? '').replace(/^v/, ''),
    name: r.name || r.tag_name,
    publishedAt: r.published_at,
    prerelease: Boolean(r.prerelease),
    htmlUrl: r.html_url,
    body: (r.body ?? '').trim(),
    assetCount: (r.assets ?? []).filter((a) => !/\.blockmap$/i.test(a.name)).length
  }))
  .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))

const data = {
  fetchedAt: new Date().toISOString(),
  releasesUrl: `https://github.com/${OWNER}/${REPO}/releases`,
  entries
}

mkdirSync(join(landing, 'src/data'), { recursive: true })
writeFileSync(join(landing, 'src/data/changelog.json'), JSON.stringify(data, null, 2) + '\n', 'utf8')
console.log(`[bake-changelog] ${entries.length} published release(s)`)
