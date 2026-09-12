import { cpus } from 'os'
import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
    maxForks: Math.max(1, Math.min(24, cpus().length)),
    minForks: 1,
    // PDF parsing (extractAttachment) drives pdf.js over malformed fixtures
    // and can exceed the ~4GB default heap inside a forked worker, killing
    // the whole run. The forks pool strips everything except profiling flags
    // from the CLI's process.execArgv and then appends project.config.execArgv
    // (vitest cli-api chunk: "...process.execArgv.filter(...--cpu-prof|
    // --heap-prof...), ...project.config.execArgv"), so the only place the
    // worker heap can be raised is this config option.
    execArgv: ['--max-old-space-size=8192', '--expose-gc'],
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
      // fail the coverage run instead of passing silently.
      thresholds: {
        lines: 40,
        statements: 40,
        functions: 35,
        branches: 30
      }
    }
  }
})
