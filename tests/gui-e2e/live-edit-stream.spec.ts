import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-live-edit-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({
    e2eFixture: true,
    fixtureFile: 'tests/gui-e2e/fixtures/live-edit-stream.json'
  })

  const addRes = await launched.window.evaluate(async (path) => {
    return window.vyotiq.addWorkspace(path)
  }, workspacePath)
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

test('live edit stream: empty window then early lines before late', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }

  const composer = window.getByRole('combobox', { name: 'Message' })
  await expect(composer).toBeVisible({ timeout: 20_000 })
  await composer.fill('Stream a live edit diff')

  // Track production-like phases: empty/path window → early mark → late mark.
  await window.evaluate(() => {
    const w = window as unknown as {
      __liveEditMarks?: string[]
      __liveEditObs?: MutationObserver
    }
    w.__liveEditMarks = []
    w.__liveEditObs?.disconnect()
    const tick = (): void => {
      const text = document.body.innerText
      const marks = w.__liveEditMarks!
      const hasEarly = text.includes('LIVE_EARLY_MARK')
      const hasLate = text.includes('LIVE_LATE_MARK')
      if (
        !hasEarly &&
        !marks.includes('empty-window') &&
        (text.includes('Editing') || text.includes('@@'))
      ) {
        marks.push('empty-window')
      }
      if (hasEarly && !marks.includes('early')) {
        marks.push('early')
        marks.push(hasLate ? 'late-already' : 'late-absent')
      }
      if (hasLate && !marks.includes('late')) {
        marks.push('late')
      }
    }
    const obs = new MutationObserver(() => tick())
    obs.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    })
    w.__liveEditObs = obs
    tick()
  })

  await window.getByRole('button', { name: /^send$/i }).click()

  await expect
    .poll(
      async () =>
        window.evaluate(
          () => (window as unknown as { __liveEditMarks?: string[] }).__liveEditMarks ?? []
        ),
      { timeout: 30_000 }
    )
    .toEqual(['empty-window', 'early', 'late-absent', 'late'])

  await expect(window.getByText('LIVE_EARLY_MARK')).toBeVisible()
  await expect(window.getByText('LIVE_LATE_MARK')).toBeVisible()
  await expect(window.getByText('old code')).toBeVisible()
  await expect(window.getByText('Streaming change…')).toHaveCount(0)
  await expect(window.getByText('Receiving edit…')).toHaveCount(0)

  await expect(window.getByText('Live edit stream fixture done.')).toBeVisible({
    timeout: 20_000
  })
  await expect(window.getByRole('button', { name: /edited: live-stream\.ts/i })).toBeVisible()
  await expect(window.getByText('+5').first()).toBeVisible()
  await expect(window.getByText('-1').first()).toBeVisible()
})
