import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedRunsInUserData } from './helpers/seedWorkspace'

let launched: LaunchedApp
let workspacePath: string

async function ensureSidebarExpanded(): Promise<void> {
  const expand = launched.window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }
}

async function splitBetaBesideAlpha(): Promise<void> {
  const { window } = launched
  const alpha = window.getByRole('button', { name: 'Pane Session Alpha', exact: true }).first()
  const beta = window.getByRole('button', { name: 'Pane Session Beta', exact: true }).first()
  await expect(alpha).toBeVisible({ timeout: 20_000 })
  await expect(beta).toBeVisible({ timeout: 20_000 })

  await alpha.click()
  await expect(window.locator('[data-chat-pane-host]')).toBeVisible({ timeout: 15_000 })
  await expect(window.locator('[data-chat-pane]')).toHaveCount(1)

  const host = window.locator('[data-chat-pane-host]')
  const box = await host.boundingBox()
  expect(box).toBeTruthy()

  await beta.dragTo(host, {
    targetPosition: {
      x: Math.floor((box?.width ?? 600) * 0.85),
      y: Math.floor((box?.height ?? 400) * 0.5)
    }
  })
  await expect(window.locator('[data-chat-pane]')).toHaveCount(2, { timeout: 15_000 })
}

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-pane-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp()

  // Seed before addWorkspace so the first listRuns (and its cache) sees the runs.
  seedRunsInUserData(launched.userDataDir, workspacePath, [
    { runId: 'run-alpha', goal: 'Pane Session Alpha', updatedAt: '2026-08-08T00:00:10.000Z' },
    { runId: 'run-beta', goal: 'Pane Session Beta', updatedAt: '2026-08-08T00:00:20.000Z' }
  ])

  const addRes = await launched.window.evaluate(async (path) => {
    return window.vyotiq.addWorkspace(path)
  }, workspacePath)
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)
  const openPath = addRes.data.activePath
  expect(openPath).toBeTruthy()

  const listed = await launched.window.evaluate(async (path) => {
    return window.vyotiq.listRuns(path)
  }, openPath)
  expect(listed.ok).toBe(true)
  if (!listed.ok) throw new Error(listed.error)
  expect(listed.data.runs.map((r) => r.goal)).toEqual(
    expect.arrayContaining(['Pane Session Alpha', 'Pane Session Beta'])
  )

  workspacePath = openPath
  await launched.window.evaluate(() => {
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
    localStorage.removeItem('vyotiq.browserPanelOpen')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
  await expect(launched.window.locator('body')).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  const videoPath = launched?.window.video()
    ? await launched.window.video()?.path().catch(() => null)
    : null
  if (launched) await closeApp(launched)
  if (videoPath) {
    console.log(`[gui-e2e] chatPane video: ${videoPath}`)
  }
  try {
    rmSync(workspacePath, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('drag sidebar session onto right third splits into two panes', async () => {
  const { window } = launched
  await ensureSidebarExpanded()
  await splitBetaBesideAlpha()

  await expect(window.locator('[data-chat-pane-focused="1"]')).toHaveCount(1)
  await expect(window.locator('[data-chat-pane-header]')).toHaveCount(2)
  await expect(window.locator('[data-chat-pane-title="Pane Session Alpha"]')).toBeVisible()
  await expect(window.locator('[data-chat-pane-title="Pane Session Beta"]')).toBeVisible()

  // Clicking an already-open session focuses its pane; does not add a third.
  await window.getByRole('button', { name: 'Pane Session Alpha', exact: true }).first().click()
  await expect(window.locator('[data-chat-pane]')).toHaveCount(2)
  await expect(window.locator('[data-chat-pane-focused="1"]')).toHaveCount(1)

  const betaPane = window.locator('[data-chat-pane]').nth(1)
  await window.getByRole('button', { name: 'Pane Session Beta', exact: true }).first().click()
  await expect(betaPane).toHaveAttribute('data-chat-pane-focused', '1')
  await window.getByRole('button', { name: /Close Pane Session Beta/i }).click()
  await expect(window.locator('[data-chat-pane]')).toHaveCount(1, { timeout: 10_000 })
})

test('multi-pane polish: min widths, sidebar open state, docked empty, rail pad', async () => {
  const { window } = launched
  await ensureSidebarExpanded()

  await window.evaluate(() => {
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
  })
  await window.reload()
  await window.waitForLoadState('domcontentloaded')
  await expect(window.locator('body')).toBeVisible({ timeout: 30_000 })
  await ensureSidebarExpanded()
  await splitBetaBesideAlpha()

  // Hard min width on every pane shell.
  const shellWidths = await window.locator('[data-chat-pane-shell]').evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).getBoundingClientRect().width)
  )
  expect(shellWidths.length).toBe(2)
  for (const width of shellWidths) {
    expect(width).toBeGreaterThanOrEqual(360)
  }

  // Always-visible headers (not hover-only).
  await expect(window.locator('[data-chat-pane-header]')).toHaveCount(2)
  await expect(window.getByRole('button', { name: /Close Pane Session Alpha/i })).toBeVisible()
  await expect(window.getByRole('button', { name: /Close Pane Session Beta/i })).toBeVisible()

  // Sidebar: both open; focused marked distinctly.
  const alphaRow = window.getByRole('button', { name: 'Pane Session Alpha', exact: true }).first()
  const betaRow = window.getByRole('button', { name: 'Pane Session Beta', exact: true }).first()
  await expect(alphaRow).toHaveAttribute('data-session-open', '1')
  await expect(betaRow).toHaveAttribute('data-session-open', '1')
  await expect(betaRow).toHaveAttribute('data-session-focused', '1')
  await expect(alphaRow).toHaveAttribute('data-session-focused', '0')

  // Resize gutter between panes (sidebar may have its own handle elsewhere).
  await expect(
    window.locator('[data-chat-pane-host] [data-panel-resize-handle]')
  ).toHaveCount(1)

  // Rightmost composer clears the side rail while the rail is mounted.
  const rightComposer = window.locator('[data-chat-pane]').nth(1).locator('[data-composer-dock]')
  await expect(rightComposer).toHaveAttribute('data-composer-side-rail-pad', '1')

  // New chat in multi-pane stays docked (no centered hero).
  await window.getByRole('button', { name: /new chat in/i }).first().click()
  await expect(window.locator('[data-chat-pane]')).toHaveCount(2)
  await expect(window.locator('[data-chat-pane-title="New chat"]')).toBeVisible({ timeout: 10_000 })
  const newPane = window.locator('[data-chat-pane-title="New chat"]')
  await expect(newPane.locator('[data-composer-dock]')).toBeVisible()
  await expect(newPane.locator('[data-composer-hero]')).toHaveCount(0)
})

test('opening right dock panel keeps multi-pane layout', async () => {
  const { window } = launched
  await ensureSidebarExpanded()

  await window.evaluate(() => {
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
  })
  await window.reload()
  await window.waitForLoadState('domcontentloaded')
  await expect(window.locator('body')).toBeVisible({ timeout: 30_000 })
  await ensureSidebarExpanded()
  await splitBetaBesideAlpha()

  await expect
    .poll(async () => {
      return window.evaluate(() => {
        const raw = localStorage.getItem('vyotiq.chatPaneLayout')
        if (!raw) return 0
        const parsed = JSON.parse(raw) as { panes?: unknown[] }
        return parsed.panes?.length ?? 0
      })
    })
    .toBe(2)

  await window.getByRole('button', { name: /show terminal panel/i }).click()
  await expect(window.locator('[data-right-dock]')).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('[data-chat-pane]')).toHaveCount(2)

  // With dock open the rail is gone — composer pad drops on the rightmost pane.
  const rightComposer = window.locator('[data-chat-pane]').nth(1).locator('[data-composer-dock]')
  await expect(rightComposer).toHaveAttribute('data-composer-side-rail-pad', '0')
})
