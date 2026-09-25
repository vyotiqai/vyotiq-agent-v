/**
 * Copies the repository's legal and community documents into the site. A
 * missing source is a hard build failure: no policy page without a file behind it.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const landing = join(here, '..')
const repo = join(landing, '..')
const out = join(landing, 'src/generated/legal')

/** 'markdown' renders as prose; 'plain' keeps the hard-wrapped GPL text in a <pre>. */
const DOCS = [
  { slug: 'license', file: 'LICENSE', title: 'License', format: 'plain' },
  { slug: 'notice', file: 'NOTICE', title: 'Third-party notices', format: 'markdown' },
  { slug: 'security', file: 'SECURITY.md', title: 'Security', format: 'markdown' },
  { slug: 'privacy', file: 'PRIVACY.md', title: 'Privacy', format: 'markdown' },
  { slug: 'terms', file: 'TERMS.md', title: 'Terms', format: 'markdown' },
  { slug: 'contributing', file: 'CONTRIBUTING.md', title: 'Contributing', format: 'markdown' },
  { slug: 'code-of-conduct', file: 'CODE_OF_CONDUCT.md', title: 'Code of conduct', format: 'markdown' }
]

/** Repo-relative links become site routes where one renders the file, else GitHub URLs. */
const ROUTES = {
  LICENSE: '/license',
  NOTICE: '/notice',
  'PRIVACY.md': '/privacy',
  'TERMS.md': '/terms',
  'SECURITY.md': '/security',
  'CONTRIBUTING.md': '/contributing',
  'CODE_OF_CONDUCT.md': '/code-of-conduct'
}
const BLOB = 'https://github.com/vyotiqai/vyotiq-agent-v/blob/main/'

function rewriteLinks(body) {
  return body.replace(/\]\((\.\/)?([A-Za-z0-9_./-]+)\)/g, (whole, _dot, target) => {
    if (/^(https?:|#|mailto:)/.test(target)) return whole
    const key = target.replace(/^\.\//, '')
    if (ROUTES[key]) return `](${ROUTES[key]})`
    // Still a repo path (e.g. docs/egress.md) — point at GitHub.
    if (/\.(md|txt|ya?ml|json|ts|tsx|mjs)$/.test(key) || key === 'LICENSE' || key === 'NOTICE') {
      return `](${BLOB}${key})`
    }
    return whole
  })
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const manifest = []
for (const doc of DOCS) {
  let body
  try {
    body = readFileSync(join(repo, doc.file), 'utf8')
  } catch {
    console.error(`[bake-legal] missing required source document: ${doc.file}`)
    process.exit(1)
  }
  if (!body.trim()) {
    console.error(`[bake-legal] ${doc.file} is empty`)
    process.exit(1)
  }

  let web = doc.format === 'markdown' ? rewriteLinks(body) : body

  // Lift the document's own `# Title` into the page heading so each route has
  // exactly one <h1>.
  let heading = null
  if (doc.format === 'markdown') {
    // CONTRIBUTING.md is stored with a BOM.
    const stripped = web.replace(/^\uFEFF/, '')
    const match = stripped.match(/^#[ \t]*([^\n]+)\n+/)
    if (!match) {
      console.error(`[bake-legal] ${doc.file} does not start with a level-1 heading — the page would render no title`)
      process.exit(1)
    }
    heading = match[1].trim()
    web = stripped.slice(match[0].length)
    if (/^#\s/m.test(web)) {
      console.error(`[bake-legal] ${doc.file} has more than one level-1 heading — the page would render two <h1>`)
      process.exit(1)
    }
  }

  writeFileSync(join(out, `${doc.slug}.${doc.format === 'markdown' ? 'md' : 'txt'}`), web, 'utf8')
  manifest.push({
    slug: doc.slug,
    title: doc.title,
    heading: heading ?? doc.title,
    format: doc.format,
    sourceFile: doc.file,
    sourceUrl: `https://github.com/vyotiqai/vyotiq-agent-v/blob/main/${doc.file}`,
    bytes: Buffer.byteLength(body, 'utf8')
  })
}

writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`[bake-legal] ${manifest.length} documents copied from repo root`)
