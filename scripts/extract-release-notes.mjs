#!/usr/bin/env node
/**
 * Extract one version's notes from CHANGELOG.md for a GitHub release body.
 *
 * The in-app update card parses release bodies as `## Heading` + `- bullet`
 * sections (src/shared/utils/releaseNotes.ts), while CHANGELOG.md uses
 * Keep-a-Changelog `### Subsection` headings inside a `## [X.Y.Z] - date`
 * block. This script converts the subsections of the requested version to
 * `## Heading` so the body matches the card's parser exactly.
 *
 * Usage:
 *   node scripts/extract-release-notes.mjs --version 1.2.0 [--out FILE] [--changelog PATH]
 *
 * Prints the markdown body to stdout (or writes it to --out). Exits 1 when the
 * version block is missing or contains no note content — a release must not
 * publish without notes, because the update card would render empty.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_CHANGELOG = path.join(REPO_ROOT, 'CHANGELOG.md')

function parseArgs(argv) {
  const args = { version: null, out: null, changelog: DEFAULT_CHANGELOG }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--version' || arg === '-v') {
      args.version = argv[(i += 1)] ?? null
    } else if (arg === '--out' || arg === '-o') {
      args.out = argv[(i += 1)] ?? null
    } else if (arg === '--changelog') {
      args.changelog = path.resolve(REPO_ROOT, argv[(i += 1)] ?? '')
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    }
  }
  return args
}

function fail(message) {
  console.error(`extract-release-notes: ${message}`)
  process.exit(1)
}

/**
 * Pull the body lines of `## [X.Y.Z] - date` up to the next `## [` block or
 * the next top-level `# ` heading. Returns [] when the version is absent.
 */
function extractVersionBlock(lines, version) {
  const start = lines.findIndex((line) =>
    /^##\s*\[\s*([^\]]+)\s*\]\s*-\s*/.test(line) &&
    line.match(/^##\s*\[\s*([^\]]+)\s*\]/)[1].trim() === version
  )
  if (start === -1) return null
  const block = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^##\s*\[/.test(line) || /^#\s+/.test(line)) break
    block.push(line)
  }
  return block
}

/**
 * Keep-a-Changelog block → release-body markdown. `### Sub` becomes `## Sub`
 * (the card's parser splits on `^## `); bullets and plain prose pass through;
 * subsections without bullets are dropped; link-reference footers and blank
 * runs are removed.
 */
function blockToReleaseBody(block) {
  const out = []
  let currentHasContent = false
  let lastHeadingIndex = -1

  for (const rawLine of block) {
    const line = rawLine.trimEnd()
    if (/^\[[^\]]+\]:\s*\S/.test(line)) continue

    const heading = /^###\s+(.+)$/.exec(line)
    if (heading) {
      if (!currentHasContent && lastHeadingIndex !== -1) {
        // Previous subsection had no bullets — drop it.
        out.splice(lastHeadingIndex, 1)
      }
      out.push(`## ${heading[1].trim()}`)
      lastHeadingIndex = out.length - 1
      currentHasContent = false
      continue
    }

    if (/^##\s+/.test(line)) {
      // Already-promoted heading (defensive) — treat like a subsection.
      if (!currentHasContent && lastHeadingIndex !== -1) out.splice(lastHeadingIndex, 1)
      out.push(line)
      lastHeadingIndex = out.length - 1
      currentHasContent = false
      continue
    }

    if (line.trim() === '') {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      continue
    }

    out.push(line)
    currentHasContent = true
  }
  if (!currentHasContent && lastHeadingIndex !== -1) out.splice(lastHeadingIndex, 1)

  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n').trim()
}

function hasNoteContent(body) {
  return /^[-*]\s+/m.test(body)
}

const args = parseArgs(process.argv.slice(2))

if (args.help || !args.version) {
  console.error('Usage: node scripts/extract-release-notes.mjs --version X.Y.Z [--out FILE] [--changelog PATH]')
  process.exit(args.help ? 0 : 1)
}

let changelogText
try {
  changelogText = readFileSync(args.changelog, 'utf8')
} catch (err) {
  fail(`cannot read ${args.changelog}: ${err instanceof Error ? err.message : String(err)}`)
}

const block = extractVersionBlock(changelogText.split(/\r?\n/), args.version)
if (block === null) {
  fail(`no "## [${args.version}]" entry found in ${args.changelog}. Add release notes to CHANGELOG.md before tagging — the in-app update card reads them.`)
}

const body = blockToReleaseBody(block)
if (!hasNoteContent(body)) {
  fail(`the "## [${args.version}]" entry in ${args.changelog} has no bullet content. The update card would render without "What's new".`)
}

if (args.out) {
  writeFileSync(args.out, `${body}\n`, 'utf8')
  console.log(`extract-release-notes: wrote ${body.length} chars to ${args.out}`)
} else {
  console.log(body)
}
