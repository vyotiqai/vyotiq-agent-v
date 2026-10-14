import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * The voice view (docs/voice-mode.md §25, D-48), redrawn three ways for a pick
 * (§24.7). Same stack as the other mockups: React 19, Tailwind v4 CSS-first,
 * the real --vy-* tokens, lib/ui primitives and lib/icons; the state words
 * come from the app (VOICE_STATE_LABEL), imported, not retyped.
 *
 *   pnpm redesign:voice-view   → http://localhost:5219
 *
 * Lives under src/ on purpose: electron-builder excludes src/**, and it is
 * outside tsconfig.web.json and the renderer's Tailwind scan, so nothing here
 * can reach the shipped app.
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
    port: 5219,
    strictPort: true,
    fs: { allow: [repo] }
  },
  build: {
    outDir: resolve(repo, '.tmp/redesign-voice-view-dist'),
    emptyOutDir: true
  }
})
