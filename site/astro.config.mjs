import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import { satteri } from '@astrojs/markdown-satteri'

const REPO = 'https://github.com/vyotiqai/vyotiq-agent-v/blob/main'

/**
 * The legal pages render the repository's own PRIVACY.md, TERMS.md and
 * SECURITY.md, so the site and the repo can never disagree. Their relative
 * links point at sibling files; on the site they point at pages or GitHub.
 */
const LINKS = {
  './PRIVACY.md': '/privacy',
  './TERMS.md': '/terms',
  './SECURITY.md': '/security',
  './LICENSE': `${REPO}/LICENSE`,
  './NOTICE': `${REPO}/NOTICE`,
  './CODE_OF_CONDUCT.md': `${REPO}/CODE_OF_CONDUCT.md`
}
const rewriteRepoLinks = {
  name: 'rewrite-repo-links',
  link(node, ctx) {
    if (LINKS[node.url]) ctx.setProperty(node, 'url', LINKS[node.url])
  },
  // A page has one h1, its own title; a document's h1 becomes an h2.
  heading(node, ctx) {
    if (node.depth === 1) ctx.setProperty(node, 'depth', 2)
  }
}

/**
 * GitHub Pages answers /download from download.html but has nothing for
 * /download/, which was a 404. Each page file gets a download/index.html
 * beside it that sends the visitor to /download, keeping any query and
 * anchor. Pages serves the file for /download and the folder for /download/
 * when both exist, so the two never redirect into each other. The stub is
 * noindex with its canonical on /download, so the slashless URL stays the
 * only one listed. scripts/verify.mjs checks every page has one.
 */
const slashRedirects = {
  name: 'slash-redirects',
  hooks: {
    'astro:build:done': ({ dir }) => {
      const root = fileURLToPath(dir)
      const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
      for (const file of walk(root)) {
        const rel = relative(root, file).replace(/\\/g, '/')
        if (!rel.endsWith('.html') || rel === '404.html' || rel.endsWith('index.html')) continue
        const path = '/' + rel.slice(0, -'.html'.length)
        const folder = join(root, path)
        if (existsSync(join(folder, 'index.html'))) continue
        mkdirSync(folder, { recursive: true })
        writeFileSync(
          join(folder, 'index.html'),
          `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Agent V</title>
<meta name="robots" content="noindex">
<link rel="canonical" href="https://vyotiq.com${path}">
<script>location.replace(${JSON.stringify(path)} + location.search + location.hash)</script>
<meta http-equiv="refresh" content="0; url=${path}">
</head>
<body><a href="${path}">vyotiq.com${path}</a></body>
</html>
`
        )
      }
    }
  }
}

export default defineConfig({
  site: 'https://vyotiq.com',
  // download.astro builds to download.html and docs/index.astro to
  // docs/index.html. GitHub Pages serves /download from download.html and
  // /docs/ from the folder; slashRedirects covers /download/.
  trailingSlash: 'ignore',
  build: { format: 'preserve' },
  integrations: [
    slashRedirects,
    sitemap({
      filter: (page) => !page.endsWith('/404'),
      // Section index pages are folders on GitHub Pages; list them as /docs/, not /docs.
      serialize: (item) => ({ ...item, url: item.url.replace(/\/(docs|features|use-cases)$/, '/$1/') })
    })
  ],
  markdown: { processor: satteri({ mdastPlugins: [rewriteRepoLinks] }) },
  // PRIVACY.md, TERMS.md, SECURITY.md and the extensions catalog live in the
  // app's repository, one folder up.
  vite: { server: { fs: { allow: ['..'] } } }
})
