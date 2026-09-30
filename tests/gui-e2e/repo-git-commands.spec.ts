import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

/**
 * A folder someone hands you carries its .git/config, and git runs the
 * programs named there on a plain `git status`. Two doors, both proven in the
 * running app with a program that only drops a marker file:
 * - the app's own git in an open workspace skips them until allowed, and
 * - a vyotiq:// link can't open a folder you never opened without asking.
 */

let launched: LaunchedApp
let root: string
let repo: string
let markers: string
let stranger: string

function git(args: string[], cwd = repo): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function ran(): string[] {
  return existsSync(markers) ? readdirSync(markers).sort() : []
}

function marker(name: string, tail: string): string {
  return `sh -c 'echo ran >> "${markers.replace(/\\/g, '/')}/${name}"; ${tail}'`
}

async function activateWorkspace(page: Page, path: string): Promise<void> {
  const res = await page.evaluate(async (target) => window.vyotiq.setActiveWorkspace(target), path)
  expect(res.ok).toBe(true)
  await page.evaluate(() => localStorage.removeItem('vyotiq.chatPaneLayout'))
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.getByRole('combobox', { name: 'Brief' })).toBeVisible({ timeout: 20_000 })
}

/** Deliver a link the way Windows and Linux do: in a second instance's argv. */
async function openLink(url: string): Promise<void> {
  await launched.app.evaluate(({ app }, link) => {
    app.emit('second-instance', {}, ['vyotiq', link], process.cwd())
  }, url)
}

async function openPaths(page: Page): Promise<string[]> {
  const res = await page.evaluate(async () => window.vyotiq.getWorkspaces())
  if (!res.ok) throw new Error(res.error)
  return res.data.openPaths
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'vyotiq-repo-cmds-'))
  repo = join(root, 'repo')
  markers = join(root, 'markers')
  stranger = join(root, 'from-a-link')
  mkdirSync(repo)
  mkdirSync(markers)
  mkdirSync(stranger)
  git(['init', '-q', '.'])
  git(['config', 'user.email', 'e2e@example.com'])
  git(['config', 'user.name', 'e2e'])
  writeFileSync(join(repo, '.gitattributes'), 'a.txt filter=x\n')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'init'])
  // What a handed-over folder could carry. Armed after the commit so setup
  // itself runs none of it.
  git(['config', 'core.fsmonitor', marker('fsmonitor', 'false')])
  git(['config', 'filter.x.clean', marker('clean', 'cat')])
  // Same size as before, so a status has to re-read it — that's when clean runs.
  writeFileSync(join(repo, 'a.txt'), 'two\n')

  launched = await launchApp({})
  const added = await launched.window.evaluate(async (target) => window.vyotiq.addWorkspace(target), repo)
  if (!added.ok) throw new Error(added.error)
  repo = added.data.activePath ?? repo
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(root, { recursive: true, force: true })
})

test('Changes skips the programs a repository names, and runs them once allowed', async () => {
  const { window } = launched
  await activateWorkspace(window, repo)
  await window.keyboard.press('Alt+1')
  const panel = window.locator('#dock-panel-changes')
  await expect(panel).toBeVisible({ timeout: 20_000 })

  const notice = panel.locator('[data-repo-commands]')
  await expect(notice).toBeVisible({ timeout: 15_000 })
  await expect(notice).toContainText("This repository's git settings run programs. Vyotiq's git skips them.")
  await expect(notice).toContainText('core.fsmonitor')
  await expect(notice).toContainText('filter.x.clean')
  // The change still shows: status worked without them. Changes opens on
  // this task's edits; the working tree is one click away.
  await panel.getByRole('button', { name: 'Show uncommitted instead' }).click()
  await expect(panel).toContainText('a.txt', { timeout: 15_000 })
  // Everything the app ran in this repository so far ran none of them.
  expect(ran()).toEqual([])

  await notice.getByRole('button', { name: 'Allow for this repo' }).click()
  const confirm = window.getByRole('dialog', { name: 'Allow for this repository' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Allow' }).click()

  await expect(notice).toHaveCount(0, { timeout: 15_000 })
  // The status read after allowing runs the repository's own fsmonitor.
  await expect.poll(() => ran(), { timeout: 15_000 }).toContain('fsmonitor')
})

test('a link asks before it opens a folder you never opened', async () => {
  const { window } = launched
  const url = `vyotiq://run/e2e-link-run?ws=${encodeURIComponent(stranger)}`
  expect(await openPaths(window)).not.toContain(stranger)

  await openLink(url)
  const ask = window.getByRole('dialog', { name: 'Open a folder from a link' })
  await expect(ask).toBeVisible({ timeout: 15_000 })
  await expect(ask.locator('[data-link-folder]')).toContainText('from-a-link')
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(ask).toHaveCount(0)
  expect((await openPaths(window)).some((p) => p.toLowerCase() === stranger.toLowerCase())).toBe(false)

  await openLink(url)
  await expect(ask).toBeVisible({ timeout: 15_000 })
  await ask.getByRole('button', { name: 'Open folder' }).click()
  await expect
    .poll(async () => (await openPaths(window)).some((p) => p.toLowerCase() === stranger.toLowerCase()), {
      timeout: 15_000
    })
    .toBe(true)

  // A folder that is already a workspace opens without asking.
  await openLink(`vyotiq://run/e2e-link-run?ws=${encodeURIComponent(repo)}`)
  await window.waitForTimeout(1_000)
  await expect(ask).toHaveCount(0)
})
