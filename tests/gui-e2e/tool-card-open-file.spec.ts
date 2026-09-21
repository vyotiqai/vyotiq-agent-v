import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-toolcard-open-ws-'))
  mkdirSync(join(workspacePath, 'src'), { recursive: true })
  writeFileSync(
    join(workspacePath, 'src', 'target.ts'),
    'export const one = 1\nexport const two = 2\nexport const THREE_MARK = 3\nexport const four = 4\n',
    'utf8'
  )

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

test('an edit tool card opens its file in the Files panel at the changed line', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) await expand.click()

  const composer = window.getByRole('combobox', { name: 'Message' })
  await expect(composer).toBeVisible({ timeout: 20_000 })
  await composer.fill('Edit the target file')
  await window.getByRole('button', { name: /^send$/i }).click()

  await expect(window.getByText('export const THREE_MARK = 3').first()).toBeVisible({
    timeout: 30_000
  })

  // The badge names the file AND the first changed line of the unified diff:
  // hunk starts at 1, two context lines, so the addition lands on line 3.
  const openBadge = window.getByRole('button', { name: 'Open src/target.ts:3' })
  await expect(openBadge).toBeVisible({ timeout: 20_000 })

  // A button nested inside the disclosure button would be invalid HTML and
  // would swallow one of the two actions.
  const parentTag = await openBadge.evaluate((el) => el.parentElement?.tagName ?? '')
  expect(parentTag).not.toBe('BUTTON')

  await openBadge.click()

  // The Files panel reveals itself and loads the real file off disk.
  await expect(window.getByRole('tabpanel', { name: 'Files' })).toBeVisible({ timeout: 20_000 })
  await expect(window.getByRole('tab', { name: /target\.ts/i })).toBeVisible({ timeout: 20_000 })

  const editor = window.locator('[data-code-editor] .cm-content')
  await expect(editor).toBeVisible({ timeout: 20_000 })
  await expect(editor).toContainText('export const THREE_MARK = 3')

  // The requested line is the one the editor put the cursor on.
  const activeLine = window.locator('[data-code-editor] .cm-activeLine').first()
  await expect(activeLine).toContainText('export const THREE_MARK = 3', { timeout: 20_000 })
})
