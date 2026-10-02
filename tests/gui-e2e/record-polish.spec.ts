import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * The record's reading aids in the real window, through one live run
 * (fixtures/record-polish.json): a poll repeated unchanged folds to one line,
 * the streaming thought is the Now line, "Jump to now" brings back a live run
 * you scrolled away from, the plan line goes to its step, a Result of several
 * parts copies by section with its marks set as type, and reasoning hides
 * from the task menu. Screens of the default skin in both themes are kept
 * with the test's output.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-record-polish-ws-'))
  launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/record-polish.json' })
  const added = await launched.window.evaluate((path) => window.vyotiq.addWorkspace(path), workspacePath)
  if (!added.ok) throw new Error(added.error)
  workspacePath = requireActivePath(added.data.activePath)
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ skinId: 'default', theme: 'dark', showThinking: true })
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(workspacePath, { recursive: true, force: true })
})

const record = (page: Page) => page.locator('[data-record-scroll]').first()

async function atBottom(page: Page): Promise<boolean> {
  return record(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 4)
}

test('a live run reads at a glance, and can be found again from anywhere in it', async () => {
  const page = launched.window
  // A short window, so the live work is below the record's first screen.
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1280, height: 620 })
  })
  await page.keyboard.press('Control+n')
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await brief.fill('Run the suite and report')
  await brief.press('Control+Enter')

  // Five identical polls: the first four are one line above the last.
  const step2 = page.locator('[data-step="2"]')
  const repeats = step2.locator('[data-record-repeats]')
  await expect(repeats).toBeVisible({ timeout: 30_000 })
  await expect(repeats).toContainText('4 earlier runs')
  await expect(repeats).toContainText('of the same command')
  await expect(step2.getByText('POLL_THOUGHT_5', { exact: false })).toBeVisible()
  await expect(step2.getByText('POLL_THOUGHT_2', { exact: false })).toHaveCount(0)
  // The navigator keeps pace with the record: the run is under Running at once, not at its next poll.
  const tasks = page.getByRole('navigation', { name: 'Tasks' }).first()
  await expect(tasks).toContainText('Running', { timeout: 3_000 })

  // The thought streaming now is the Now line.
  const now = page.locator('[aria-live="polite"]').filter({ hasText: 'NOW_THOUGHT' })
  await expect(now).toBeVisible({ timeout: 20_000 })
  await expect(now).toContainText('Now')
  await page.screenshot({ path: test.info().outputPath('live-now-dark.png') })

  // The run waits on you; it is still live.
  const card = page.locator('[data-needs-you]')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()

  // Scrolled away from it, the way back appears; taking it follows the run again.
  const jump = page.locator('[data-jump-to-now]')
  await record(page).hover()
  await page.mouse.wheel(0, -4000)
  await expect(jump).toBeVisible({ timeout: 5_000 })
  await expect(jump).toContainText('Jump to now')
  await page.screenshot({ path: test.info().outputPath('jump-to-now-dark.png') })
  await jump.click()
  await expect(jump).toBeHidden({ timeout: 5_000 })
  await expect.poll(() => atBottom(page), { timeout: 5_000 }).toBe(true)

  // The plan line goes to a step: the first, folded since it finished, opens.
  const plan = page.getByRole('toolbar', { name: /^Plan · Step 3 of 3$/ })
  await expect(plan).toBeVisible()
  const first = plan.locator('button[data-plan-step]').first()
  await expect(first).toHaveAttribute('aria-label', 'Go to step 1. Start the suite detached, done')
  await first.click()
  const step1 = page.locator('[data-step="1"]')
  await expect(step1.locator('button[aria-expanded="true"]')).toHaveCount(1)
  await expect(step1).toBeInViewport()
  // The step's title is words: its plan's markdown never reaches the page.
  await expect(step1).toContainText('Start the suite detached')
  await expect(step1).not.toContainText('**')

  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(page.getByText('POLISH_DONE', { exact: false })).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-jump-to-now]')).toHaveCount(0)
  // …and lets go of it as soon: no longer running, its last call no longer its activity.
  await expect(tasks).not.toContainText('Running', { timeout: 3_000 })
})

test('the Result copies by section, its marks set as type, and reasoning hides from the menu', async () => {
  const page = launched.window
  const result = page.locator('section[aria-label="Result"]')
  await expect(result).toBeVisible({ timeout: 30_000 })
  await expect(result.locator('[data-section-copy]')).toHaveCount(3)
  await expect(result.locator('.markdown-body')).toHaveAttribute('data-tone', 'strong')
  await expect(result).not.toContainText('**')
  await expect(result).not.toContainText('[[')
  // The citation opens its file, as a chip a step down from the answer's ink.
  const cite = result.getByRole('button', { name: 'src/main/agent/loop.ts:12' })
  await expect(cite).toBeVisible()
  const ink = await cite.evaluate((el) => {
    const prose = getComputedStyle(el.closest('.markdown-body')!).color
    return { chip: getComputedStyle(el).color, prose }
  })
  expect(ink.chip).not.toBe(ink.prose)

  // Hovered, a heading shows its copy.
  const heading = result.getByRole('heading', { name: /Changes/ })
  await heading.hover()
  await expect(heading.getByRole('button', { name: 'Copy this section' })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('result-dark.png') })

  // Reasoning: the settled step that polled holds its thoughts until hidden.
  const step2 = page.locator('[data-step="2"]')
  await step2.locator('button[aria-expanded="false"]').first().click()
  await expect(step2.locator('[data-record-thought]').first()).toBeVisible()
  await page.getByRole('button', { name: /^More — / }).click()
  await page.getByRole('menuitem', { name: 'Hide reasoning' }).click()
  await expect(page.locator('[data-record-thought]')).toHaveCount(0)
  await expect(step2.locator('[data-record-repeats]')).toBeVisible()
  await page.getByRole('button', { name: /^More — / }).click()
  await page.getByRole('menuitem', { name: 'Show reasoning' }).click()
  await expect(step2.locator('[data-record-thought]').first()).toBeVisible()

  // What made a long record hard to read, held off for good: a prose line
  // across the whole column, a time on two lines, thoughts in italics, and
  // markdown marks reaching the page.
  const read = await record(page).evaluate((root) => {
    const prose = [...root.querySelectorAll<HTMLElement>('.record-prose > p, .record-prose > ul')]
    const times = [...root.querySelectorAll<HTMLElement>('.tnum')].filter((el) => el.textContent?.trim())
    const thoughts = [...root.querySelectorAll<HTMLElement>('[data-record-thought] button > span:not(.sr-only)')]
    return {
      prose: prose.length,
      unmeasured: prose.filter((el) => getComputedStyle(el).maxWidth === 'none').length,
      wrappedTimes: times.filter((el) => el.getClientRects().length > 1).map((el) => el.textContent),
      italicThoughts: thoughts.filter((el) => getComputedStyle(el).fontStyle !== 'normal').length,
      thoughts: thoughts.length,
      text: (root as HTMLElement).innerText
    }
  })
  expect(read.prose).toBeGreaterThan(0)
  expect(read.unmeasured).toBe(0)
  expect(read.wrappedTimes).toEqual([])
  expect(read.thoughts).toBeGreaterThan(0)
  expect(read.italicThoughts).toBe(0)
  expect(read.text).not.toMatch(/\*\*|\[\[/)

  // Every pane's 40px row ends on one hairline: the navigator's as the task header's.
  const rules = await page.evaluate(() => {
    const line = (sel: string): string | null => {
      const el = document.querySelector(sel)
      return el ? getComputedStyle(el).borderBottomColor : null
    }
    return { navigator: line('[data-navigator-head]'), task: line('[data-task-header]') }
  })
  expect(rules.navigator).not.toBeNull()
  expect(rules.navigator).toBe(rules.task)

  // The same record in the light theme, for the eye.
  await page.evaluate(async () => {
    await window.vyotiq.setSettings({ theme: 'light' })
  })
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light')
  await step2.scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('record-light.png') })
})
