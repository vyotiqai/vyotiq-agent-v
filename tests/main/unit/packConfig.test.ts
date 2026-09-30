import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Pack-config invariants for electron-builder.yml + package.json.
 *
 * Three defects kept slipping back in, each invisible to a passing build:
 *   1. the leading catch-all in the `files:` matcher swept repo-root scratch
 *      (output/, .playwright-mcp/, file-list-all.txt, replay-report.json)
 *      into app.asar;
 *   2. a matcher left ignore-only gets that catch-all prepended by
 *      AppFileWalker and its file set unions with the others, so the
 *      win/mac/linux filters must repeat the same app exclusions;
 *   3. @sentry/react is renderer-only (vite bundles it into out/renderer), yet
 *      it sat in `dependencies` while its own node_modules copy is excluded
 *      from the pack.
 *
 * Parsed rather than grepped because a matcher silently reverting to
 * ignore-only is exactly the failure these rules exist to catch. No YAML
 * dependency: the file uses single-quoted scalars, so stripping comments and
 * collecting quoted items is enough.
 */

const ROOT = process.cwd()

function readYaml(): string {
  return readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
}

function readPkg(): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
}

/** Strip full-line comments (every comment in this file is its own line). */
function withoutComments(yaml: string): string[] {
  return yaml
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
}

/** Body of a top-level `key:` block: lines until the next unindented key. */
function topLevelBlock(yaml: string, key: string): string[] {
  const lines = withoutComments(yaml)
  const start = lines.findIndex((line) => line.startsWith(`${key}:`))
  expect(start, `top-level key "${key}:" missing from electron-builder.yml`).toBeGreaterThan(-1)
  const body: string[] = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) break
    body.push(line)
  }
  return body
}

/** Quoted list items in a YAML block, in order, with leading `- ` stripped. */
function quotedItems(lines: string[]): string[] {
  return lines.flatMap((line) => {
    const m = line.match(/^\s*-\s*'([^']*)'\s*$/)
    return m ? [m[1]!] : []
  })
}

/** The `filter:` list of a `- from: .` entry inside a platform block. */
function platformFilter(yaml: string, platform: string): string[] {
  const lines = topLevelBlock(yaml, platform)
  const from = lines.findIndex((line) => /^\s*-\s*from:\s*\.\s*$/.test(line))
  expect(from, `win/mac/linux files entry with "- from: ." missing in "${platform}:"`).toBeGreaterThan(-1)
  const filter: string[] = []
  for (let i = from + 1; i < lines.length; i += 1) {
    const line = lines[i]!
    if (/^\s*-\s*from:/.test(line)) break
    if (/^\s*filter:\s*$/.test(line)) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const item = lines[j]!
        if (!/^\s*-\s/.test(item)) break
        filter.push(item)
      }
      break
    }
  }
  return quotedItems(filter)
}

/** Expand `{a,b}` alternatives (one level, as used in this file). */
function expandBraces(pattern: string): string[] {
  const m = pattern.match(/\{([^{}]*)\}/)
  if (!m) return [pattern]
  const open = m.index ?? -1
  return m[1]!.split(',').flatMap((part) =>
    expandBraces(`${pattern.slice(0, open)}${part}${pattern.slice(open + m[0].length)}`)
  )
}

/** Minimal glob → regex: `**` spans separators, `*` and `?` do not. */
function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else out += '[^/]*'
    } else if (char === '?') out += '[^/]'
    else out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/** True when one of the matcher list's `!` entries excludes `path`. */
function isExcluded(items: string[], path: string): boolean {
  return items
    .filter((item) => item.startsWith('!'))
    .flatMap((item) => expandBraces(item.slice(1)))
    .some((pattern) => globToRegExp(pattern).test(path))
}

const SCRATCH = ['output/assets/app-dark.png', '.playwright-mcp/page-2026-09-26T18-07-07-056Z.yml', 'file-list-all.txt', 'replay-report.json']

/** performance.mdc: keep asar, unpack only what cannot live inside it. */
const ALLOWED_ASAR_UNPACK = ['resources/icon.*', '**/*.node', '**/node_modules/onnxruntime-node/bin/**']

describe('electron-builder.yml — asar policy', () => {
  it('ships the app inside asar', () => {
    expect(readYaml()).toMatch(/^asar: true\s*$/m)
  })

  it('unpacks exactly the three globs that cannot live in asar', () => {
    const unpack = quotedItems(topLevelBlock(readYaml(), 'asarUnpack'))
    expect(unpack).toEqual(ALLOWED_ASAR_UNPACK)
    // Bare '**' defeats the point of asar; @huggingface/transformers is JS/WASM.
    expect(unpack).not.toContain('**')
    expect(unpack.some((item) => item.includes('huggingface'))).toBe(false)
  })
})

describe('electron-builder.yml — repo-root scratch is never packed', () => {
  const yaml = readYaml()

  it('excludes every scratch root from the top-level files matcher', () => {
    const files = quotedItems(topLevelBlock(yaml, 'files'))
    expect(files).toContain('**/*')
    const missing = SCRATCH.filter((path) => !isExcluded(files, path))
    expect(missing).toEqual([])
  })

  for (const platform of ['win', 'mac', 'linux']) {
    it(`repeats the scratch exclusions in the ${platform} filter`, () => {
      const filter = platformFilter(yaml, platform)
      expect(filter.length).toBeGreaterThan(0)
      const missing = SCRATCH.filter((path) => !isExcluded(filter, path))
      expect(missing).toEqual([])
    })
  }
})

describe('package.json — renderer-only Sentry SDK', () => {
  it('keeps @sentry/react in devDependencies and @sentry/electron in dependencies', () => {
    const pkg = readPkg()
    expect(pkg.dependencies!['@sentry/react']).toBeUndefined()
    expect(pkg.devDependencies!['@sentry/react']).toBe('10.75.0')
    expect(pkg.dependencies!['@sentry/electron']).toBe('7.20.0')
    expect(pkg.devDependencies!['@sentry/electron']).toBeUndefined()
  })
})
