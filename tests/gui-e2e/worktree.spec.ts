import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * New worktree, end to end, against a real repository: New task makes a
 * branch in a folder of its own and starts the task there; the parent is left
 * alone; Merge brings the work into main; Remove deletes folder and branch.
 */
let launched: LaunchedApp
let repo: string

const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true })

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'vyotiq-worktree-e2e-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'E2E')
  git('config', 'user.email', 'e2e@example.com')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'a.txt'), 'a0\n', 'utf8')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  // Uncommitted here: it must not follow the task into its worktree.
  writeFileSync(join(repo, 'a.txt'), 'mine, uncommitted\n', 'utf8')

  launched = await launchApp({ e2eFixture: true })
  const added = await launched.window.evaluate((path) => window.vyotiq.addWorkspace(path), repo)
  if (!added.ok) throw new Error(added.error)
  repo = requireActivePath(added.data.activePath)
  await launched.window.evaluate(() => localStorage.removeItem('vyotiq.chatPaneLayout'))
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(repo, { recursive: true, force: true })
})

const BRANCH = 'vyotiq/add-backpressure-to-the-chat-stream'

test('a task in a new worktree: started there, merged into main, then removed', async () => {
  const page = launched.window
  await page.keyboard.press('Control+n')
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Where it works' }).click({ timeout: 20_000 })
  await page.getByRole('option', { name: 'New worktree' }).click()
  const sees = page.getByRole('complementary', { name: 'What the agent will see' })
  await expect(sees).toContainText('New worktree')
  await expect(sees).toContainText('from main · 1 uncommitted file stays here')
  await expect(page.locator('[data-new-task]')).toContainText('Plans, edits files and runs commands in the new worktree')

  // Put aside and continued: the draft is the parent's, and starting spends it there.
  await brief.fill('Add backpressure to the chat stream')
  await page.getByRole('button', { name: 'Save as draft' }).click()
  await expect(brief).toHaveText('')
  await page.locator('[data-nav-section="drafts"]').getByRole('button', { name: 'Add backpressure to the chat stream' }).click()
  await expect(brief).toHaveText('Add backpressure to the chat stream', { timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Where it works' })).toHaveText('This folder')
  await page.getByRole('button', { name: 'Where it works' }).click()
  await page.getByRole('option', { name: 'New worktree' }).click()
  await brief.press('Control+Enter')
  await expect(page.getByText('E2E fixture response.')).toBeVisible({ timeout: 30_000 })

  // The branch exists, checked out in a folder under the app's data — not in the project.
  expect(git('branch', '--list', BRANCH).trim()).toContain(BRANCH)
  const info = await page.evaluate(async (path) => {
    const ws = await window.vyotiq.getWorkspaces()
    const open = ws.ok ? ws.data.openPaths : []
    const wt = open.find((p) => p.includes('task-worktrees'))
    const res = wt ? await window.vyotiq.taskWorktreeInfo(wt) : null
    return { active: ws.ok ? ws.data.activePath : null, open, parent: path, info: res && res.ok ? res.data : null }
  }, repo)
  expect(info.info).toMatchObject({ branch: BRANCH, baseBranch: 'main', ahead: 0, uncommitted: 0 })
  const worktreePath = info.info!.workspacePath
  expect(info.active).toBe(worktreePath)
  expect(worktreePath.startsWith(repo)).toBe(false)
  // It started from main's last commit; the parent kept its uncommitted edit.
  expect(readFileSync(join(worktreePath, 'a.txt'), 'utf8')).toBe('a0\n')
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('mine, uncommitted\n')

  // The task says where it works.
  const header = page.locator('[data-task-header]')
  await expect(header.getByTitle('Worktree branch')).toHaveText(BRANCH)
  const strip = page.locator('[data-task-worktree]')
  await expect(strip).toContainText('Works in its own worktree, from main · nothing to merge yet')
  await expect(strip.getByRole('button', { name: 'Merge into main' })).toBeDisabled()

  // What the task would have written (the fixture model writes nothing).
  writeFileSync(join(worktreePath, 'c.txt'), 'c1\n', 'utf8')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(strip).toContainText('· 1 uncommitted file', { timeout: 15_000 })

  // Merge needs a clean tree where it lands: commit the parent's edit first.
  git('commit', '-q', '-am', 'mine')
  const title = (await header.getByRole('heading', { level: 1 }).textContent())?.trim() ?? ''
  await strip.getByRole('button', { name: 'Merge into main' }).click()
  const merge = page.getByRole('dialog', { name: 'Merge into main?' })
  await expect(merge).toContainText(`Commits the 1 uncommitted file as “${title}”, then merges ${BRANCH} into main`)
  await merge.getByRole('button', { name: 'Merge' }).click()
  await expect(page.getByText('Merged 1 commit into main')).toBeVisible({ timeout: 30_000 })
  expect(readFileSync(join(repo, 'c.txt'), 'utf8')).toBe('c1\n')
  expect(git('log', '--format=%s', '-3')).toContain(title)
  await expect(strip).toContainText('Merged into main. The worktree has nothing main doesn’t.', { timeout: 15_000 })

  // Remove: the workspace closes, the folder and the branch go.
  await strip.getByRole('button', { name: 'Remove worktree' }).click()
  const remove = page.getByRole('dialog', { name: 'Remove this worktree?' })
  await remove.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByText(`Removed the worktree ${BRANCH}`)).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => existsSync(info.info!.worktreeRoot)).toBe(false)
  expect(git('branch', '--list', BRANCH).trim()).toBe('')
  const after = await page.evaluate(() => window.vyotiq.getWorkspaces())
  expect(after.ok && after.data.openPaths.includes(worktreePath)).toBe(false)
  expect(after.ok && after.data.activePath).toBe(repo)
  // Main keeps what was merged.
  expect(readFileSync(join(repo, 'c.txt'), 'utf8')).toBe('c1\n')

  // Back in the parent: its draft was spent and its New task page is empty, set to this folder again.
  const parentDrafts = await page.evaluate(async (path) => {
    const res = await window.vyotiq.listTaskDrafts(path)
    return res.ok ? res.data.drafts.length : -1
  }, repo)
  expect(parentDrafts).toBe(0)
  await page.keyboard.press('Control+n')
  await expect(brief).toHaveText('', { timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'Where it works' })).toHaveText('This folder')
})
