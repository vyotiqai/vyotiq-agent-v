/**
 * Copies the repository's real legal and community documents into the site.
 *
 * Every /legal-ish route renders one of these files verbatim. Nothing is
 * paraphrased for the website, and a missing source is a hard build failure —
 * the site must never publish a policy page that has no file behind it.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const landing = join(here, '..')
const repo = join(landing, '..')
const out = join(landing, 'src/generated/legal')

/**
 * `format: 'markdown'` is rendered as prose; `'plain'` is rendered in a
 * monospace <pre> because the GPL text and the NOTICE file are hard-wrapped
 * and reflowing them as markdown mangles them.
 */
const DOCS = [
  { slug: 'license', file: 'LICENSE', title: 'License', format: 'plain' },
  { slug: 'notice', file: 'NOTICE', title: 'Third-party notices', format: 'plain' },
  { slug: 'security', file: 'SECURITY.md', title: 'Security', format: 'markdown' },
  { slug: 'privacy', file: 'PRIVACY.md', title: 'Privacy', format: 'markdown' },
  { slug: 'terms', file: 'TERMS.md', title: 'Terms', format: 'markdown' },
  { slug: 'contributing', file: 'CONTRIBUTING.md', title: 'Contributing', format: 'markdown' },
  { slug: 'code-of-conduct', file: 'CODE_OF_CONDUCT.md', title: 'Code of conduct', format: 'markdown' }
]

/**
 * These documents cross-reference each other with repo-relative paths, which
 * resolve on GitHub but 404 on the website. Rewrite them to the site routes
 * that render the same file. Anything else pointing into the repo becomes an
 * absolute GitHub URL rather than a dead relative link.
 */
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
    // Still a repo path (e.g. docs/teammates.md) — point at GitHub.
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

  // Plain documents (LICENSE, NOTICE) are rendered verbatim in a <pre>; only
  // markdown is link-rewritten, because only markdown has clickable links.
  const web = doc.format === 'markdown' ? rewriteLinks(body) : body
  writeFileSync(join(out, `${doc.slug}.${doc.format === 'markdown' ? 'md' : 'txt'}`), web, 'utf8')
  manifest.push({
    slug: doc.slug,
    title: doc.title,
    format: doc.format,
    sourceFile: doc.file,
    sourceUrl: `https://github.com/vyotiqai/vyotiq-agent-v/blob/main/${doc.file}`,
    bytes: Buffer.byteLength(body, 'utf8')
  })
}

writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`[bake-legal] ${manifest.length} documents copied from repo root`)
