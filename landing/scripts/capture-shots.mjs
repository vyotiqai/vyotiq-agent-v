/**
 * Captures the Marketplace screenshot for /extensions from the running app.
 * It is the one surface backed entirely by shipped data, so it can be taken
 * automatically; everything that shows a real run is captured by hand (see
 * src/lib/media.ts).
 *
 * The app is booted with the repository as its app path so that
 * bundledMarketplaceRoot() resolves to resources/marketplace; a packaged build
 * under dist-package/ is used when present.
 *
 *   pnpm build && pnpm site:capture
 *
 * Exits 0 with a warning when capture is not possible; whatever is in
 * src/media at build time is what ships.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const landing = join(here, '..')
const repo = join(landing, '..')
const outDir = join(landing, 'src/media')

const require = createRequire(join(repo, 'package.json'))

const warn = (msg) => {
  console.warn(`[capture-shots] ${msg}`)
  console.warn('[capture-shots] skipping — the site will build without new screenshots')
  process.exit(0)
}

/** A packaged build, if `electron-builder --dir` has been run. */
function packagedExecutable() {
  const layouts = [
    join('win-unpacked', 'Vyotiq.exe'),
    join('linux-unpacked', 'vyotiq'),
    join('mac-arm64', 'Vyotiq.app', 'Contents', 'MacOS', 'Vyotiq'),
    join('mac', 'Vyotiq.app', 'Contents', 'MacOS', 'Vyotiq')
  ]
  for (const out of ['dist-package', 'dist-package-alt']) {
    for (const layout of layouts) {
      const candidate = join(repo, out, layout)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

if (!existsSync(join(repo, 'out/main/index.js'))) {
  warn('missing out/main/index.js — run `pnpm build` at the repo root first')
}

let electron
try {
  ;({ _electron: electron } = require('@playwright/test'))
} catch {
  warn('@playwright/test is not installed at the repo root')
}

const packaged = packagedExecutable()
console.log(
  packaged
    ? `[capture-shots] using the packaged build at ${packaged}`
    : '[capture-shots] no packaged build found — booting the repository as the app path'
)

const userDataDir = mkdtempSync(join(tmpdir(), 'vyotiq-shots-'))
mkdirSync(outDir, { recursive: true })

const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
// IDE shells export this as "1", which boots Electron as plain Node.
delete env.ELECTRON_RUN_AS_NODE

const launchArgs = [`--user-data-dir=${userDataDir}`, '--force-device-scale-factor=2']

let app
try {
  app = await electron.launch({
    executablePath: packaged ?? require('electron'),
    args: packaged ? launchArgs : [repo, ...launchArgs],
    cwd: repo,
    env,
    timeout: 120_000
  })
} catch (err) {
  rmSync(userDataDir, { recursive: true, force: true })
  warn(`could not launch the app: ${err.message}`)
}

/** Set the app's own appearance setting and reload; the DOM only reads it on boot. */
async function setTheme(window, theme) {
  await window.evaluate(async (value) => {
    await window.vyotiq.setSettings({ theme: value })
  }, theme)
  await window.reload()
  await window.locator('body').waitFor({ state: 'attached', timeout: 60_000 })
  await window.waitForTimeout(4000)
  const applied = await window.evaluate(() => document.documentElement.dataset.theme)
  if (applied !== theme) {
    throw new Error(`theme did not apply: asked for ${theme}, document reports ${applied}`)
  }
}

/** Return to a neutral surface. Never match a bare /close/i: the titlebar's Close quits the app. */
async function leaveOverlay(window) {
  await window.keyboard.press('Escape')
  await window.evaluate(() => document.activeElement?.blur?.())
  const back = window.getByRole('button', { name: /^back$/i })
  if (await back.isVisible().catch(() => false)) await back.click()
  const home = window.getByRole('button', { name: /^home$/i }).first()
  if (await home.isVisible().catch(() => false)) await home.click()
  await window.waitForTimeout(600)
}

/** Each surface is reached the way the GUI e2e specs reach it. */
const SURFACES = [
  {
    name: 'marketplace',
    open: async (window) => {
      await window.getByRole('button', { name: 'Marketplace' }).click()
      await window
        .getByRole('tablist', { name: 'Marketplace sections' })
        .waitFor({ timeout: 20_000 })
      await window.waitForTimeout(3000)
    }
  }
]

/** Park the pointer on the titlebar strip so no hover tooltip is in the frame. */
async function settleCursor(window) {
  await window.mouse.move(720, 20)
  await window.waitForTimeout(1500)
}

const THEMES = ['light', 'dark']

let wrote = 0
try {
  const window = await app.firstWindow({ timeout: 90_000 })
  await window.waitForLoadState('domcontentloaded').catch(() => {})
  await window.locator('body').waitFor({ state: 'attached', timeout: 60_000 })
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1440, height: 900 })
  })
  // Fonts, icons and the bundled catalog all settle before the first frame.
  await window.waitForTimeout(6000)

  for (const theme of THEMES) {
    await leaveOverlay(window)
    await setTheme(window, theme)
    for (const surface of SURFACES) {
      await leaveOverlay(window)
      await surface.open(window)
      await settleCursor(window)
      const file = join(outDir, `${surface.name}-${theme}.png`)
      await window.screenshot({ path: file })
      console.log(`[capture-shots] wrote ${surface.name}-${theme}.png`)
      wrote++
    }
  }
} catch (err) {
  // Failing part-way leaves a stale mix of frames on disk, so this is an error.
  console.error(`[capture-shots] capture failed after ${wrote} shot(s): ${err.message}`)
  process.exitCode = 1
} finally {
  // app.close() can hang; force the process down so the script always exits.
  try {
    const pid = app.process()?.pid
    if (pid && process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    }
  } catch {
    /* already gone */
  }
  await Promise.race([
    app.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 10_000))
  ])
  try {
    rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* best-effort cleanup */
  }
}
