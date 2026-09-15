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
 *    must not go red because the releases API hiccuped or rate-limited; the
 *    warning surfaces in CI logs as ::warning::)
 *
 * Asset selection mirrors electron-builder.yml artifact names:
 *   win   → Vyotiq-<v>-setup.exe                (nsis.artifactName)
 *   mac   → Vyotiq-<v>-arm64.dmg / -x64.dmg     (dmg.artifactName ${arch})
 *   linux → Vyotiq-<v>.AppImage                 (appImage.artifactName)
 * A .deb asset is picked up when present (schema-ready; electron-builder.yml
 * has no deb target yet). Missing entries stay null and the UI falls back to
 * the release tag page — download URLs are never invented here.
 *
 * The releases live in the public vyotiqai/vyotiq-agent-v-releases repo, so
 * unauthenticated API access is enough; set GITHUB_TOKEN to raise the rate
 * limit if needed.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RELEASES_REPO = 'vyotiqai/vyotiq-agent-v-releases'
const RELEASES_API_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`

const FALLBACK_RELEASE = {
  source: 'fallback',
  version: null,
  url: `https://github.com/${RELEASES_REPO}/releases/latest`,
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

/** Normalize one GitHub asset into { name, url, size }, or null. */
function assetEntry(asset) {
  if (!asset || typeof asset !== 'object') return null
  return {
    name: typeof asset.name === 'string' ? asset.name : null,
    url: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : null,
    size: typeof asset.size === 'number' && Number.isFinite(asset.size) ? asset.size : null,
  }
}

function named(assets, test) {
  return assets.filter((a) => typeof a.name === 'string' && test(a.name))
}

function pickWindows(assets) {
  const exes = named(assets, (name) => /\.exe$/i.test(name))
  return assetEntry(exes.find((a) => a.name.endsWith('-setup.exe')) ?? exes[0])
}

function pickMacos(assets) {
  const dmgs = named(assets, (name) => /\.dmg$/i.test(name))
  const arm64 = dmgs.find((a) => /(?:-|_|\.)arm64\.dmg$/i.test(a.name) || /aarch64\.dmg$/i.test(a.name))
  const x64 = dmgs.find((a) => /(?:-|_|\.)x64\.dmg$/i.test(a.name) || /(?:x86_64|-intel)\.dmg$/i.test(a.name))
  if (!arm64 && !x64 && dmgs.length === 1) {
    // Single-arch release: offer the one DMG under both menu entries rather
    // than guessing an architecture label the filename doesn't carry.
    const only = assetEntry(dmgs[0])
    return { arm64: only, x64: only }
  }
  return { arm64: assetEntry(arm64), x64: assetEntry(x64) }
}

function pickLinux(assets) {
  const appimage = named(assets, (name) => /\.appimage$/i.test(name))[0]
  const deb = named(assets, (name) => /\.deb$/i.test(name))[0]
  return { appimage: assetEntry(appimage), deb: assetEntry(deb) }
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
          windows: pickWindows(assets),
          macos: pickMacos(assets),
          linux: pickLinux(assets),
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
