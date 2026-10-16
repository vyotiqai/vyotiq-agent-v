import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/*
  The app's actions (docs/voice-mode.md §24.15), end to end: a run calls
  app_control through the real runner (the fixture's __app_control step),
  main sends the window its action and waits for the answer, and a
  destructive one stops at the approval card whatever the settings say.
  The voice's app_action is the same runner (unit-tested in voiceAppAction).
*/

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-app-control-ws-'))
  launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/app-control.json' })
  const addRes = await launched.window.evaluate(async (path) => window.vyotiq.addWorkspace(path), workspacePath)
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)
  workspacePath = requireActivePath(addRes.data.activePath)
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true, theme: 'dark' })
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  try {
    rmSync(workspacePath, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function runs(): Array<{ dir: string; status: string }> {
  const root = join(launched.userDataDir, 'workspaces')
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((id) => {
    const sessions = join(root, id, 'sessions')
    if (!existsSync(sessions)) return []
    return readdirSync(sessions).flatMap((run) => {
      const file = join(sessions, run, 'status.json')
      return existsSync(file) ? [{ dir: join(sessions, run), status: (JSON.parse(readFileSync(file, 'utf8')) as { status: string }).status }] : []
    })
  })
}

test('a run opens Voice settings, sets the theme, and a delete waits on the approval card', async () => {
  const { window } = launched
  await window.keyboard.press('Control+n')
  const brief = window.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await brief.fill('Open voice settings and use the light theme')
  await brief.press('Control+Enter')

  // The window ran the action main sent it: Settings, at Voice.
  await expect(window.locator('[data-settings-anchor="voice"]').first()).toBeVisible({ timeout: 20_000 })
  // Main wrote the setting; the window follows it.
  await expect.poll(async () => window.evaluate(async () => {
    const res = await self.vyotiq.getSettings()
    return res.ok ? res.data.theme : null
  }), { timeout: 10_000 }).toBe('light')

  // Deleting a task never just happens: the card asks, here with approvals at their default.
  await window.getByRole('button', { name: 'Back to the task' }).click()
  const deny = window.getByRole('button', { name: 'Deny', exact: true }).first()
  await expect(deny).toBeVisible({ timeout: 20_000 })
  await deny.click()
  await expect.poll(() => runs().map((r) => r.status), { timeout: 20_000 }).toEqual(['done'])
  expect(existsSync(runs()[0]!.dir)).toBe(true)
})
