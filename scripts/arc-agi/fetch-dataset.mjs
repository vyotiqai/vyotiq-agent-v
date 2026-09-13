#!/usr/bin/env node
/**
 * ARC-AGI dataset fetcher (Wave 1).
 *
 * Downloads the public ARC-AGI dataset (fchollet/ARC-AGI, Apache-2.0) from
 * raw.githubusercontent.com into a local cache dir:
 *   data/training/*.json  -> <cache>/training/*.json
 *   data/evaluation/*.json -> <cache>/evaluation/*.json
 *
 * Cache dir resolution:
 *   1. $VYOTIQ_ARC_DATA_DIR if set
 *   2. test-results/arc-agi/  if `git check-ignore` confirms it is ignored
 *   3. .vyotiq/cache/arc-agi/ if `git check-ignore` confirms it is ignored
 *   4. .vyotiq/cache/arc-agi/ created anyway (reported as untracked-but-visible)
 *
 * Idempotent: files already on disk are skipped, never re-downloaded.
 * Never fabricates fixtures: any HTTP/network failure exits non-zero with the
 * real error. No dependencies beyond Node >= 22 (global fetch, node:fs).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'fchollet/ARC-AGI'
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/master`
const API_BASE = `https://api.github.com/repos/${REPO}/contents`
const SPLITS = ['training', 'evaluation']

const scriptDir = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(scriptDir, '..', '..')

/** Run `git check-ignore -v <path>`; returns true when git says the path is ignored. */
function isGitIgnored(relPath) {
  const result = spawnSync('git', ['check-ignore', '-v', relPath], {
    cwd: workspaceRoot,
    encoding: 'utf8'
  })
  // exit 0 = ignored (match details on stdout), exit 1 = not ignored
  return result.status === 0 && (result.stdout ?? '').trim().length > 0
}

function resolveCacheDir() {
  const envDir = process.env.VYOTIQ_ARC_DATA_DIR
  if (envDir) {
    console.log(`[arc-agi] cache dir from VYOTIQ_ARC_DATA_DIR: ${envDir}`)
    return resolve(envDir)
  }
  for (const candidate of ['test-results/arc-agi', '.vyotiq/cache/arc-agi']) {
    if (isGitIgnored(candidate)) {
      console.log(`[arc-agi] cache dir (git-ignored per check-ignore): ${candidate}`)
      return resolve(workspaceRoot, candidate)
    }
  }
  const fallback = resolve(workspaceRoot, '.vyotiq/cache/arc-agi')
  mkdirSync(fallback, { recursive: true })
  console.warn(
    `[arc-agi] WARNING: neither test-results/arc-agi/ nor .vyotiq/cache/arc-agi/ is git-ignored; ` +
      `using ${fallback} (untracked-but-visible — add it to .gitignore)`
  )
  return fallback
}

async function listSplitFiles(split) {
  const url = `${API_BASE}/data/${split}`
  const response = await fetch(url, {
    headers: { 'User-Agent': 'vyotiq-arc-agi-fetcher', Accept: 'application/vnd.github+json' }
  })
  if (!response.ok) {
    throw new Error(`GitHub API ${url} failed: HTTP ${response.status} ${response.statusText}`)
  }
  const entries = await response.json()
  if (!Array.isArray(entries)) {
    throw new Error(`GitHub API ${url} returned unexpected payload (not a file list)`)
  }
  return entries
    .filter((e) => e.type === 'file' && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort()
}

async function downloadFile(split, name) {
  const url = `${RAW_BASE}/data/${split}/${name}`
  const response = await fetch(url, { headers: { 'User-Agent': 'vyotiq-arc-agi-fetcher' } })
  if (!response.ok) {
    throw new Error(`GET ${url} failed: HTTP ${response.status} ${response.statusText}`)
  }
  return response.arrayBuffer()
}

async function main() {
  const cacheDir = resolveCacheDir()
  const counts = { written: 0, skipped: 0 }

  for (const split of SPLITS) {
    const outDir = join(cacheDir, split)
    mkdirSync(outDir, { recursive: true })

    const names = await listSplitFiles(split)
    if (names.length === 0) {
      throw new Error(`data/${split} listing came back empty for ${REPO} — refusing to continue`)
    }
    console.log(`[arc-agi] data/${split}: ${names.length} JSON files in repo listing`)

    for (const name of names) {
      const outPath = join(outDir, name)
      if (existsSync(outPath)) {
        counts.skipped++
        continue
      }
      const body = await downloadFile(split, name)
      await writeFile(outPath, Buffer.from(body))
      counts.written++
    }
  }

  console.log(
    `[arc-agi] done: ${counts.written} files written, ${counts.skipped} already present (skipped) -> ${cacheDir}`
  )
}

main().catch((err) => {
  console.error(`[arc-agi] FATAL: dataset fetch failed — ${err?.stack ?? err}`)
  process.exit(1)
})
