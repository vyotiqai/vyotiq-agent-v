import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

const require = createRequire(__filename)
/** Expect `pnpm test:gui-e2e` from repo root after `pnpm build`. */
const repoRoot = process.cwd()
const mainEntry = join(repoRoot, 'out/main/index.js')
const videoDir = join(repoRoot, 'test-results', 'gui-e2e', 'videos')

export type LaunchedApp = {
  app: ElectronApplication
  window: Page
  userDataDir: string
  videoDir: string
}

export type LaunchOptions = {
  /** Replay chat-send fixture instead of calling a live LLM provider. */
  e2eFixture?: boolean
  /**
   * Fixture JSON relative to repo root (or absolute).
   * Sets `VYOTIQ_E2E_FIXTURE_FILE` when `e2eFixture` is on.
   */
  fixtureFile?: string
  /** Write userData disk state before Electron boots (orphan-run tests). */
  preLaunchSeed?: (userDataDir: string) => void
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  if (!existsSync(mainEntry)) {
    throw new Error(
      `Missing ${mainEntry}. Run \`pnpm build\` before \`pnpm test:gui-e2e\`.`
    )
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'vyotiq-gui-e2e-'))
  mkdirSync(userDataDir, { recursive: true })
  options.preLaunchSeed?.(userDataDir)
  // The e2e specs drive the classic sidebar chrome; the shipped default is
  // the home rail. Merge the seed AFTER preLaunchSeed: seedAppSettings
  // rewrites settings.json from DEFAULT_SETTINGS + its partial, which would
  // otherwise clobber navigationMode. Specs can still opt out by seeding a
  // navigationMode explicitly.
  const settingsPath = join(userDataDir, 'settings.json')
  const seeded: Record<string, unknown> = existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>)
    : {}
  if (seeded.navigationMode === undefined) seeded.navigationMode = 'sidebar'
  writeFileSync(settingsPath, JSON.stringify(seeded), 'utf8')
  mkdirSync(videoDir, { recursive: true })

  const electronExecutable = require('electron') as string
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  if (options.e2eFixture ?? process.env.VYOTIQ_E2E_FIXTURE === '1') {
    env.VYOTIQ_E2E_FIXTURE = '1'
    if (options.fixtureFile) {
      env.VYOTIQ_E2E_FIXTURE_FILE = options.fixtureFile
    }
  }
  // IDE shells export this as "1", which boots Electron as plain Node.
  delete env.ELECTRON_RUN_AS_NODE

  // recordVideo on electron.launch leaves a blank BrowserWindow (empty url) on
  // current Playwright+Electron — opt in only via VYOTIQ_E2E_VIDEO=1.
  const recordVideo =
    process.env.VYOTIQ_E2E_VIDEO === '1'
      ? { dir: videoDir, size: { width: 1280, height: 800 } as const }
      : undefined

  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env,
    timeout: 45_000,
    ...(recordVideo ? { recordVideo } : {})
  })

  const window = await app.firstWindow({ timeout: 45_000 })
  // Custom file:// loads sometimes skip a fresh domcontentloaded after firstWindow;
  // wait for the renderer shell instead of hanging on load-state alone.
  try {
    await window.waitForLoadState('domcontentloaded', { timeout: 15_000 })
  } catch {
    /* fall through — body wait below */
  }
  await window.locator('body').waitFor({ state: 'attached', timeout: 45_000 })
  return { app, window, userDataDir, videoDir }
}

export async function closeApp(launched: LaunchedApp): Promise<void> {
  try {
    // app.close() can hang past the hook timeout when the quit path stalls
    // (before-quit preventDefault + async shutdown; seen on all three CI OSes
    // and locally as an afterAll timeout in marketplace-mcp-config). Bound the
    // graceful close and force-kill the Electron process so afterAll always
    // completes — the test outcome must not depend on quit latency.
    await Promise.race([
      launched.app.close(),
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            // app.process() throws once Playwright has disposed the
            // ElectronApplication (close() finished during this window) — the
            // kill is then unnecessary anyway, so it must live inside try/catch
            // or the uncaught throw crashes the worker (CI run 33609263586).
            const proc = launched.app.process()
            const pid = proc?.pid
            if (process.platform === 'win32' && pid != null) {
              // Windows children inherit the driver pipe, so killing only the
              // main process orphans GPU/renderer children and the worker
              // pipe never closes (Playwright "Worker teardown timeout").
              spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
            } else {
              proc?.kill('SIGKILL')
            }
          } catch {
            // already gone
          }
          resolve()
        }, 10_000)
        timer.unref()
      })
    ])
  } finally {
    try {
      rmSync(launched.userDataDir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
}
