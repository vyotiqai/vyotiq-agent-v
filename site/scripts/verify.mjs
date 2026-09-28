// Checks the built site in dist/ before it is deployed. Fails the build when:
// - a page loads a script, stylesheet or font from another origin (PRIVACY.md §9
//   promises the site loads none),
// - an internal link or asset, or a canonical or social-card URL on this site,
//   points at a file that does not exist,
// - a page is missing its <title>, meta description or a single <h1>.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const SITE = 'https://vyotiq.com'
const problems = []

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
const files = walk(DIST)
const pages = files.filter((f) => f.endsWith('.html'))
const css = files.filter((f) => f.endsWith('.css'))

/** A site path exists if it names a file, a page (with or without .html) or a folder index. */
const exists = (path) => {
  const p = decodeURIComponent(path.split(/[?#]/)[0]).replace(/\/$/, '')
  if (p === '') return true
  return [p, `${p}.html`, `${p}/index.html`].some((c) => existsSync(join(DIST, c)))
}

for (const page of pages) {
  const html = readFileSync(page, 'utf8')
  const name = '/' + relative(DIST, page).replace(/\\/g, '/')

  for (const [, src] of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    if (/^(https?:)?\/\//.test(src)) problems.push(`${name}: third-party script ${src}`)
  }
  for (const [tag] of html.matchAll(/<link[^>]+>/g)) {
    const rel = tag.match(/rel="([^"]+)"/)?.[1] ?? ''
    const href = tag.match(/href="([^"]+)"/)?.[1] ?? ''
    if (/stylesheet|preload|modulepreload|preconnect/.test(rel) && /^(https?:)?\/\//.test(href) && !href.startsWith(SITE)) {
      problems.push(`${name}: third-party ${rel} ${href}`)
    }
  }

  if (!/<title>[^<]+<\/title>/.test(html)) problems.push(`${name}: no <title>`)
  if (!/<meta name="description" content="[^"]+"/.test(html)) problems.push(`${name}: no meta description`)
  const h1s = (html.match(/<h1[\s>]/g) ?? []).length
  if (h1s !== 1) problems.push(`${name}: ${h1s} <h1> elements`)

  // Canonical and social-card URLs are absolute, on this site.
  for (const [, url] of html.matchAll(/(?:href|content)="https:\/\/vyotiq\.com(\/[^"]*)"/g)) {
    if (!exists(url)) problems.push(`${name}: broken link ${SITE}${url}`)
  }

  for (const [, href] of html.matchAll(/(?:href|src)="(\/[^"/][^"]*|\/)"/g)) {
    if (!exists(href)) problems.push(`${name}: broken link ${href}`)
  }
}

for (const file of css) {
  const text = readFileSync(file, 'utf8')
  for (const [, url] of text.matchAll(/url\(\s*["']?((?:https?:)?\/\/[^"')]+)/g)) {
    problems.push(`${relative(DIST, file)}: third-party url(${url})`)
  }
  for (const [, url] of text.matchAll(/@import\s+(?:url\()?["']?((?:https?:)?\/\/[^"')]+)/g)) {
    problems.push(`${relative(DIST, file)}: third-party @import ${url}`)
  }
}

if (problems.length) {
  console.error(`verify: ${problems.length} problem(s)\n` + problems.map((p) => `  - ${p}`).join('\n'))
  process.exit(1)
}
console.log(`verify: ${pages.length} pages and ${css.length} stylesheets checked, no problems`)
