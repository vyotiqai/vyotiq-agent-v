import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

const SLOW_FIXTURE = 'tests/gui-e2e/fixtures/run-capacity-hold.json'

let launched: LaunchedApp
let workspacePath: string

test.setTimeout(120_000)

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-run-capacity-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ e2eFixture: true, fixtureFile: SLOW_FIXTURE })

  const addRes = await launched.window.evaluate(async (path) => {
    return window.vyotiq.addWorkspace(path)
  }, workspacePath)
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)

  workspacePath = requireActivePath(addRes.data.activePath)
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

test('allows more than four concurrent chat starts', async () => {
  const { window } = launched

  const starts = await window.evaluate(async (path) => {
    const message = { role: 'user' as const, content: 'capacity hold' }
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        window.vyotiq.chatStart({ workspacePath: path, messages: [message] })
      )
    )
    return results.map((r) => ({ ok: r.ok, code: r.ok ? null : r.code }))
  }, workspacePath)

  for (const res of starts) {
    expect(res.ok).toBe(true)
  }
})
