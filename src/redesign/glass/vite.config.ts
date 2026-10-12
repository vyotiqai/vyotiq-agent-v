import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The composer and its popovers, rebuilt in the dark glass of the reference
 * prompt bar. Same stack as the other mockups: React 19, Tailwind v4
 * CSS-first, the real `--vy-*` tokens and `lib/ui` primitives. The composer's
 * own components are hand-built replicas of the source; their words, order
 * and states come from the app's pure helpers, imported, not retyped.
 *
 *   pnpm redesign:glass   → http://localhost:5215
 *
 * Lives under `src/` on purpose: electron-builder excludes `src/**`, and it is
 * outside `tsconfig.web.json` and the renderer's Tailwind scan, so nothing
 * here can reach the shipped app.
 */
const repo = resolve(__dirname, '../../..')

export default defineConfig({
  root: resolve(__dirname),
  publicDir: resolve(repo, 'src/renderer/public'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@renderer': resolve(repo, 'src/renderer/src'),
      '@shared': resolve(repo, 'src/shared')
    }
  },
  define: { 'import.meta.env.VITE_SENTRY_DSN': '""' },
  server: {
    port: 5215,
    strictPort: true,
    fs: { allow: [repo] }
  },
  build: {
    outDir: resolve(repo, '.tmp/redesign-glass-dist'),
    emptyOutDir: true
  }
})
