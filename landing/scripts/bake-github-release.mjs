#!/usr/bin/env node
/**
 * Bake the current GitHub release download data into landing/src/data/release.json.
 *
 * Invoked by .github/workflows/deploy-landing.yml (working-directory: landing)
 * and by landing's `build` script, ahead of `astro build`. Hero and Nav read
 * the baked JSON to point their Download buttons at real installers instead
 * of the build-from-source anchor.
 *
 * Behaviour:
 *  - Release found    → write { source: "github", version, url, publishedAt, assets }
 *  - No release (404) → warning + explicit fallback data, exit 0 (expected
 *    before the first publish; the workflow has no continue-on-error)
 *  - Any other failure → warning + fallback data, exit 0 (a landing deploy
 *    must not go red because the releases API hiccuped; the warning surfaces
 *    in CI logs as ::warning::)
 *
 * The releases live in the public vyotiqai/vyotiq-agent-v-releases repo, so
 * unauthenticated API access is enough; set GITHUB_TOKEN to raise the rate
 * limit if needed.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RELEASES_API_URL =
  'https://api.github.com/repos/vyotiqai/vyotiq-agent-v-releases/releases/latest'

const FALLBACK_RELEASE = {
  source: 'fallback',
  version: null,
  url: 'https://github.com/vyotiqai/vyotiq-agent-v-releases/releases/latest',
  publishedAt: null,
  assets: { windows: null, macos: null, linux: null },
}

const OUTPUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'data',
  'release.json',
)

function warn(message) {
  const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::warning::' : 'warning: '
  console.warn(`${prefix}bake-github-release: ${message}`)
}

function pickAsset(assets, suffix) {
  const match = assets.find((asset) => typeof asset.name === 'string' && asset.name.endsWith(suffix))
  return match ? match.browser_download_url : null
}

async function main() {
  let data = FALLBACK_RELEASE

  try {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'vyotiq-bake-github-release',
    }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

    const res = await fetch(RELEASES_API_URL, { headers })

    if (res.status === 404) {
      warn('no release published yet in vyotiqai/vyotiq-agent-v-releases (404) — writing fallback download links')
    } else if (!res.ok) {
      warn(`GitHub API returned ${res.status} ${res.statusText} — writing fallback download links`)
    } else {
      const release = await res.json()
      const assets = Array.isArray(release.assets) ? release.assets : []
      data = {
        source: 'github',
        version: typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : null,
        url: typeof release.html_url === 'string' ? release.html_url : FALLBACK_RELEASE.url,
        publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
        assets: {
          windows: pickAsset(assets, '-setup.exe'),
          macos: pickAsset(assets, '.dmg'),
          linux: pickAsset(assets, '.AppImage'),
        },
      }
      console.log(`bake-github-release: baked release ${data.version} (${data.url})`)
    }
  } catch (err) {
    warn(`release fetch failed: ${err instanceof Error ? err.message : String(err)} — writing fallback download links`)
  }

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  console.log(`bake-github-release: wrote ${OUTPUT_PATH}`)
}

await main()
