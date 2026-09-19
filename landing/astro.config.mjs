// @ts-check
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'

// Static HTML/CSS/JS only; `site` drives canonical URLs and the sitemap.
export default defineConfig({
  site: 'https://vyotiq.com',
  output: 'static',
  trailingSlash: 'ignore',
  build: { format: 'directory', inlineStylesheets: 'never' },
  devToolbar: { enabled: false },
  // The legal documents are styled by global.css, not by a Shiki theme.
  markdown: { syntaxHighlight: false },
  integrations: [
    sitemap({
      // build.format 'directory' emits trailing slashes; Base.astro's canonical
      // strips them. Normalise so the two describe the same URL (verify-site
      // asserts they match).
      serialize: (item) => ({ ...item, url: item.url.replace(/(?<!\/)\/$/, '') })
    })
  ]
})
