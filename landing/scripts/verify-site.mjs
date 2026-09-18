/**
 * Post-build assertions over landing/dist.
 *
 * The site makes factual claims about a product and links to real installers,
 * so the build is not considered done until these pass. Everything here is
 * checked against the emitted HTML — not against the source that produced it.
 *
 *   node scripts/verify-site.mjs            static checks only
 *   node scripts/verify-site.mjs --network  also HEAD every external URL
 *
 * Exits non-zero on the first category of failure, printing every instance.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const landing = join(here, '..')
const dist = join(landing, 'dist')

const NETWORK = process.argv.includes('--network')
const SITE_ORIGIN = 'https://vyotiq.com'

const failures = []
const fail = (category, detail) => failures.push(`${category}: ${detail}`)
const ok = (msg) => console.log(`  ✓ ${msg}`)

if (!existsSync(dist)) {
  console.error('[verify-site] landing/dist does not exist — run the build first')
  process.exit(1)
}

/* ---------------------------------------------------------------- walk --- */

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const files = walk(dist)
const htmlFiles = files.filter((f) => f.endsWith('.html'))
const distPaths = new Set(files.map((f) => '/' + relative(dist, f).replaceAll('\\', '/')))

console.log(`[verify-site] ${htmlFiles.length} pages, ${files.length} files in dist\n`)

/* ------------------------------------------------------- expected routes --- */

// Mirrors ROUTES in src/lib/site.ts. Kept here as an independent list so a
// mistake in one is caught by the other rather than agreeing with itself.
const EXPECTED_ROUTES = [
  '/',
  '/features',
  '/extensions',
  '/download',
  '/docs',
  '/changelog',
  '/license',
  '/notice',
  '/privacy',
  '/terms',
  '/security',
  '/contributing',
  '/code-of-conduct'
]

const routeToFile = (route) => (route === '/' ? '/index.html' : `${route}/index.html`)

console.log('Routes')
for (const route of EXPECTED_ROUTES) {
  if (!distPaths.has(routeToFile(route))) fail('missing route', route)
}
if (!distPaths.has('/404.html')) fail('missing route', '/404 (404.html)')
if (failures.length === 0) ok(`all ${EXPECTED_ROUTES.length} routes + 404 emitted`)

/* --------------------------------------------------------- placeholders --- */

// Substrings that would mean unfinished or invented copy shipped.
const BANNED = [
  'lorem ipsum',
  'TODO',
  'FIXME',
  'example.com',
  'your-company',
  'Coming soon',
  'placeholder',
  'undefined',
  'NaN',
  '[object Object]'
]

console.log('\nContent')
let placeholderHits = 0
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8')
  const route = '/' + relative(dist, file).replaceAll('\\', '/')
  for (const needle of BANNED) {
    // Case-sensitive for the code-ish ones, insensitive for the prose ones.
    const found =
      needle === needle.toLowerCase()
        ? html.toLowerCase().includes(needle)
        : html.includes(needle)
    if (found) {
      fail('placeholder text', `"${needle}" in ${route}`)
      placeholderHits++
    }
  }
}
if (placeholderHits === 0) ok('no placeholder or unfinished copy')

/* ------------------------------------------------------- head/meta rules --- */

let metaProblems = 0
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8')
  const route = '/' + relative(dist, file).replaceAll('\\', '/')

  const title = html.match(/<title>([^<]*)<\/title>/)?.[1]?.trim()
  if (!title) {
    fail('meta', `no <title> on ${route}`)
    metaProblems++
  }

  const desc = html.match(/<meta name="description" content="([^"]*)"/)?.[1]?.trim()
  if (!desc) {
    fail('meta', `no meta description on ${route}`)
    metaProblems++
  }

  // 404 is intentionally excluded from canonical/indexing expectations.
  if (route !== '/404.html' && !/<link rel="canonical" href="https:\/\/vyotiq\.com/.test(html)) {
    fail('meta', `no canonical on ${route}`)
    metaProblems++
  }

  if (!/<meta property="og:image" content="https:\/\/vyotiq\.com/.test(html)) {
    fail('meta', `no og:image on ${route}`)
    metaProblems++
  }
}
if (metaProblems === 0) ok('every page has title, description, canonical and og:image')

/* ------------------------------------------------------- third-party JS --- */

// The privacy policy states the site loads no third-party scripts. Prove it.
let thirdParty = 0
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8')
  const route = '/' + relative(dist, file).replaceAll('\\', '/')
  for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    const src = m[1]
    if (/^https?:\/\//.test(src) || src.startsWith('//')) {
      fail('third-party script', `${src} on ${route}`)
      thirdParty++
    }
  }
}
if (thirdParty === 0) ok('no third-party scripts (privacy policy claim holds)')

/* ------------------------------------------------------- internal links --- */

const externals = new Set()
let internalBroken = 0

for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8')
  const route = '/' + relative(dist, file).replaceAll('\\', '/')

  const refs = [
    ...[...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1])
  ]

  for (const raw of refs) {
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('data:')) continue

    if (/^https?:\/\//.test(raw)) {
      // Canonical and og:url point at this site's own origin. Resolve those
      // against dist instead of over the network: the domain may not be
      // deployed yet, and what matters is that the route exists.
      if (raw.startsWith(SITE_ORIGIN)) {
        const ownPath = raw.slice(SITE_ORIGIN.length).split('#')[0] || '/'
        const target = ownPath === '/' ? '/index.html' : `${ownPath.replace(/\/$/, '')}/index.html`
        if (!distPaths.has(target) && !distPaths.has(ownPath)) {
          fail('broken self link', `${raw} on ${route}`)
          internalBroken++
        }
        continue
      }
      externals.add(raw.split('#')[0])
      continue
    }

    const clean = raw.split('#')[0].split('?')[0]
    if (!clean) continue

    const abs = clean.startsWith('/')
      ? clean
      : '/' + relative(dist, resolve(dirname(file), clean)).replaceAll('\\', '/')

    const candidates = [abs, `${abs}/index.html`, `${abs}index.html`, abs.replace(/\/$/, '/index.html')]
    if (!candidates.some((c) => distPaths.has(c))) {
      fail('broken internal link', `${raw} on ${route}`)
      internalBroken++
    }
  }
}
if (internalBroken === 0) ok(`every internal link and image resolves to an emitted file`)

/* ------------------------------------------------------------ downloads --- */

const release = JSON.parse(readFileSync(join(landing, 'src/data/release.json'), 'utf8'))
const RELEASE_HOST_PREFIX = 'https://github.com/vyotiqai/vyotiq-agent-v-releases/'

console.log('\nDownloads')
if (release.source !== 'github') {
  ok('no release published — download page renders its empty state (checked below)')
  const dl = readFileSync(join(dist, 'download/index.html'), 'utf8')
  if (!/No release is published yet/.test(dl)) {
    fail('download page', 'empty state copy is missing while there is no release')
  } else {
    ok('empty state present and honest')
  }
} else {
  const dl = readFileSync(join(dist, 'download/index.html'), 'utf8')
  const hrefs = [...dl.matchAll(/class="vy-asset-link" href="([^"]+)"/g)].map((m) => m[1])

  if (hrefs.length !== release.installers.length) {
    fail(
      'download page',
      `rendered ${hrefs.length} download links but the release has ${release.installers.length} installers`
    )
  }
  for (const href of hrefs) {
    if (!href.startsWith(RELEASE_HOST_PREFIX)) {
      fail('download link', `${href} is not served from the releases repository`)
    }
  }
  const urls = new Set(release.installers.map((i) => i.url))
  for (const href of hrefs) {
    if (!urls.has(href)) fail('download link', `${href} is not an asset in the baked release data`)
  }
  if (!failures.some((f) => f.startsWith('download'))) {
    ok(`${hrefs.length} download links, all matching real release assets`)
  }

  // The version stated on the page must be the version that was published.
  if (release.version && !dl.includes(release.version)) {
    fail('download page', `does not state the published version ${release.version}`)
  }

  // Strongest available proof that a button downloads a real installer: fetch
  // each asset's headers and check the served length against the size the
  // GitHub API reported. A redirect to a missing object shows up here.
  if (NETWORK) {
    console.log(`  … checking ${release.installers.length} asset URLs`)
    const checks = await Promise.all(
      release.installers.map(async (asset) => {
        try {
          const res = await fetch(asset.url, { method: 'HEAD', redirect: 'follow' })
          const len = Number(res.headers.get('content-length') ?? 0)
          return { asset, status: res.status, len }
        } catch (err) {
          return { asset, status: 0, len: 0, error: err.message }
        }
      })
    )
    let bad = 0
    for (const { asset, status, len, error } of checks) {
      if (status !== 200) {
        fail('download asset', `${asset.name} → ${status || 'network error'}${error ? ` (${error})` : ''}`)
        bad++
      } else if (len !== asset.size) {
        fail('download asset', `${asset.name} served ${len} bytes, release says ${asset.size}`)
        bad++
      }
    }
    if (bad === 0) ok(`all ${checks.length} installers download at the advertised size`)
  }
}

/* -------------------------------------------------------------- network --- */

if (NETWORK) {
  console.log(`\nNetwork (${externals.size} external URLs)`)
  const results = await Promise.all(
    [...externals].map(async (url) => {
      try {
        let res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
        // Some hosts reject HEAD; fall back to a ranged GET before judging.
        if (res.status === 405 || res.status === 403) {
          res = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, redirect: 'follow' })
        }
        return { url, status: res.status }
      } catch (err) {
        return { url, status: 0, error: err.message }
      }
    })
  )
  for (const r of results) {
    if (r.status >= 200 && r.status < 400) continue
    fail('external link', `${r.url} → ${r.status || 'network error'}${r.error ? ` (${r.error})` : ''}`)
  }
  const good = results.filter((r) => r.status >= 200 && r.status < 400).length
  if (good === results.length) ok(`all ${good} external URLs reachable`)
} else {
  console.log(`\nNetwork  (skipped — ${externals.size} external URLs; pass --network to check)`)
}

/* ----------------------------------------------------------------- done --- */

console.log('')
if (failures.length > 0) {
  console.error(`[verify-site] FAILED — ${failures.length} problem(s):\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log('[verify-site] all checks passed')
