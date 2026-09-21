/**
 * The title bar is an absolute `z-sticky` overlay across the top of the main
 * column. Chat chrome pinned to the window's top row lives *under* it, and two
 * separate things used to eat its clicks:
 *
 *  1. the DOM hit test — the bar's empty accessory span sits above `<main>`, so
 *     it was the `elementFromPoint` answer everywhere in that 36px band;
 *  2. Electron's draggable region — `-webkit-app-region: drag` is resolved at
 *     the window level, before the renderer sees the event at all.
 *
 * Class assertions cannot catch either. This spec drives the real Electron
 * window and asks the page what is actually on top, then clicks it for real.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import {
  seedRunEvents,
  seedRunsInUserData,
  sessionsRootFor,
  requireActivePath
} from './helpers/seedWorkspace'

let launched: LaunchedApp
let workspacePath: string

const PARENT_RUN = 'run-band-parent'
const PARENT_GOAL = 'Band Parent Session'
const INSTANCE_RUN = 'run-band-child'
const INSTANCE_GOAL = 'Run the vm test suite'

/**
 * A sub-agent instance run as the app records one: it only joins a workspace's
 * `instanceRuns` when status.json carries `inlineInstance` plus a `parentRunId`
 * that is itself listed.
 */
function seedInstanceRun(userDataDir: string, wsPath: string): void {
  const dir = join(sessionsRootFor(userDataDir, wsPath), INSTANCE_RUN)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify(
      {
        status: 'done',
        step: 1,
        updatedAt: '2026-08-08T00:00:30.000Z',
        goal: INSTANCE_GOAL,
        workspacePath: wsPath,
        inlineInstance: true,
        parentRunId: PARENT_RUN
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(
    join(dir, 'messages.jsonl'),
    `${JSON.stringify({ role: 'user', content: INSTANCE_GOAL })}\n`,
    'utf8'
  )
}

/** What the page reports is on top at a point — the thing a click would reach. */
async function topmostAt(x: number, y: number): Promise<string> {
  return launched.window.evaluate(
    ([px, py]: number[]) => {
      const el = document.elementFromPoint(px!, py!)
      if (!el) return 'none'
      if (el.closest('[data-titlebar-controls]')) return 'titlebar-controls'
      if (el.closest('[data-titlebar-accessory]')) return 'titlebar-accessory'
      if (el.closest('[data-instance-header]')) return 'instance-header'
      if (el.closest('[data-chat-pane-header]')) return 'pane-header'
      const named = el.closest('[data-transcript-row],[data-user-prompt],[data-chat-stage],[data-chat-surface]')
      const tag = el.tagName.toLowerCase()
      const cls = (el.getAttribute('class') ?? '').slice(0, 120)
      const via = named
        ? [...named.attributes].map((a) => a.name).find((n) => n.startsWith('data-'))
        : null
      return `other:${tag}${via ? `[${via}]` : ''}:${cls}`
    },
    [x, y]
  )
}

async function centerOf(selector: string): Promise<{ x: number; y: number }> {
  const box = await launched.window.locator(selector).first().boundingBox()
  if (!box) throw new Error(`no box for ${selector}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function ensureSidebarExpanded(): Promise<void> {
  const expand = launched.window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) await expand.click()
}

/** The user's route in: expand the parent's instance disclosure, pick the child. */
async function openInstancePane(): Promise<void> {
  const { window } = launched
  const header = window.locator('[data-instance-header]')
  if (await header.count()) return
  await ensureSidebarExpanded()
  await window.getByRole('button', { name: PARENT_GOAL, exact: true }).first().click()
  const disclosure = window.getByRole('button', {
    name: new RegExp(`instance — ${PARENT_GOAL}`, 'i')
  })
  await expect(disclosure).toBeVisible({ timeout: 30_000 })
  if ((await disclosure.getAttribute('aria-expanded')) !== 'true') await disclosure.click()
  await window.getByRole('button', { name: INSTANCE_GOAL, exact: true }).first().click()
  await expect(header).toBeVisible({ timeout: 30_000 })
}

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-band-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp()

  // Seed before addWorkspace: the first listRuns caches its result, so a run
  // written afterwards stays invisible until that TTL lapses.
  seedRunsInUserData(launched.userDataDir, workspacePath, [
    { runId: PARENT_RUN, goal: PARENT_GOAL, updatedAt: '2026-08-08T00:00:20.000Z' }
  ])
  seedInstanceRun(launched.userDataDir, workspacePath)
  // One usage report so the header renders its context meter — the control the
  // caption buttons were printed on top of.
  seedRunEvents(launched.userDataDir, workspacePath, INSTANCE_RUN, [
    {
      type: 'context_usage',
      runId: INSTANCE_RUN,
      step: 1,
      estimatedTokens: 90_000,
      inputTokens: 90_000,
      contextWindow: 128_000,
      contentWindow: 85_000,
      compactionTrigger: 80_000,
      source: 'estimate',
      layers: { system: 0, history: 0, tools: 0, buffer: 0 }
    }
  ])

  const addRes = await launched.window.evaluate(
    async (path) => window.vyotiq.addWorkspace(path),
    workspacePath
  )
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)
  workspacePath = requireActivePath(addRes.data.activePath)

  await launched.window.evaluate(() => {
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
    localStorage.removeItem('vyotiq.dockExpanded')
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

test('instance header controls are the topmost thing at their own coordinates', async () => {
  const { window } = launched
  await openInstancePane()
  const header = window.locator('[data-instance-header]')

  // The header is inside the title-bar band, or this spec proves nothing.
  const headerBox = await header.boundingBox()
  expect(headerBox).toBeTruthy()
  expect(headerBox!.y).toBeLessThan(36)

  const back = await centerOf('[data-instance-header] button[aria-label="Back to parent chat"]')
  expect(await topmostAt(back.x, back.y)).toBe('instance-header')

  // The caption buttons keep their own corner — releasing the band must not
  // cost the window its own controls.
  const close = await centerOf('[data-titlebar-controls] button[aria-label="Close"]')
  expect(await topmostAt(close.x, close.y)).toBe('titlebar-controls')

  // The header's trailing controls stop before the caption strip, so nothing
  // is drawn underneath it.
  const controlsBox = await window.locator('[data-titlebar-controls]').boundingBox()
  const trailing = window.locator('[data-instance-header] button').last()
  const trailingBox = await trailing.boundingBox()
  expect(trailingBox!.x + trailingBox!.width).toBeLessThanOrEqual(controlsBox!.x)
})

test('the context meter is reachable and opens its panel', async () => {
  const { window } = launched
  await openInstancePane()
  const meter = window.locator('[data-instance-header] button[aria-label^="Context window"]')
  await expect(meter).toBeVisible({ timeout: 30_000 })

  // It used to be drawn under the minimize button, inside the drag region.
  const at = await centerOf('[data-instance-header] button[aria-label^="Context window"]')
  expect(await topmostAt(at.x, at.y)).toBe('instance-header')

  await meter.click()
  await expect(window.getByRole('dialog', { name: 'Context details' })).toBeVisible({
    timeout: 10_000
  })
  await window.keyboard.press('Escape')
})

test('Back actually navigates out of the instance pane', async () => {
  const { window } = launched
  await openInstancePane()
  const header = window.locator('[data-instance-header]')

  await window.locator('[data-instance-header] button[aria-label="Back to parent chat"]').click()

  // A real click, landing through the overlay.
  await expect(header).toHaveCount(0, { timeout: 15_000 })
})

test('with no chrome in the band the title bar outranks the pinned prompt', async () => {
  const { window } = launched
  // The pane now holds the parent run: an ordinary transcript with no top-row
  // chrome, so the bar must still own the band as a window-drag region. The
  // transcript's pinned turn prompt is `sticky z-sticky` and sits later in the
  // DOM, so on a tie it painted straight over the caption buttons.
  await expect(window.locator('[data-instance-header]')).toHaveCount(0, { timeout: 15_000 })
  await expect(window.locator('[data-transcript-row]').first()).toBeVisible({ timeout: 15_000 })

  const close = await centerOf('[data-titlebar-controls] button[aria-label="Close"]')
  expect(await topmostAt(close.x, close.y)).toBe('titlebar-controls')

  const accessory = window.locator('[data-titlebar-accessory]')
  expect(await accessory.getAttribute('data-titlebar-band-released')).toBeNull()
  const box = await accessory.boundingBox()
  expect(await topmostAt(box!.x + box!.width / 2, box!.y + box!.height / 2)).toBe(
    'titlebar-accessory'
  )
})

test('pane headers claim the band without lying across the caption buttons', async () => {
  const { window } = launched
  await window.keyboard.press('Control+Backslash')
  const headers = window.locator('[data-chat-pane-header]')
  await expect(headers).toHaveCount(2, { timeout: 15_000 })

  // Each header is in the band...
  const firstBox = await headers.first().boundingBox()
  expect(firstBox!.y).toBeLessThan(36)

  // ...its own controls answer for its row...
  const paneClose = await centerOf('[data-chat-pane-header] button[aria-label^="Close "]')
  expect(await topmostAt(paneClose.x, paneClose.y)).toBe('pane-header')

  // ...and the window's own buttons still answer for theirs. An `inset-x-0`
  // header that only padded its right edge would silently take these.
  const close = await centerOf('[data-titlebar-controls] button[aria-label="Close"]')
  expect(await topmostAt(close.x, close.y)).toBe('titlebar-controls')
})
