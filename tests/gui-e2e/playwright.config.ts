/**
 * Playwright Electron GUI e2e.
 * Expects a prior `pnpm build` (launches `out/main/index.js`).
 * Separate from Vitest `tests/main/e2e` (agent-pipeline mocks).
 *
 * Videos land in `test-results/` (webm) for each test.
 */
import { defineConfig } from '@playwright/test'
import { join } from 'node:path'

export default defineConfig({
  testDir: __dirname,
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  // One retry in CI absorbs Electron boot flakes; local runs stay strict.
  retries: process.env.CI ? 1 : 0,
  outputDir: join(__dirname, '../../test-results/gui-e2e'),
  use: {
    video: 'on',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  }
})
