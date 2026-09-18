/**
 * Bakes every product fact the site states out of the repo sources that own it.
 *
 * Nothing here is transcribed by hand: tool names come from TOOL_REGISTRY,
 * providers from PROVIDER_DEFAULTS, extensions from the marketplace catalog,
 * packaging targets from electron-builder.yml. Every extraction asserts what it
 * found, so a refactor that moves or renames a source breaks the build instead
 * of quietly shipping a stale or empty claim on the website.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const landing = join(here, '..')
const repo = join(landing, '..')

const read = (p) => readFileSync(join(repo, p), 'utf8')
const fail = (msg) => {
  console.error(`[bake-app-data] ${msg}`)
  process.exit(1)
}

/* ---------------------------------------------------------------- tools --- */

// TOOL_REGISTRY is an object literal; its direct keys are the tool names the
// agent can call. Walk the braces to find the literal's exact extent so nested
// schema keys can never leak into the list.
function extractTools() {
  const src = read('src/main/agent/schemas/tools.ts')
  const start = src.indexOf('export const TOOL_REGISTRY = {')
  if (start === -1) fail('TOOL_REGISTRY not found in src/main/agent/schemas/tools.ts')

  const open = src.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) fail('TOOL_REGISTRY literal is unbalanced')

  const body = src.slice(open + 1, end)
  // Direct members sit at exactly two spaces of indentation.
  const names = [...body.matchAll(/^ {2}([a-z][a-z0-9_]*): \{$/gm)].map((m) => m[1])
  if (names.length < 40) fail(`extracted only ${names.length} tools — the registry shape changed`)
  if (new Set(names).size !== names.length) fail('duplicate tool names extracted')
  return names
}

/* ------------------------------------------------------------ providers --- */

function extractProviders() {
  const src = read('src/shared/domain/providers.ts')
  const start = src.indexOf('export const PROVIDER_DEFAULTS')
  if (start === -1) fail('PROVIDER_DEFAULTS not found in src/shared/domain/providers.ts')
  const block = src.slice(start, src.indexOf('\n]', start))
  const rows = [...block.matchAll(/\{ id: '([^']+)', label: '([^']+)'/g)].map((m) => ({
    id: m[1],
    label: m[2]
  }))
  if (rows.length < 8) {
    fail(`extracted only ${rows.length} providers — PROVIDER_DEFAULTS shape changed`)
  }
  return rows
}

// Only claim "no API key needed" for providers the app's own predicate exempts.
function extractKeyless() {
  const src = read('src/shared/domain/providers.ts')
  if (!src.includes('providerNeedsKey')) {
    fail('providerNeedsKey not found — the keyless claim is unverifiable')
  }
  const keyless = []
  if (/providerNeedsKey[\s\S]{0,600}?ollama/.test(src)) keyless.push('ollama')
  return keyless
}

/* ----------------------------------------------------------- extensions --- */

function extractExtensions() {
  const catalog = JSON.parse(read('resources/marketplace/catalog.json'))
  const packages = catalog.packages
  if (!Array.isArray(packages) || packages.length === 0) fail('marketplace catalog has no packages')

  const counts = { mcp: 0, skill: 0, plugin: 0 }
  for (const p of packages) {
    if (!(p.kind in counts)) fail(`unknown package kind "${p.kind}" on ${p.id}`)
    counts[p.kind]++
  }

  // Only surface icons that actually exist on disk, so the site can never
  // render a broken image for a package it lists.
  const list = packages.map((p) => {
    const iconOk = p.iconPath && existsSync(join(repo, 'resources/marketplace', p.iconPath))
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      kind: p.kind,
      category: p.category,
      publisher: p.publisher ?? null,
      verified: Boolean(p.verified),
      auth: p.auth ?? 'none',
      featured: (p.sections ?? []).includes('featured'),
      featuredRank: p.featuredRank ?? null,
      icon: iconOk ? p.iconPath.replace(/^icons\//, '') : null
    }
  })

  return { total: packages.length, counts, list }
}

/* ------------------------------------------------------------ packaging --- */

// electron-builder.yml is the source of truth for what gets built. Rather than
// depend on a YAML parser, assert that every target this site names is really
// configured there, and read the signing posture off the same file.
function extractPackaging() {
  const yml = read('electron-builder.yml')
  for (const target of ['nsis', 'dmg', 'zip', 'AppImage', 'deb', 'rpm']) {
    if (!new RegExp(`(^|\\s|-\\s*)${target}\\b`, 'm').test(yml)) {
      fail(`target "${target}" is no longer configured in electron-builder.yml`)
    }
  }

  const releaseYml = read('.github/workflows/release.yml')
  if (!/--mac\s+--arm64\s+--x64/.test(releaseYml)) {
    fail('release.yml no longer builds macOS arm64 + x64 — the download arch split would be wrong')
  }
  if (!/win32[/-]arm64/.test(yml)) {
    fail('electron-builder.yml no longer excludes win32-arm64 prebuilds — re-check the Windows arch claim')
  }

  const productName = yml.match(/^productName:\s*(\S+)/m)?.[1]
  const appId = yml.match(/^appId:\s*(\S+)/m)?.[1]
  if (!productName || !appId) fail('productName / appId missing from electron-builder.yml')

  // Signing posture is stated on the download page rather than hidden, because
  // it is what users actually hit on first launch.
  const macNotarized = !/^\s*notarize:\s*false\s*$/m.test(yml)
  const winSigned = /certificateFile|azureSignOptions|^\s*sign:/m.test(yml)

  return {
    productName,
    appId,
    platforms: [
      { os: 'windows', label: 'Windows', arches: ['x64'], formats: ['nsis'] },
      { os: 'macos', label: 'macOS', arches: ['arm64', 'x64'], formats: ['dmg', 'zip'] },
      { os: 'linux', label: 'Linux', arches: ['x64'], formats: ['AppImage', 'deb', 'rpm'] }
    ],
    signing: {
      windows: winSigned ? 'signed' : 'unsigned',
      macos: macNotarized ? 'notarized' : 'not-notarized'
    }
  }
}

/* ----------------------------------------------------------------- main --- */

const pkg = JSON.parse(read('package.json'))

const tools = extractTools()
const providers = extractProviders()
const extensions = extractExtensions()
const packaging = extractPackaging()

const data = {
  generatedAt: new Date().toISOString(),
  version: pkg.version,
  license: pkg.license,
  node: pkg.engines?.node ?? null,
  electron: pkg.devDependencies?.electron?.replace(/^[\^~]/, '') ?? null,
  repo: {
    source: 'https://github.com/vyotiqai/vyotiq-agent-v',
    releases: 'https://github.com/vyotiqai/vyotiq-agent-v-releases',
    issues: pkg.bugs?.url ?? null
  },
  packaging,
  tools: { total: tools.length, names: tools },
  providers: { total: providers.length, list: providers, keyless: extractKeyless() },
  extensions
}

mkdirSync(join(landing, 'src/data'), { recursive: true })
writeFileSync(join(landing, 'src/data/app.json'), JSON.stringify(data, null, 2) + '\n', 'utf8')

console.log(
  `[bake-app-data] v${data.version} · ${tools.length} tools · ${providers.length} providers · ` +
    `${extensions.total} extensions ` +
    `(${extensions.counts.mcp} mcp / ${extensions.counts.skill} skills / ${extensions.counts.plugin} plugins) · ` +
    `win=${packaging.signing.windows} mac=${packaging.signing.macos}`
)
