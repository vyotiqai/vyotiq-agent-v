import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

/**
 * End-to-end cover for the update surface, driven through the real pipe:
 * a main-process `updater:state` broadcast → the preload schema gate → the
 * renderer store → the sidebar rail entry.
 *
 * The packaged release feed is unreachable here (`checkForAppUpdates` returns
 * null when `!app.isPackaged`), so these push the state payload main would
 * have sent. Everything downstream of that broadcast is the shipping code.
 */

/**
 * Each test uses its own version. The panel announces itself once per version
 * and the app is not relaunched between tests, so sharing one version would
 * mean only the first test saw the auto-open — which is the product behaviour
 * (it announces once, it does not nag), not something to work around.
 */
function makeInfo(version: string): Record<string, unknown> {
  return {
    version,
    releaseDate: '2026-09-01',
    releaseName: `Autumn release ${version}`,
    notesText: `Autumn release ${version}`,
    notesSections: [{ heading: 'Highlights', items: ['Faster chat streaming'] }],
    releaseUrl: `https://github.com/vyotiqai/vyotiq-agent-v-releases/releases/tag/v${version}`
  }
}

/** Broadcast from the main process exactly as the updater service does. */
async function pushUpdaterState(
  launched: LaunchedApp,
  payload: Record<string, unknown>
): Promise<void> {
  await launched.app.evaluate(async ({ BrowserWindow }, state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send('updater:state', state)
    }
  }, payload)
}

let launched: LaunchedApp

test.beforeAll(async () => {
  launched = await launchApp()
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
})

test.beforeEach(async () => {
  const { window } = launched
  await window.keyboard.press('Escape')
  const expand = window.getByRole('button', { name: /show navigator/i })
  if (await expand.isVisible().catch(() => false)) await expand.click()
})

test('no update affordance while the install is current', async () => {
  const { window } = launched
  await expect(window.getByRole('button', { name: /^settings/i })).toBeVisible()
  await pushUpdaterState(launched, { status: 'not-available' })

  await expect(window.getByRole('button', { name: /is available/i })).toHaveCount(0)
})

test('an available update announces itself without being asked', async () => {
  const { window } = launched
  await pushUpdaterState(launched, { status: 'available', info: makeInfo('9.9.1') })

  // Appears on its own, and opens its panel once so it cannot be missed.
  const entry = window.getByRole('button', { name: /Version 9\.9\.1 is available/ })
  await expect(entry).toBeVisible()
  const panel = window.getByRole('dialog', { name: /Version 9\.9\.1 is available/ })
  await expect(panel).toBeVisible()
  // Named the way the app names itself; the release's own title is not repeated.
  await expect(panel.getByRole('heading', { name: 'Agent V 9.9.1' })).toBeVisible()
  await expect(panel.getByText('Update available')).toBeVisible()
  await expect(panel.getByText('Faster chat streaming')).toBeVisible()

  // Nothing downloads on its own: the only route is this button.
  await expect(panel.getByRole('button', { name: 'Download update' })).toBeVisible()
})

test('the panel opens away from the toast corner', async () => {
  const { window } = launched
  await pushUpdaterState(launched, { status: 'available', info: makeInfo('9.9.2') })

  const panel = window.getByRole('dialog', { name: /Version 9\.9\.2 is available/ })
  await expect(panel).toBeVisible()

  const box = await panel.boundingBox()
  const viewport = await window.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight
  }))
  expect(box).not.toBeNull()
  // Toasts own the bottom-right corner. The old card sat there too, underneath
  // them; the rail panel opens from the left rail instead, so the two surfaces
  // can no longer occlude each other.
  expect(box!.x).toBeLessThan(viewport.w / 2)
})

test('closing the panel leaves the rail entry in place', async () => {
  const { window } = launched
  await pushUpdaterState(launched, { status: 'available', info: makeInfo('9.9.3') })

  const panel = window.getByRole('dialog', { name: /Version 9\.9\.3 is available/ })
  await expect(panel).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(panel).toBeHidden()

  // Closing is not dismissing — the update stays reachable.
  const entry = window.getByRole('button', { name: /Version 9\.9\.3 is available/ })
  await expect(entry).toBeVisible()
  await entry.click()
  await expect(panel).toBeVisible()
})

test('download progress and the install handoff render from real state', async () => {
  const { window } = launched
  const info = makeInfo('9.9.4')
  await pushUpdaterState(launched, { status: 'available', info })
  await expect(window.getByRole('dialog', { name: /9\.9\.4/ })).toBeVisible()

  await pushUpdaterState(launched, {
    status: 'downloading',
    info,
    progress: { percent: 42.4, transferred: 4.2 * 1024 * 1024, total: 10 * 1024 * 1024 }
  })
  const bar = window.getByRole('progressbar')
  await expect(bar).toHaveAttribute('aria-valuenow', '42')
  await expect(window.getByText(/4\.2 MB of 10\.0 MB/)).toBeVisible()

  await pushUpdaterState(launched, { status: 'downloaded', info })
  await expect(window.getByRole('button', { name: 'Restart and install' })).toBeVisible()
  await expect(window.getByText('Update ready')).toBeVisible()
})

test('Settings mirrors the state from the same store', async () => {
  const { window } = launched
  await pushUpdaterState(launched, { status: 'downloaded', info: makeInfo('9.9.5') })
  await window.keyboard.press('Escape')

  await window.getByRole('button', { name: /^settings/i }).click()
  await window
    .getByRole('navigation', { name: 'Settings', exact: true })
    .getByRole('button', { name: /^about$/i })
    .click()

  const group = window.locator('[data-settings-field="about-updater"]')
  await expect(group).toBeVisible()
  const row = group.locator('[data-settings-item="update-status"]')
  await expect(row.getByText('Version 9.9.5 is ready')).toBeVisible()
  await expect(row.getByText('Downloaded · restart to install')).toBeVisible()
  // The install is the rail panel's own action (installUpdate in the store),
  // so neither place skips what the other does. Nothing is left to check.
  await expect(row.getByRole('button', { name: 'Restart and install' })).toBeVisible()
  await expect(row.getByRole('button', { name: 'Check now' })).toHaveCount(0)
})
