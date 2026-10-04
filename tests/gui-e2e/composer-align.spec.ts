import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import {
  requireActivePath,
  seedRunsInUserData,
  seedWorkspacesRegistry,
  sessionsRootFor
} from './helpers/seedWorkspace'

/**
 * The instruction line is the record's own column: the composer's column
 * centres on the record column's left edge, and its box lands on the brief
 * card's and the step rows' edge — at a wide and at a narrow window.
 *
 * The record is a scrollport with `[scrollbar-gutter:stable]` (8px reserved,
 * `RecordLayout.tsx`); the composer is not, so it reserves the same 8px as
 * padding (`COMPOSER_GUTTER`) and takes the card's 8px bleed
 * (`COMPOSER_BOX_BLEED`). Both edges must hold within 1px.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-composer-align-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({
    e2eFixture: true,
    fixtureFile: 'tests/gui-e2e/fixtures/record-polish.json'
  })
  const addRes = await launched.window.evaluate(async (path) => {
    return window.vyotiq.addWorkspace(path)
  }, workspacePath)
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)
  workspacePath = requireActivePath(addRes.data.activePath)
  await launched.window.evaluate(async () => {
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
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

type Align = {
  innerWidth: number
  recordColumnLeft: number | null
  briefLeft: number | null
  briefRight: number | null
  composerColumnLeft: number | null
  composerShellLeft: number | null
  composerShellRight: number | null
}

async function setWindowWidth(width: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, w) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: w, height: 1000 })
  }, width)
  await launched.window.waitForTimeout(400)
}

/** The four edges, in renderer CSS px, rounded to the half-pixel. */
async function measure(page: Page, label: string): Promise<Align> {
  const m = await page.evaluate(() => {
    const rect = (el: Element | null) => (el ? el.getBoundingClientRect() : null)
    const round = (n: number | undefined) => (n === undefined ? null : +n.toFixed(2))
    const scroll = document.querySelector('[data-record-scroll]')
    const recordColumn = rect(scroll?.firstElementChild ?? null)
    const brief = rect(scroll?.querySelector('[data-brief]') ?? null)
    const composerColumn = rect(document.querySelector('[data-composer-column]'))
    const composerShell = rect(document.querySelector('[data-composer-line] [data-composer-shell]'))
    return {
      innerWidth: window.innerWidth,
      recordColumnLeft: round(recordColumn?.left),
      briefLeft: round(brief?.left),
      briefRight: round(brief?.right),
      composerColumnLeft: round(composerColumn?.left),
      composerShellLeft: round(composerShell?.left),
      composerShellRight: round(composerShell?.right)
    }
  })
  console.log('COMPOSER_ALIGN ' + label + ' ' + JSON.stringify(m))
  return m
}

function withinOnePx(name: string, a: number | null, b: number | null): void {
  expect(a, `${name}: first measurement`).not.toBeNull()
  expect(b, `${name}: second measurement`).not.toBeNull()
  const delta = Math.abs((a as number) - (b as number))
  expect(delta, `${name} (${a} vs ${b}, delta ${delta.toFixed(2)}px)`).toBeLessThanOrEqual(1)
}

test('the composer column and box sit on the record column and card edges', async () => {
  test.setTimeout(120_000)
  const page = launched.window

  const expand = page.getByRole('button', { name: /show navigator/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }

  await setWindowWidth(1600)
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await brief.fill('Run the suite and report')
  await brief.press('Control+Enter')

  // The record's brief card and step rows exist once the run asks for you.
  await expect(page.locator('[data-needs-you]')).toBeVisible({ timeout: 30_000 })
  // The composer's column is the record's column: centred inside the gutter.
  await expect(page.locator('[data-composer-gutter] [data-composer-column]')).toHaveCount(1)

  for (const width of [1600, 1200]) {
    await setWindowWidth(width)
    const label = `width-${width}`
    const m = await measure(page, label)
    withinOnePx(
      `${label} composer column left == record column left`,
      m.composerColumnLeft,
      m.recordColumnLeft
    )
    withinOnePx(`${label} composer box left == record card left`, m.composerShellLeft, m.briefLeft)
    withinOnePx(
      `${label} composer box right == record card right`,
      m.composerShellRight,
      m.briefRight
    )
  }
})

// ─────────────────────────────────────────────────────────────────────────────
test.describe('the goal band and the composer share one column', () => {
  const RUN_ID = 'run-composer-align-goal'
  const GOAL = 'Keep the goal band on the instruction line'
  let bandLaunched: LaunchedApp
  let bandWorkspace: string

  test.beforeAll(async () => {
    bandWorkspace = mkdtempSync(join(tmpdir(), 'vyotiq-goal-align-ws-'))
    mkdirSync(bandWorkspace, { recursive: true })
    bandLaunched = await launchApp({
      preLaunchSeed: (userDataDir) => {
        // status.json + messages.jsonl, so the run is listed and opens on boot.
        seedRunsInUserData(userDataDir, bandWorkspace, [
          { runId: RUN_ID, goal: GOAL, updatedAt: new Date().toISOString() }
        ])
        // goal.json is what useRunGoal polls (readRunArtifact). parseGoal wants
        // objective + status in proposed|active|paused|complete + createdAt /
        // updatedAt; `active` is the state that draws Pause / Mark complete,
        // so the band renders with its controls.
        const at = new Date().toISOString()
        writeFileSync(
          join(sessionsRootFor(userDataDir, bandWorkspace), RUN_ID, 'goal.json'),
          JSON.stringify({ objective: GOAL, status: 'active', createdAt: at, updatedAt: at }),
          'utf8'
        )
        seedWorkspacesRegistry(userDataDir, bandWorkspace, RUN_ID)
      }
    })
    await expect(bandLaunched.window.locator('body')).toBeVisible({ timeout: 30_000 })
  })

  test.afterAll(async () => {
    if (bandLaunched) await closeApp(bandLaunched)
    try {
      rmSync(bandWorkspace, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  async function setWidth(width: number): Promise<void> {
    await bandLaunched.app.evaluate(({ BrowserWindow }, w) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: w, height: 1000 })
    }, width)
    await bandLaunched.window.waitForTimeout(400)
  }

  test('the band box, its text and its column land on the composer box, its text and its column', async () => {
    test.setTimeout(180_000)
    const page = bandLaunched.window

    const expand = page.getByRole('button', { name: /show navigator/i })
    if (await expand.isVisible().catch(() => false)) await expand.click()

    await setWidth(1600)
    // The band has to be on screen before anything is measured: without it
    // every comparison below would read null and pass vacuously.
    await expect(page.locator('[data-goal-banner]')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-goal-gutter]')).toHaveCount(1)
    await expect(page.locator('[data-goal-column]')).toHaveCount(1)
    await expect(page.locator('[data-goal-banner]')).toHaveAttribute('data-goal-status', 'active')
    await expect(page.locator('[data-composer-gutter] [data-composer-column]')).toHaveCount(1)

    for (const width of [1600, 1200]) {
      await setWidth(width)
      const label = `goal-width-${width}`
      const m = await page.evaluate(() => {
        const rect = (el: Element | null) => (el ? el.getBoundingClientRect() : null)
        const round = (n: number | undefined) => (n === undefined ? null : +n.toFixed(2))
        const band = document.querySelector('[data-goal-banner]')
        const shell = document.querySelector('[data-composer-line] [data-composer-shell]')
        // The compared elements, named exactly:
        //  - band: `band.firstElementChild` — the flag Icon, the first thing in
        //    the band's `px-3` content box, so its left IS the band's content
        //    edge. (The `Goal` state word is NOT that: it sits behind a 13px
        //    icon and a 10px gap, and is logged below as `goalStateWordLeft`.)
        //  - composer: `[data-composer-input]`, the contenteditable field inside
        //    the shell's `px-3 pt-2.5` field wrapper, i.e. its text edge.
        const bandContent = band?.firstElementChild ?? null
        const composerText = shell?.querySelector('[data-composer-input]') ?? null
        const bandStateWord = band?.querySelector('span') ?? null
        const bandRect = rect(band)
        const shellRect = rect(shell)
        const bandContentRect = rect(bandContent)
        const composerTextRect = rect(composerText)
        return {
          innerWidth: window.innerWidth,
          goalStatus: band?.getAttribute('data-goal-status') ?? null,
          goalBandLeft: round(bandRect?.left),
          goalBandRight: round(bandRect?.right),
          composerShellLeft: round(shellRect?.left),
          composerShellRight: round(shellRect?.right),
          goalTextLeft: round(bandContentRect?.left),
          composerTextLeft: round(composerTextRect?.left),
          goalStateWordLeft: round(rect(bandStateWord)?.left),
          goalColumnLeft: round(rect(document.querySelector('[data-goal-column]'))?.left),
          composerColumnLeft: round(
            rect(document.querySelector('[data-composer-column]'))?.left
          )
        }
      })
      console.log('COMPOSER_ALIGN ' + label + ' ' + JSON.stringify(m))

      expect(m.goalStatus, `${label} band status`).toBe('active')
      withinOnePx(`${label} band left == composer box left`, m.goalBandLeft, m.composerShellLeft)
      withinOnePx(`${label} band right == composer box right`, m.goalBandRight, m.composerShellRight)
      withinOnePx(`${label} band text left == composer text left`, m.goalTextLeft, m.composerTextLeft)
      withinOnePx(
        `${label} band column left == composer column left`,
        m.goalColumnLeft,
        m.composerColumnLeft
      )
    }
  })
})
