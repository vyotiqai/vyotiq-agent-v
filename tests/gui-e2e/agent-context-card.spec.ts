import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * The empty-session "what the agent knows" strip, asserted on the surface the
 * app actually renders. ChatView delegates to a pane column whenever a pane
 * layout exists — which is always — so a unit test of the card, or of the
 * single-pane branch, proves nothing about what ships. This regressed once by
 * the pane column simply not forwarding `emptyLabel`/`workspacePath`, and the
 * card fails closed (renders nothing), so the omission was silent.
 */

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-agent-context-ws-'))
  mkdirSync(join(workspacePath, '.vyotiq', 'rules'), { recursive: true })
  // Two signals the card must report from real disk state, not placeholders.
  writeFileSync(join(workspacePath, 'AGENTS.md'), '# rules\n', 'utf8')
  writeFileSync(join(workspacePath, '.vyotiq', 'rules', 'style.md'), '- be brief\n', 'utf8')

  launched = await launchApp({})
  const addRes = await launched.window.evaluate(
    async (path) => window.vyotiq.addWorkspace(path),
    workspacePath
  )
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)
  workspacePath = requireActivePath(addRes.data.activePath)

  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true })
    localStorage.removeItem('vyotiq.chatPaneLayout')
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

test('empty new chat shows the agent context card', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) await expand.click()

  // Select the seeded workspace so the card reports its files, not another's.
  await window.getByRole('button', { name: new RegExp(`agent-context-ws`, 'i') }).first().click()

  await expect(window.getByRole('combobox', { name: 'Message' })).toBeVisible({ timeout: 20_000 })

  const emptyState = window.locator('[data-chat-empty-state]')
  await expect(emptyState).toBeVisible({ timeout: 15_000 })
  await expect(emptyState).toContainText(/New chat in/i)

  const card = window.getByRole('group', { name: 'What the agent knows' })
  await expect(card).toBeVisible({ timeout: 15_000 })
  // Seeded rules must surface — proves the card reads live workspace state.
  await expect(card).toContainText('AGENTS.md')
  await expect(card).toContainText(/1 rules/)

  // Every reading is labelled, and the workspace name is NOT repeated here —
  // the heading above already carries it.
  for (const label of ['Branch', 'Rules', 'Memory', 'Index']) {
    await expect(card.getByText(label, { exact: true })).toBeVisible()
  }

  // Layout contract: one row that shrinks, never a wrap and never an
  // overflow. Wrapping is what made this strip look ragged before.
  const box = await card.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    height: (el as HTMLElement).offsetHeight
  }))
  expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth)
  expect(box.height).toBeLessThan(70)
})

test('the strip follows the workspace live, pushed not polled', async () => {
  const { window } = launched
  const card = window.getByRole('group', { name: 'What the agent knows' })
  await expect(card).toBeVisible({ timeout: 15_000 })

  // Count pushes from a second subscriber: proves main emits per real change
  // rather than the card re-reading on a timer.
  await window.evaluate(() => {
    const sink = window as unknown as { __accPushes: unknown[] }
    sink.__accPushes = []
    window.vyotiq.onAgentContextChanged((payload) => {
      sink.__accPushes.push(payload.context)
    })
  })
  const pushes = (): Promise<number> =>
    window.evaluate(() => (window as unknown as { __accPushes: unknown[] }).__accPushes.length)

  // Nothing has been written yet, so nothing should have been pushed.
  await expect(card).toContainText('None')
  expect(await pushes()).toBe(0)

  // 1. First memory note — the directory does not exist yet, so this also
  //    proves the watcher arms paths that appear after it started.
  mkdirSync(join(workspacePath, '.vyotiq', 'memory'), { recursive: true })
  writeFileSync(join(workspacePath, '.vyotiq', 'memory', 'note.md'), '- remembered\n', 'utf8')
  await expect(card).toContainText('1 note', { timeout: 15_000 })
  expect(await pushes()).toBe(1)

  // 2. A rule file appearing at the workspace root.
  writeFileSync(join(workspacePath, '.cursorrules'), 'be brief\n', 'utf8')
  await expect(card).toContainText('.cursorrules', { timeout: 15_000 })
  expect(await pushes()).toBe(2)

  // 3. `git init` in a workspace that was not a repo: the branch reading has
  //    to stop saying "Not a repo" even though `.git` did not exist when the
  //    watcher started, and even though branch reads are cached.
  await expect(card).toContainText('Not a repo')
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: workspacePath, stdio: 'ignore' })
  }
  git('init', '-q')
  git('config', 'user.email', 'e2e@example.com')
  git('config', 'user.name', 'e2e')
  git('checkout', '-q', '-b', 'live-branch')
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')
  await expect(card).toContainText('live-branch', { timeout: 20_000 })

  // 4. Quiet workspace stays quiet — no polling loop behind the strip.
  const settled = await pushes()
  await window.waitForTimeout(2_000)
  expect(await pushes()).toBe(settled)

  // Everything above is still on screen together, from one initial read.
  await expect(card).toContainText('live-branch')
  await expect(card).toContainText('.cursorrules')
  await expect(card).toContainText('1 note')
})
