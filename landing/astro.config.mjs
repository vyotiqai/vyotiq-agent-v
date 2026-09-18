// @ts-check
import { defineConfig } from 'astro/config'
import tailwindcss from '@tailwindcss/vite'
import sitemap from '@astrojs/sitemap'

// Static output only: the site is a bundle of HTML/CSS/JS with no server
// runtime. `site` drives canonical URLs and the generated sitemap.
export default defineConfig({
  site: 'https://vyotiq.com',
  output: 'static',
  trailingSlash: 'ignore',
  build: { format: 'directory', inlineStylesheets: 'never' },
  devToolbar: { enabled: false },
  // Generated from the pages actually emitted, so it can never list a route
  // that does not exist or miss one that does.
  integrations: [sitemap()],
  vite: { plugins: [tailwindcss()] }
})
