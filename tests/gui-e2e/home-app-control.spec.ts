import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/*
  Home through the agent's app_control, end to end: a run sets Home's
  backdrop and greeting name in main (set_home_options), is refused a
  picture none was picked for, and reads Home's day sentence from the window
  (read_home) while Home is not on screen. Home then draws what was set.
*/

let launched: LaunchedApp
let workspacePath: string

type ToolResult = { id: string; ok: boolean; content: string }

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-home-app-control-ws-'))
  launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/home-app-control.json' })
  const addRes = await launched.window.evaluate(async (path) => window.vyotiq.addWorkspace(path), workspacePath)
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)
  workspacePath = requireActivePath(addRes.data.activePath)
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true, homeBackdrop: 'pixels', userName: '' })
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

test('a run sets Home’s backdrop and name, is refused a picture, and reads Home’s sentence', async () => {
  const { window } = launched
  // Every app_control answer the run gets, as the record would show it.
  await window.evaluate(() => {
    const seen: ToolResult[] = []
    ;(self as unknown as { __homeResults: ToolResult[] }).__homeResults = seen
    self.vyotiq.onChatEvent((e) => {
      if (e.type === 'tool_result' && e.name === 'app_control') seen.push({ id: e.toolCallId, ok: e.ok, content: String(e.content) })
    })
  })

  await window.keyboard.press('Control+n')
  const brief = window.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await brief.fill('Use the field backdrop on Home, call me Ajay, and tell me what is on today')
  await brief.press('Control+Enter')

  const results = async (): Promise<ToolResult[]> =>
    window.evaluate(() => (self as unknown as { __homeResults: ToolResult[] }).__homeResults)
  await expect.poll(async () => (await results()).length, { timeout: 30_000 }).toBe(3)
  const [set, picture, read] = await results()

  // Main wrote both settings, and said so.
  expect(set).toEqual({ id: 'home-1', ok: true, content: 'Home’s backdrop is field, and Home greets you as Ajay.' })
  const settings = await window.evaluate(async () => {
    const res = await self.vyotiq.getSettings()
    return res.ok ? { backdrop: res.data.homeBackdrop, name: res.data.userName } : null
  })
  expect(settings).toEqual({ backdrop: 'field', name: 'Ajay' })

  // A picture is the user's to pick in a file dialog: refused, and nothing changed.
  expect(picture).toEqual({
    id: 'home-2',
    ok: false,
    content: 'No picture has been picked for Home yet; choose one in Settings, Appearance, Home.'
  })

  // Read from the window with the task on screen, not Home, carrying the greeting it was just given. The
  // rest isn't pinned: the fixture's steps land before the window's lists hold its own run (measured
  // 2026-10-17: "Good afternoon, Ajay. Nothing needs you."), as Home drawn at that instant would say too.
  expect(read!.id).toBe('home-3')
  expect(read!.ok).toBe(true)
  expect(read!.content).toMatch(/^Good (morning|afternoon|evening), Ajay\. \S.*\.$/)
  expect(await window.locator('[data-day-sentence]').count()).toBe(0)

  // Home draws what the run set.
  await window.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+H`)
  const sentence = window.locator('[data-day-sentence]')
  await expect(sentence).toBeVisible({ timeout: 20_000 })
  await expect(sentence).toContainText(/Good (morning|afternoon|evening), Ajay\./)
  await expect(window.locator('[data-home-backdrop="field"]')).toHaveCount(1)
})
