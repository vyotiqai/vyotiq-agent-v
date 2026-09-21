import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-follow-ws-'))
  mkdirSync(join(workspacePath, 'src'), { recursive: true })
  writeFileSync(
    join(workspacePath, 'src', 'target.ts'),
    'export const one = 1\nexport const two = 2\nexport const THREE_MARK = 3\nexport const four = 4\n',
    'utf8'
  )
  writeFileSync(join(workspacePath, 'src', 'other.ts'), 'export const other = 1\n', 'utf8')

  launched = await launchApp({
    e2eFixture: true,
    fixtureFile: 'tests/gui-e2e/fixtures/tool-card-open-file.json'
  })

  const addRes = await launched.window.evaluate(
    async (path) => window.vyotiq.addWorkspace(path),
    workspacePath
  )
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)
  workspacePath = addRes.data.activePath

  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true })
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
    localStorage.removeItem('vyotiq.browserPanelOpen')
    localStorage.removeItem('vyotiq.files.followAgent')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
  await expect(launched.window.locator('body')).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  try {
    rmSync(workspacePath, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('follow mode opens the file the run writes', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) await expand.click()

  await window.getByRole('button', { name: /Show files panel/i }).click()
  await expect(window.getByRole('tabpanel', { name: 'Files' })).toBeVisible({ timeout: 20_000 })

  const follow = window.getByRole('button', { name: 'Follow agent edits' })
  await expect(follow).toBeVisible({ timeout: 20_000 })
  expect(await follow.getAttribute('aria-pressed')).toBe('false')
  await follow.click()
  expect(await follow.getAttribute('aria-pressed')).toBe('true')

  // Nothing is open yet — the run is what puts a file on screen.
  await expect(window.getByRole('tab', { name: /target\.ts/i })).toHaveCount(0)

  const composer = window.getByRole('combobox', { name: 'Message' })
  await expect(composer).toBeVisible({ timeout: 20_000 })
  await composer.fill('Edit the target file')
  await window.getByRole('button', { name: /^send$/i }).click()

  await expect(window.getByRole('tab', { name: /target\.ts/i })).toBeVisible({ timeout: 30_000 })
  const editor = window.locator('[data-code-editor] .cm-content')
  await expect(editor).toContainText('export const THREE_MARK = 3', { timeout: 20_000 })
})
