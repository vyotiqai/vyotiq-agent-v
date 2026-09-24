import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedAppSettings, seedRecentWorkspaces } from './helpers/seedWorkspace'

/**
 * The first run, end to end: a profile with no approval choice on record and
 * no task opens on Set up. Step 1 is main's own model list for the provider
 * (the fixture replays one), step 2 opens a real folder through main, step 3
 * is saved to settings.json by Start, which then opens the brief.
 */
let launched: LaunchedApp
let workspacePath: string
let strayFile: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-setup-ws-'))
  strayFile = join(tmpdir(), `vyotiq-setup-file-${process.pid}.txt`)
  writeFileSync(strayFile, 'not a folder', 'utf8')
  launched = await launchApp({
    e2eFixture: true,
    preLaunchSeed: (userDataDir) => {
      seedAppSettings(userDataDir, { navigationMode: 'sidebar', toolApprovalOnboardingDone: false })
      workspacePath = seedRecentWorkspaces(userDataDir, [workspacePath])[0]!
    }
  })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  for (const path of [workspacePath, strayFile]) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

test('Set up: a provider that answered, a folder, the approval choice, then the brief', async () => {
  const page = launched.window

  await expect(page.getByRole('heading', { name: 'Set up Agent V' })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Tasks you start show up here, grouped by what they need from you.')).toBeVisible()

  const provider = page.locator('[data-setup-step="1"]')
  await expect(provider).toHaveAttribute('data-state', 'done', { timeout: 15_000 })
  await expect(provider).toContainText('Ollama · no key needed · http://127.0.0.1:11434')

  const start = page.getByRole('button', { name: /Start your first task/ })
  await expect(start).toBeDisabled()
  await expect(page.getByText('Open a workspace first')).toBeVisible()

  // A dropped item is opened by the path Electron gives its File. A real file
  // (not a folder) goes all the way to main, which says why it can't be one.
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'e2e-drop-source'
    document.body.appendChild(input)
  })
  await page.setInputFiles('#e2e-drop-source', strayFile)
  const bridged = await page.evaluate(() => {
    const input = document.getElementById('e2e-drop-source') as HTMLInputElement
    const file = input.files![0]!
    const path = window.vyotiq.pathForFile(file)
    const data = new DataTransfer()
    data.items.add(file)
    const zone = document.querySelector('[data-setup-drop]')!
    zone.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
    input.remove()
    return path
  })
  expect(bridged.toLowerCase()).toBe(strayFile.toLowerCase())
  // Set up's own alert — the window's live region is an alert too.
  const folderAlert = page.locator('[data-setup] p[role="alert"]')
  await expect(folderAlert).toContainText('Workspace is not a directory')

  // The folder opened before is one click away.
  await page.getByRole('button', { name: new RegExp(basename(workspacePath)) }).click()
  const folder = page.locator('[data-setup-step="2"]')
  await expect(folder).toHaveAttribute('data-state', 'done')
  await expect(folder).toContainText(workspacePath)
  await expect(folderAlert).toHaveCount(0)
  await expect(start).toBeEnabled()
  await expect(page.getByText(`Starts in ${basename(workspacePath)}`)).toBeVisible()

  await page.getByRole('radio', { name: /Every tool/ }).click()
  await expect(page.getByRole('radio', { name: /Every tool/ })).toHaveAttribute('aria-checked', 'true')
  await start.click()

  await expect(page.getByRole('combobox', { name: 'Brief' })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('heading', { name: 'Set up Agent V' })).toHaveCount(0)
  const saved = await page.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    return res.ok ? { done: res.data.toolApprovalOnboardingDone, mode: res.data.toolApproval.mode } : null
  })
  expect(saved).toEqual({ done: true, mode: 'all' })

  // Set up is done for good: Home is Home now.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('button', { name: /^Home$/ }).click()
  await expect(page.locator('[data-home]')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-setup]')).toHaveCount(0)
})
