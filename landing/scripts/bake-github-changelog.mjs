#!/usr/bin/env node
/**
 * Bake every published GitHub release of the companion releases repo into
 * landing/src/data/changelog.json.
 *
 * Invoked by landing's `build` script right after bake-github-release.mjs
 * and ahead of `astro build`. The Changelog page reads the baked JSON to
 * list every release with its notes and links, instead of hand-maintained
 * markdown.
 *
 * Behaviour:
 *  - Releases found       → write { source: "github", releases: [...] } in
 *    API order (newest first)
 *  - No release (404/[])  → warning + explicit fallback data, exit 0
 *    (expected before the first publish; the workflow has no
 *    continue-on-error)
 *  - Any other failure    → warning + fallback data, exit 0 (a landing
 *    deploy must not go red because the releases API hiccuped or
 *    rate-limited; the warning surfaces in CI logs as ::warning::)
 *
 * The releases live in the public vyotiqai/vyotiq-agent-v-releases repo, so
 * unauthenticated API access is enough; set GITHUB_TOKEN to raise the rate
 * limit if needed.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RELEASES_REPO = 'vyotiqai/vyotiq-agent-v-releases'
const RELEASES_API_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=100`

const FALLBACK_CHANGELOG = {
  source: 'fallback',
  releases: [],
}

const OUTPUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'data',
  'changelog.json',
)

function warn(message) {
  const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::warning::' : 'warning: '
  console.warn(`${prefix}bake-github-changelog: ${message}`)
}

function releaseEntry(release) {
  return {
    version: typeof release.name === 'string' && release.name ? release.name : release.tag_name,
    tag: typeof release.tag_name === 'string' ? release.tag_name : null,
    url: typeof release.html_url === 'string' ? release.html_url : null,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    prerelease: Boolean(release.prerelease),
    body: typeof release.body === 'string' ? release.body : '',
  }
}

async function main() {
  let data = FALLBACK_CHANGELOG

  try {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'vyotiq-bake-github-changelog',
    }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

    const res = await fetch(RELEASES_API_URL, { headers })

    if (res.status === 404) {
      warn('no releases published yet in vyotiqai/vyotiq-agent-v-releases (404) — writing fallback changelog')
    } else if (!res.ok) {
      warn(`GitHub API returned ${res.status} ${res.statusText} — writing fallback changelog`)
    } else {
      const releases = await res.json()
      if (!Array.isArray(releases) || releases.length === 0) {
        warn('no releases published yet in vyotiqai/vyotiq-agent-v-releases — writing fallback changelog')
      } else {
        data = {
          source: 'github',
          releases: releases.map(releaseEntry),
        }
        console.log(`bake-github-changelog: baked ${data.releases.length} release${data.releases.length === 1 ? '' : 's'}`)
      }
    }
  } catch (err) {
    warn(`releases fetch failed: ${err instanceof Error ? err.message : String(err)} — writing fallback changelog`)
  }

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  console.log(`bake-github-changelog: wrote ${OUTPUT_PATH}`)
}

await main()
