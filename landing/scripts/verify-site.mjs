/**
 * Post-build assertions over landing/dist, checked against the emitted HTML.
 *
 *   node scripts/verify-site.mjs            static checks only
 *   node scripts/verify-site.mjs --network  also HEAD every external URL
 *   node scripts/verify-site.mjs --draft    report empty media slots as a
 *                                           warning instead of a failure, for
 *                                           checking a preview before the
 *                                           screenshots and video arrive
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const landing = join(here, '..')
const dist = join(landing, 'dist')

const NETWORK = process.argv.includes('--network')
const DRAFT = process.argv.includes('--draft')
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

// Listed by hand so that deleting a page fails this check; unexpected pages
// are asserted below.
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

const emittedRoutes = htmlFiles
  .map((f) => '/' + relative(dist, f).replaceAll('\\', '/'))
  .filter((r) => r !== '/404.html')
  .map((r) => (r === '/index.html' ? '/' : r.replace(/\/index\.html$/, '')))
for (const route of emittedRoutes) {
  if (!EXPECTED_ROUTES.includes(route)) fail('unexpected route', `${route} was emitted but is not expected`)
}
if (failures.length === 0) ok(`all ${EXPECTED_ROUTES.length} routes + 404 emitted, and nothing else`)

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

/* -------------------------------------------------------- accessibility --- */

// Structural accessibility: what is decidable from the HTML.
let a11yProblems = 0
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8')
  const route = '/' + relative(dist, file).replaceAll('\\', '/')

  const headings = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => ({
    level: Number(m[1]),
    text: m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  }))
  const h1Count = headings.filter((h) => h.level === 1).length
  if (h1Count !== 1) {
    fail('accessibility', `${route} has ${h1Count} <h1> (expected exactly 1)`)
    a11yProblems++
  }
  let previous = 0
  for (const heading of headings) {
    if (previous && heading.level > previous + 1) {
      fail(
        'accessibility',
        `${route} skips from h${previous} to h${heading.level} at "${heading.text.slice(0, 40)}"`
      )
      a11yProblems++
    }
    previous = heading.level
  }

  // A bare alt is alt="" (Astro writes it that way): decoration a screen
  // reader should skip. Only an image with no alt at all fails.
  for (const m of html.matchAll(/<img\b[^>]*>/g)) {
    if (!/\salt(=|[\s/>])/.test(m[0])) {
      fail('accessibility', `${route} has an <img> with no alt: ${m[0].slice(0, 70)}`)
      a11yProblems++
    }
  }

  // A control whose only content is an icon needs an explicit name.
  for (const [tag, pattern] of [
    ['a', /<a\b([^>]*)>([\s\S]*?)<\/a>/g],
    ['button', /<button\b([^>]*)>([\s\S]*?)<\/button>/g]
  ]) {
    for (const m of html.matchAll(pattern)) {
      const text = m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
      if (!text && !/aria-label(ledby)?=/.test(m[1])) {
        fail('accessibility', `${route} has a <${tag}> with no accessible name: ${m[0].slice(0, 60)}`)
        a11yProblems++
      }
    }
  }

  if (!/<html[^>]+lang=/.test(html)) {
    fail('accessibility', `${route} has no lang on <html>`)
    a11yProblems++
  }
  if (!/<main\b/.test(html)) {
    fail('accessibility', `${route} has no <main> landmark`)
    a11yProblems++
  }
}
if (a11yProblems === 0) {
  ok('one h1 per page, no heading skips, every image and control named, lang + main present')
}

/* -------------------------------------------------------------- sitemap --- */

// Sitemap URLs and canonical tags must agree exactly (including trailing slashes).
const sitemapPath = join(dist, 'sitemap-0.xml')
if (!existsSync(sitemapPath)) {
  fail('sitemap', 'sitemap-0.xml was not generated')
} else {
  const xml = readFileSync(sitemapPath, 'utf8')
  const sitemapUrls = new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()))

  const canonicalUrls = new Set()
  for (const file of htmlFiles) {
    const route = '/' + relative(dist, file).replaceAll('\\', '/')
    if (route === '/404.html') continue
    const href = readFileSync(file, 'utf8').match(/<link rel="canonical" href="([^"]+)"/)?.[1]
    if (href) canonicalUrls.add(href)
  }

  let sitemapProblems = 0
  for (const url of sitemapUrls) {
    if (!canonicalUrls.has(url)) {
      fail('sitemap', `${url} is listed but no page declares it as canonical`)
      sitemapProblems++
    }
  }
  for (const url of canonicalUrls) {
    if (!sitemapUrls.has(url)) {
      fail('sitemap', `${url} is canonical on a page but missing from the sitemap`)
      sitemapProblems++
    }
  }
  // 404 must never be advertised for indexing.
  if ([...sitemapUrls].some((u) => u.includes('/404'))) {
    fail('sitemap', 'the 404 page is listed in the sitemap')
    sitemapProblems++
  }
  if (sitemapProblems === 0) {
    ok(`sitemap lists exactly the ${sitemapUrls.size} canonical URLs, 404 excluded`)
  }
}

/* ------------------------------------------------------- stylesheet refs --- */

// url() references in CSS are not covered by the link check above.
let cssRefs = 0
let cssBroken = 0
for (const file of files.filter((f) => f.endsWith('.css'))) {
  const css = readFileSync(file, 'utf8')
  for (const m of css.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
    const raw = m[2].trim()
    if (raw.startsWith('data:') || /^https?:\/\//.test(raw)) continue
    cssRefs++
    const clean = raw.split('?')[0].split('#')[0]
    const abs = clean.startsWith('/')
      ? clean
      : '/' + relative(dist, resolve(dirname(file), clean)).replaceAll('\\', '/')
    if (!distPaths.has(abs)) {
      fail('stylesheet asset', `${raw} in ${relative(dist, file)} was not emitted`)
      cssBroken++
    }
  }
}
if (cssBroken === 0) ok(`all ${cssRefs} stylesheet url() references resolve`)

/* --------------------------------------------------------------- claims --- */

// Counts stated in prose must match the data the pages were built from.
const appData = JSON.parse(readFileSync(join(landing, 'src/data/app.json'), 'utf8'))
const toolNames = appData.tools.names
const featuresHtml = readFileSync(join(dist, 'features/index.html'), 'utf8')

let claimProblems = 0
if (!featuresHtml.includes(`${toolNames.length} built-in tools`)) {
  fail('claim', `/features does not state "${toolNames.length} built-in tools"`)
  claimProblems++
}
// Any other count next to that phrase means a stale hardcoded number is live.
for (const m of featuresHtml.matchAll(/(\d+) built-in tools/g)) {
  if (Number(m[1]) !== toolNames.length) {
    fail('claim', `/features claims ${m[1]} built-in tools, the registry has ${toolNames.length}`)
    claimProblems++
  }
}
const missingNames = toolNames.filter((n) => !featuresHtml.includes(`>${n}<`))
if (missingNames.length > 0) {
  fail('claim', `/features omits ${missingNames.length} tool name(s): ${missingNames.join(', ')}`)
  claimProblems++
}
const extHtml = readFileSync(join(dist, 'extensions/index.html'), 'utf8')
if (!extHtml.includes(`${appData.extensions.total} packages`)) {
  fail('claim', `/extensions does not state ${appData.extensions.total} packages`)
  claimProblems++
}
if (claimProblems === 0) {
  ok(`stated counts match the baked data (${toolNames.length} tools, all named on /features)`)
}

/* ----------------------------------------------------------------- media --- */

// A slot whose screenshot or video has not been supplied renders a dashed frame
// (src/components/Media.astro). Publishing one would put an empty box on the
// live site, so it fails here; --draft reports it without failing.
console.log('\nMedia')
const missingMedia = new Map()
let mediaRefs = 0
let mediaBroken = 0
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8')
  const route = '/' + relative(dist, file).replaceAll('\\', '/')
  for (const m of html.matchAll(/data-missing-media="([^"]+)"/g)) {
    missingMedia.set(m[1], [...(missingMedia.get(m[1]) ?? []), route])
  }
  // Video files and posters are not <img>, so the link check above misses them.
  for (const m of html.matchAll(/<(?:source|video)\b[^>]*\b(?:src|poster)="([^"]+)"/g)) {
    mediaRefs++
    const ref = m[1].split('?')[0]
    if (/^https?:\/\//.test(ref)) continue
    if (!distPaths.has(ref)) {
      fail('media', `${ref} referenced on ${route} but not emitted`)
      mediaBroken++
    }
  }
}
for (const [id, routes] of missingMedia) {
  const message = `"${id}" has no file yet (${routes.join(', ')}); see src/lib/media.ts`
  if (DRAFT) console.log(`  ! ${message}`)
  else fail('media', message)
}
if (missingMedia.size === 0) ok('every screenshot and video slot has its file')
else if (DRAFT) console.log(`  ! ${missingMedia.size} empty slot(s), allowed by --draft`)
if (mediaBroken === 0) ok(`all ${mediaRefs} video and poster references resolve`)

/* ------------------------------------------------------------------ voice --- */

// The site is written to sound like a person, not a brochure. These are the
// phrases that give copy away as filler, checked on the pages whose words are
// ours (legal pages and release notes are baked from the repository as they
// are). Say the specific thing instead. See the notes at the top of
// src/lib/showcase.ts.
console.log('\nVoice')
const FILLER = [
  'seamless',
  'leverage',
  'unlock',
  'supercharge',
  'effortless',
  'cutting-edge',
  'game-changer',
  'game changer',
  'revolutioni',
  'empower',
  'delve',
  'elevate',
  'next level',
  'next-level',
  'world-class',
  'best-in-class',
  'robust',
  'streamline',
  'powerful',
  'blazing',
  'lightning-fast',
  'magic',
  'unleash',
  'look no further',
  'whether you’re',
  "whether you're",
  'in today’s',
  "in today's",
  'not just',
  'journey'
]
const VOICE_ROUTES = ['/', '/features', '/extensions', '/docs', '/download', '/404.html']
let voiceProblems = 0
for (const route of VOICE_ROUTES) {
  const file = route === '/404.html' ? join(dist, '404.html') : join(dist, route === '/' ? 'index.html' : `${route.slice(1)}/index.html`)
  if (!existsSync(file)) continue
  const main = readFileSync(file, 'utf8').match(/<main\b[\s\S]*<\/main>/)?.[0] ?? ''
  const text = main
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
  const lower = text.toLowerCase()
  for (const phrase of FILLER) {
    if (lower.includes(phrase)) {
      fail('voice', `"${phrase}" on ${route}`)
      voiceProblems++
    }
  }
  if (text.includes('—')) {
    fail('voice', `an em dash on ${route}; use a full stop, a comma or a colon`)
    voiceProblems++
  }
  const ratherThan = lower.split('rather than').length - 1
  if (ratherThan > 1) {
    fail('voice', `"rather than" ${ratherThan} times on ${route}; say what it does, once`)
    voiceProblems++
  }
}
if (voiceProblems === 0) ok(`no filler phrases, em dashes or stacked contrasts on ${VOICE_ROUTES.length} pages`)

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
  const hrefs = [...dl.matchAll(/<a\b[^>]*\bdata-asset\b[^>]*>/g)]
    .map((m) => m[0].match(/href="([^"]+)"/)?.[1])
    .filter(Boolean)

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

  // HEAD each asset and compare the served length with the size GitHub reported.
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
