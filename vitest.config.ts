import { cpus } from 'os'
import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { iifeBundlePlugin } from './scripts/viteIifePlugin'

export default defineConfig({
  plugins: [react(), iifeBundlePlugin()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@main': resolve(__dirname, 'src/main')
    },
    extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/gui-e2e/**'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    /**
     * Force-exit bound once the run is over.
     *
     * On Windows the suite prints its summary and then hangs: a tinypool fork
     * worker holding an open IPC channel keeps the event loop alive, and
     * vitest's own force-exit never fires. This is tinypool's
     * `terminateTimeout`, so a worker that will not shut down on its own gets
     * terminated instead of wedging CI. scripts/test-exit-wrapper.cjs was the
     * workaround (poll stdout, then taskkill /T); this fixes it at the source.
     */
    teardownTimeout: 15_000,
    pool: 'forks',
    // Vitest 4: pool limits moved from poolOptions to top-level options.
    // Cap concurrent forks at 8: worst case is maxForks x per-fork heap
    // (8 x 4096MB). Historically, up to 24 forks x 8GB OOM'd CI runners
    // (worker exit at ~8.2GB RSS). The per-fork heap is now 4096MB — PDF
    // extraction is bounded at the source (src/main/attachments/extract.ts
    // early-stops at the attachment text cap and destroys the document),
    // so 4096MB is a safety margin, not a requirement.
    maxForks: Math.max(1, Math.min(8, cpus().length)),
    minForks: 1,
    // PDF parsing (extractAttachment) drives pdf.js over malformed fixtures,
    // but extraction is bounded at the source (src/main/attachments/extract.ts
    // early-stops at the attachment text cap and destroys the document), so
    // the default ~4GB heap would generally suffice; 4096MB is kept as a
    // safety margin. The forks pool strips everything except profiling flags
    // from the CLI's process.execArgv and then appends project.config.execArgv
    // (vitest cli-api chunk: "...process.execArgv.filter(...--cpu-prof|
    // --heap-prof...), ...project.config.execArgv"), so the only place the
    // worker heap can be raised is this config option.
    execArgv: ['--max-old-space-size=4096', '--expose-gc'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/main/**', 'src/shared/**', 'src/renderer/src/**'],
      exclude: [
        'src/main/types/**',
        '**/*.d.ts',
        'src/renderer/src/assets/**',
        'src/renderer/src/lib/icons/**',
        'src/renderer/src/lib/fileIcons/**'
      ],
      // CI gate: dropping a test suite or shipping untested runtime paths must
      // fail the coverage run instead of passing silently. Set about three
      // points under what was measured (2026-09-30 local: 75.2 statements,
      // 67.8 branches, 77.5 functions, 78.3 lines; CI on 2026-09-28 read about
      // a point lower on all three OSes). The old 40/30/35/40 sat so far below
      // that it could never fire. Raise these as coverage rises.
      thresholds: {
        lines: 74,
        statements: 71,
        functions: 73,
        branches: 63
      }
    }
  }
})
