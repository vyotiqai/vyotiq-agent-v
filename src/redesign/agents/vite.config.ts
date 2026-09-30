import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Agents redesign mockups, built on the renderer's own stack: React 19,
 * TypeScript, Tailwind v4 CSS-first, the real `--vy-*` tokens, and the real
 * primitives from `src/renderer/src/lib/ui` — imported, not copied.
 *
 *   pnpm redesign:agents   → http://localhost:5207
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
    port: 5207,
    strictPort: true,
    fs: { allow: [repo] }
  },
  build: {
    outDir: resolve(repo, '.tmp/redesign-agents-dist'),
    emptyOutDir: true
  }
})
