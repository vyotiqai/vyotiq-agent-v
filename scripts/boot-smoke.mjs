// Boot the built app once and exit: the check typecheck, lint and the unit
// suite cannot make. On 2026-10-09 the working tree's main bundle threw
// "Cannot access 'YY' before initialization" at load (a tools module imported
// ahead of the tools barrel) while all three were green; only starting
// out/main shows that family of failure.
//
// Usage: pnpm build:vite (or pnpm build), then pnpm smoke:boot.
// Launches out/main on a throwaway profile, waits for the window's page to
// load, fails on a main-process crash, a page error or no window, and quits.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('@playwright/test')

const repoRoot = process.cwd()
// BOOT_SMOKE_MAIN points it at another entry: how this script's own failure path was checked.
const mainEntry = process.env.BOOT_SMOKE_MAIN || join(repoRoot, 'out', 'main', 'index.js')
const TIMEOUT_MS = 60_000

if (!existsSync(mainEntry)) {
  console.error(`boot-smoke: ${mainEntry} is missing. Build first (pnpm build:vite).`)
  process.exit(2)
}

const profile = mkdtempSync(join(tmpdir(), 'vyotiq-boot-smoke-'))
const mainErrors = []
const pageErrors = []
let app
let failed = false

try {
  app = await electron.launch({
    executablePath: require('electron'),
    args: [mainEntry, `--user-data-dir=${profile}`],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true', ELECTRON_ENABLE_LOGGING: '1' },
    timeout: TIMEOUT_MS
  })
  app.process().stderr?.on('data', (chunk) => {
    const text = String(chunk)
    if (/\b(ReferenceError|TypeError|SyntaxError)\b|Uncaught|unhandled/i.test(text)) mainErrors.push(text.trim())
  })
  const window = await app.firstWindow({ timeout: TIMEOUT_MS })
  window.on('pageerror', (err) => pageErrors.push(String(err?.stack ?? err)))
  await window.waitForLoadState('load', { timeout: TIMEOUT_MS })
  // The renderer mounted something, not a blank or crashed page.
  // A string, so it runs in the page: this file is linted as Node code.
  await window.waitForFunction("(document.getElementById('root')?.childElementCount ?? 0) > 0", null, {
    timeout: TIMEOUT_MS
  })
  // A moment for late startup work (IPC registration, first settings read) to throw.
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  if (mainErrors.length || pageErrors.length) failed = true
  console.log(`boot-smoke: window loaded: ${await window.title()}`)
} catch (err) {
  failed = true
  console.error(`boot-smoke: the app did not boot: ${err?.message ?? err}`)
} finally {
  for (const e of mainErrors) console.error(`boot-smoke: main: ${e}`)
  for (const e of pageErrors) console.error(`boot-smoke: renderer: ${e}`)
  await app?.close().catch(() => {})
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  } catch {
    // A handle Windows still holds; the folder is in the OS temp dir and unique to this run.
  }
}

if (failed) {
  console.error('boot-smoke: FAILED')
  process.exit(1)
}
console.log('boot-smoke: ok')
