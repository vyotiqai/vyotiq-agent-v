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

export default defineConfig({
  site: 'https://vyotiq.com',
  // download.astro builds to download.html and docs/index.astro to
  // docs/index.html. GitHub Pages serves /download from download.html and
  // /docs/ from the folder, so no page file sits beside a folder of its name.
  trailingSlash: 'ignore',
  build: { format: 'preserve' },
  integrations: [
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
