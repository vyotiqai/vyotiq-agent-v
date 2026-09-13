import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedWorkspacesRegistry } from './helpers/seedWorkspace'

let launched: LaunchedApp
let workspacePath: string

async function openFilesPanel(window: Page): Promise<void> {
  const panel = window.getByRole('tabpanel', { name: 'Files' })
  if (await panel.isVisible()) return
  const filesButton = window.getByRole('button', { name: /Show files panel/i })
  await expect(filesButton).toBeVisible({ timeout: 20_000 })
  await filesButton.click()
  await expect(panel).toBeVisible()
}

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-files-gui-'))
  mkdirSync(join(workspacePath, 'src'), { recursive: true })
  mkdirSync(join(workspacePath, 'pkg', 'lib'), { recursive: true })
  mkdirSync(join(workspacePath, 'vault'), { recursive: true })
  writeFileSync(join(workspacePath, 'src', 'note.ts'), 'export const value = 1\n', 'utf8')
  writeFileSync(join(workspacePath, 'pkg', 'lib', 'util.ts'), 'export const util = 1\n', 'utf8')
  writeFileSync(join(workspacePath, 'vault', 'secret.ts'), 'export const secret = 1\n', 'utf8')
  writeFileSync(
    join(workspacePath, 'pkg', 'lib', 'wrapped.ts'),
    `// ${'word '.repeat(80)}\nexport const wrapped = 1\n`,
    'utf8'
  )
  writeFileSync(join(workspacePath, '.hidden.txt'), 'hidden\n', 'utf8')
  launched = await launchApp({
    preLaunchSeed: (userDataDir) => seedWorkspacesRegistry(userDataDir, workspacePath, null)
  })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  if (workspacePath) rmSync(workspacePath, { recursive: true, force: true })
})

test('opens Files, edits a real workspace file, and saves it', async () => {
  const { window } = launched
  await openFilesPanel(window)

  await expect(window.getByText('src')).toBeVisible()
  await window.getByText('src').click()
  await expect(window.getByText('note.ts')).toBeVisible()
  await window.getByText('note.ts').click()
  await expect(window.getByRole('tab', { name: /note\.ts/i })).toBeVisible()

  await window.getByRole('button', { name: 'Editor actions' }).click()
  await expect(window.getByRole('menu', { name: 'Editor actions' })).toBeVisible()
  await expect(window.getByRole('menuitem', { name: 'Diff View' })).toBeVisible()
  await expect(window.getByRole('menuitemcheckbox', { name: 'Auto Save' })).toBeVisible()
  await window.keyboard.press('Escape')

  const editor = window.locator('[data-code-editor] .cm-content')
  await expect(editor).toBeVisible()
  await editor.click()
  // macOS maps select-all to Cmd+A; Ctrl+A moves the caret there, leaving
  // the original line above the typed one (CI run 33609263586 retry #1:
  // received file kept "export const value = 1\n" before the new line).
  await window.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await window.keyboard.type('export const value = 2\n')

  await expect
    .poll(async () => {
      return readFileSync(join(workspacePath, 'src', 'note.ts'), 'utf8')
    }, { timeout: 10_000 })
    .toBe('export const value = 2\n')

  const treeNote = window.locator('[role="treeitem"]').filter({ hasText: 'note.ts' })
  await treeNote.click({ button: 'right' })
  await expect(window.getByRole('menu', { name: 'Files actions' })).toBeVisible()
  await expect(window.getByRole('menuitem', { name: 'Copy relative path' })).toBeVisible()
  await window.keyboard.press('Escape')
})

test('reveals nested files when switching tabs', async () => {
  const { window } = launched
  await openFilesPanel(window)

  await window.getByText('pkg').click()
  await window.getByText('lib').click()
  await window.getByText('util.ts').click()
  await expect(window.getByRole('tab', { name: /util\.ts/i })).toBeVisible()

  await window.getByText('src').click()
  await window.getByText('note.ts').click()
  await expect(window.getByRole('tab', { name: /note\.ts/i })).toBeVisible()

  const pkgTreeItem = window.locator('[role="treeitem"]').filter({ hasText: /^pkg$/ })
  await pkgTreeItem.click()

  await window.getByRole('tab', { name: /util\.ts/i }).click()
  await expect(window.locator('[role="treeitem"]').filter({ hasText: 'util.ts' })).toBeVisible()
  await expect(
    window.locator('[role="treeitem"][aria-selected="true"]').filter({ hasText: 'util.ts' })
  ).toBeVisible()
})

test('keeps the active file highlighted while browsing folders', async () => {
  const { window } = launched
  await openFilesPanel(window)

  await window.getByText('src').click()
  await window.getByText('note.ts').click()
  await expect(window.getByRole('tab', { name: /note\.ts/i })).toBeVisible()

  await window.locator('[role="treeitem"]').filter({ hasText: /^src$/ }).click()

  await expect(
    window.locator('[role="treeitem"][aria-selected="true"]').filter({ hasText: 'note.ts' })
  ).toBeVisible()
})

test('filter reveals deeply nested files', async () => {
  const { window } = launched
  await openFilesPanel(window)

  const secretTreeItem = window.locator('[role="treeitem"]').filter({ hasText: 'secret.ts' })
  await expect(secretTreeItem).not.toBeVisible()

  await window.getByRole('textbox', { name: 'Filter workspace files' }).fill('secret.ts')
  await expect(secretTreeItem).toBeVisible({
    timeout: 10_000
  })
})

test('word wrap removes horizontal editor scrolling', async () => {
  const { window } = launched
  await openFilesPanel(window)

  await window.getByRole('textbox', { name: 'Filter workspace files' }).fill('wrapped.ts')
  const wrappedTreeItem = window.locator('[role="treeitem"]').filter({ hasText: 'wrapped.ts' })
  await expect(wrappedTreeItem).toBeVisible({ timeout: 10_000 })
  await wrappedTreeItem.getByRole('button').click()
  await expect(window.getByRole('tab', { name: /wrapped\.ts/i })).toBeVisible()

  const scroller = window.locator('[data-code-editor] .cm-scroller')
  await expect(scroller).toBeVisible()

  await window.getByRole('button', { name: 'Wrap', exact: true }).click()
  await expect(window.getByRole('button', { name: 'Wrap', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )

  await expect(window.locator('[data-code-editor]')).toHaveAttribute('data-word-wrap', 'true')
  await expect
    .poll(async () =>
      scroller.evaluate((node) => {
        const element = node as HTMLElement
        return element.scrollWidth <= element.clientWidth + 1
      })
    )
    .toBe(true)
})
