/**
 * Captures real screenshots of the running application for the website.
 *
 * The site shows the product, not a mockup, so these come from booting the
 * actual packaged main entry (out/main/index.js) under Playwright's Electron
 * driver — the same mechanism tests/gui-e2e uses — against a throwaway userData
 * directory so nothing from the developer's own install leaks into a public
 * image.
 *
 *   pnpm --filter @vyotiq/landing capture
 *
 * Requires a prior `pnpm build` at the repo root. Exits 0 with a warning when
 * capture is not possible, so a website build never depends on it; whatever is
 * in public/shots at build time is what ships.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const landing = join(here, '..')
const repo = join(landing, '..')
const mainEntry = join(repo, 'out/main/index.js')
const outDir = join(landing, 'public/shots')

const require = createRequire(import.meta.url)

const warn = (msg) => {
  console.warn(`[capture-shots] ${msg}`)
  console.warn('[capture-shots] skipping — the site will build without new screenshots')
  process.exit(0)
}

if (!existsSync(mainEntry)) warn(`missing ${mainEntry}; run \`pnpm build\` at the repo root first`)

let electron
try {
  ;({ _electron: electron } = require('@playwright/test'))
} catch {
  warn('@playwright/test is not installed at the repo root')
}

const userDataDir = mkdtempSync(join(tmpdir(), 'vyotiq-shots-'))
mkdirSync(outDir, { recursive: true })

// Land on the chat surface with the classic sidebar, which is what the site
// describes, and keep first-run prompts out of the frame.
writeFileSync(
  join(userDataDir, 'settings.json'),
  JSON.stringify({ navigationMode: 'sidebar', autoCheckUpdates: false, telemetryEnabled: false }),
  'utf8'
)

const SHOTS = [
  { name: 'app-light', theme: 'light' },
  { name: 'app-dark', theme: 'dark' }
]

let app
try {
  app = await electron.launch({
    args: [
      mainEntry,
      `--user-data-dir=${userDataDir}`,
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--force-device-scale-factor=2'
    ],
    executablePath: require('electron'),
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      VYOTIQ_E2E_FIXTURE: '1'
    },
    timeout: 90_000
  })
} catch (err) {
  rmSync(userDataDir, { recursive: true, force: true })
  warn(`could not launch the app: ${err.message}`)
}

try {
  const window = await app.firstWindow({ timeout: 60_000 })
  await window.setViewportSize({ width: 1440, height: 900 })
  await window.waitForLoadState('domcontentloaded')
  // Give fonts, icons and the workspace panes a beat to settle so the capture
  // is not of a half-painted frame.
  await window.waitForTimeout(6000)

  for (const shot of SHOTS) {
    await window.evaluate((theme) => {
      document.documentElement.dataset.theme = theme
    }, shot.theme)
    await window.waitForTimeout(1200)
    const file = join(outDir, `${shot.name}.png`)
    await window.screenshot({ path: file })
    console.log(`[capture-shots] wrote ${shot.name}.png`)
  }
} catch (err) {
  console.warn(`[capture-shots] capture failed: ${err.message}`)
} finally {
  await app.close().catch(() => {})
  rmSync(userDataDir, { recursive: true, force: true })
}
