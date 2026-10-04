import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import {
  seedAppSettings,
  seedRunEvents,
  seedRunsInUserData,
  seedWorkspacesRegistry,
  sessionsRootFor
} from './helpers/seedWorkspace'
import { openSettings } from './helpers/settings'

/**
 * The features added in the 2026-10 pass, each driven through the real app:
 * real clicks, real IPC, real files and real git. Only native OS dialogs are
 * stood in for (the save dialog of Export diagnostics), and no model is called
 * (task runs replay the e2e fixture).
 */

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** Directories this spec made under the OS temp dir; only these are removed. */
const madeDirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `vyotiq-audit-${prefix}-`))
  madeDirs.push(dir)
  return dir
}
test.afterAll(() => {
  for (const dir of madeDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a git process may still hold a handle on Windows; best effort */
    }
  }
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
}

async function settingsSection(page: Page, name: string): Promise<void> {
  await openSettings(page)
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name, exact: true }).click()
}

/** Entries of a plain zip (stored or deflate), read the way any unzip tool would. */
function readZip(buf: Buffer): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = []
  let off = 0
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8)
    const size = buf.readUInt32LE(off + 18)
    const nameLen = buf.readUInt16LE(off + 26)
    const extraLen = buf.readUInt16LE(off + 28)
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8')
    const start = off + 30 + nameLen + extraLen
    const body = buf.subarray(start, start + size)
    const data = method === 8 ? inflateRawSync(body) : body
    out.push({ name, text: data.toString('utf8') })
    off = start + size
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Settings: permission rules, sandbox, fallback, diagnostics', () => {
  let launched: LaunchedApp

  test.beforeAll(async () => {
    launched = await launchApp({
      preLaunchSeed: (userDataDir) => seedAppSettings(userDataDir, { navigationMode: 'sidebar', toolApprovalOnboardingDone: true })
    })
    await expect(launched.window.locator('body')).toBeVisible({ timeout: 30_000 })
  })
  test.afterAll(async () => {
    if (launched) await closeApp(launched)
  })

  const readSettings = (page: Page) =>
    page.evaluate(async () => {
      const res = await window.vyotiq.getSettings()
      if (!res.ok) throw new Error(res.error)
      return res.data
    })

  test('Agent → Approvals: a deny rule is added, saved, and removed', async () => {
    const page = launched.window
    await settingsSection(page, 'Agent')
    const field = page.locator('[data-settings-field="permission-rules"]')
    await expect(field).toBeVisible({ timeout: 20_000 })
    await expect(field).toContainText('Permission rules')

    await field.getByRole('radiogroup', { name: 'New rule matches' }).getByRole('radio', { name: 'Path' }).click()
    await field.getByRole('radiogroup', { name: 'New rule effect' }).getByRole('radio', { name: 'Deny' }).click()
    await field.getByRole('textbox', { name: 'New rule path' }).fill('secrets/**')
    await field.getByRole('button', { name: 'Add rule' }).click()

    const list = field.getByRole('list', { name: 'Permission rules' })
    await expect(list).toContainText('secrets/**')
    await expect
      .poll(async () => (await readSettings(page)).toolApproval.rules ?? [], { timeout: 10_000 })
      .toEqual([{ effect: 'deny', path: 'secrets/**' }])

    await field.getByRole('button', { name: 'Remove rule: deny path secrets/**' }).click()
    await expect(field.getByRole('list', { name: 'Permission rules' })).toHaveCount(0)
    await expect.poll(async () => (await readSettings(page)).toolApproval.rules ?? [], { timeout: 10_000 }).toEqual([])
  })

  test('Tools → Sandbox renders, and says why when this OS cannot sandbox', async () => {
    const page = launched.window
    await settingsSection(page, 'Tools')
    const field = page.locator('[data-settings-field="agent-sandbox"]')
    await expect(field).toBeVisible({ timeout: 20_000 })
    const group = field.getByRole('radiogroup', { name: 'Sandbox agent commands' })
    await expect(group).toBeVisible()
    const workspaceOnly = group.getByRole('radio', { name: 'Workspace only' })
    const network = page.locator('[data-settings-field="agent-sandbox-network"]').getByRole('radiogroup', { name: 'Sandboxed command network' })
    await expect(network).toBeVisible()

    const cap = await page.evaluate(async () => {
      const res = await window.vyotiq.getSandboxCapability()
      if (!res.ok) throw new Error(res.error)
      return res.data
    })
    if (process.platform === 'win32') {
      expect(cap.available).toBe(false)
      await expect(field).toContainText('Windows has no built-in way to confine')
      await expect(workspaceOnly).toBeDisabled()
      await expect(group).toHaveAttribute('aria-disabled', 'true')
      // Off by default, so its network choice has nothing to apply to.
      await expect(network.getByRole('radio', { name: 'Deny' })).toBeDisabled()
    } else if (cap.available) {
      await expect(workspaceOnly).toBeEnabled()
    } else {
      await expect(workspaceOnly).toBeDisabled()
      await expect(field).toContainText(cap.reason ?? 'cannot sandbox')
    }
  })

  test('Settings search finds sandbox, fallback and permission rows', async () => {
    const page = launched.window
    await openSettings(page)
    const search = page.getByRole('searchbox', { name: 'Search settings' }).or(page.getByRole('textbox', { name: 'Search settings' }))
    const results = page.getByRole('listbox', { name: 'Settings search results' })
    for (const [query, title] of [
      ['sandbox', 'Sandbox commands'],
      ['fallback', 'Fall back when the provider is down'],
      ['permission', 'Permission rules']
    ] as const) {
      await search.first().fill(query)
      await expect(results.getByRole('option', { name: new RegExp(`^${title}`) })).toBeVisible()
    }
    // Picking one goes to its row.
    await results.getByRole('option', { name: /^Permission rules/ }).click()
    await expect(page.locator('[data-settings-field="permission-rules"]')).toBeInViewport({ timeout: 10_000 })
  })

  test('Providers: "Fall back when the provider is down" toggles and persists', async () => {
    const page = launched.window
    await settingsSection(page, 'Providers')
    const field = page.locator('[data-settings-field="model-fallback"]')
    await expect(field).toBeVisible({ timeout: 20_000 })
    const toggle = field.getByRole('switch', { name: 'Fall back when the provider is down' })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect.poll(async () => (await readSettings(page)).modelFallback.enabled, { timeout: 10_000 }).toBe(true)
    // On, it offers the first fallback slot.
    await expect(page.getByRole('button', { name: 'Fallback 1: provider' })).toBeVisible()
    await toggle.click()
    await expect.poll(async () => (await readSettings(page)).modelFallback.enabled, { timeout: 10_000 }).toBe(false)
  })

  test('Diagnostics: Export diagnostics… writes a redacted zip', async () => {
    const page = launched.window
    const outDir = tempDir('diag')
    const zipPath = join(outDir, 'vyotiq-diagnostics-e2e.zip')
    // The save dialog is the OS's; answer it with a path. Revealing the file
    // would open the file manager on the desktop, so that is a no-op here.
    await launched.app.evaluate(({ dialog, shell }, file) => {
      ;(dialog as unknown as { showSaveDialog: (...a: unknown[]) => unknown }).showSaveDialog = async () => ({
        canceled: false,
        filePath: file
      })
      ;(shell as unknown as { showItemInFolder: (p: string) => void }).showItemInFolder = () => {}
    }, zipPath)

    await settingsSection(page, 'Diagnostics')
    const field = page.locator('[data-settings-field="diagnostics-export"]')
    await expect(field).toBeVisible({ timeout: 20_000 })
    await field.getByRole('button', { name: 'Export diagnostics…' }).click()
    await expect(field).toContainText('Saved vyotiq-diagnostics-e2e.zip', { timeout: 30_000 })

    expect(existsSync(zipPath)).toBe(true)
    const entries = readZip(readFileSync(zipPath))
    expect(entries.length).toBeGreaterThan(0)
    const username = userInfo().username.toLowerCase()
    const home = homedir().toLowerCase()
    for (const entry of entries) {
      const lower = entry.text.toLowerCase()
      const homeHits = [home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')].filter((h) => lower.includes(h))
      expect(homeHits, `${entry.name} holds the home folder`).toEqual([])
      if (username.length >= 3) {
        const at = lower.indexOf(username)
        expect(at, `${entry.name} holds the username near: ${entry.text.slice(Math.max(0, at - 60), at + 60)}`).toBe(-1)
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Git sync in Changes', () => {
  let launched: LaunchedApp
  let bare: string
  let workspace: string
  let other: string

  test.beforeAll(async () => {
    const root = tempDir('git')
    bare = join(root, 'remote.git')
    workspace = join(root, 'work')
    other = join(root, 'other')
    const seed = join(root, 'seed')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
    mkdirSync(seed)
    git(seed, 'init', '-q', '-b', 'main')
    git(seed, 'config', 'user.email', 'e2e@example.com')
    git(seed, 'config', 'user.name', 'E2E')
    git(seed, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(seed, 'README.md'), '# Sync\n', 'utf8')
    git(seed, 'add', '-A')
    git(seed, 'commit', '-q', '-m', 'first')
    git(seed, 'remote', 'add', 'origin', bare)
    git(seed, 'push', '-q', 'origin', 'main')
    for (const clone of [workspace, other]) {
      // autocrlf off from the checkout on, or a global `true` leaves README.md
      // with CRLF that then reads as a local change and blocks the pull.
      execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', bare, clone])
      git(clone, 'config', 'user.email', 'e2e@example.com')
      git(clone, 'config', 'user.name', 'E2E')
    }
    launched = await launchApp({
      preLaunchSeed: (userDataDir) => {
        seedAppSettings(userDataDir, { navigationMode: 'sidebar', toolApprovalOnboardingDone: true })
        seedWorkspacesRegistry(userDataDir, workspace, null)
      }
    })
  })
  test.afterAll(async () => {
    if (launched) await closeApp(launched)
  })

  test('fetch shows ↓1, pull fast-forwards, new branch validates and switches, publish pushes', async () => {
    const page = launched.window
    await expect(page.locator('[data-new-task]')).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('Alt+1')
    const panel = page.locator('[data-changes-panel]')
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await panel.getByRole('button', { name: 'Show uncommitted instead' }).click({ timeout: 20_000 })

    const toolbar = panel.locator('[data-changes-toolbar]')
    const branchPicker = toolbar.getByRole('button', { name: /Switch branch/ }).first()
    const sync = toolbar.locator('[data-git-sync]')
    await expect(branchPicker).toBeVisible({ timeout: 20_000 })
    await expect(sync).toBeVisible()
    // Beside the branch picker: same row, right after it.
    const [b, s] = [await branchPicker.boundingBox(), await sync.boundingBox()]
    expect(b && s).toBeTruthy()
    expect(Math.abs(b!.y + b!.height / 2 - (s!.y + s!.height / 2))).toBeLessThan(6)
    expect(s!.x).toBeGreaterThanOrEqual(b!.x + b!.width - 2)
    expect(s!.x - (b!.x + b!.width)).toBeLessThan(24)
    await expect(sync).toHaveAttribute('aria-label', 'Sync — Up to date with origin/main')

    // Someone else pushes a commit.
    writeFileSync(join(other, 'from-other.txt'), 'pushed by the other clone\n', 'utf8')
    git(other, 'add', '-A')
    git(other, 'commit', '-q', '-m', 'from the other clone')
    git(other, 'push', '-q', 'origin', 'main')

    await sync.click()
    const menu = page.getByRole('menu', { name: 'Sync' })
    await menu.getByRole('menuitem', { name: /^Fetch/ }).click()
    await expect(sync.locator('[data-git-behind]')).toHaveText('1', { timeout: 20_000 })
    await expect(sync).toHaveAttribute('aria-label', 'Sync — 1 to pull')

    await sync.click()
    await menu.getByRole('menuitem', { name: /^Pull/ }).click()
    await expect.poll(() => existsSync(join(workspace, 'from-other.txt')), { timeout: 20_000 }).toBe(true)
    await expect(sync.locator('[data-git-behind]')).toHaveCount(0, { timeout: 20_000 })
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(git(other, 'rev-parse', 'HEAD'))

    // New branch…: a bad name is refused in place, a good one switches.
    await sync.click()
    await menu.getByRole('menuitem', { name: /^New branch/ }).click()
    const name = page.getByRole('textbox', { name: 'New branch name' })
    await expect(name).toBeFocused()
    await name.fill('bad..name')
    await expect(name).toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('[data-git-new-branch]')).toContainText('No “..” in a branch name')
    await name.press('Enter')
    expect(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    await name.fill('audit/publish-me')
    await expect(name).not.toHaveAttribute('aria-invalid', 'true')
    await name.press('Enter')
    await expect.poll(() => git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD'), { timeout: 20_000 }).toBe('audit/publish-me')
    await expect(name).toHaveCount(0, { timeout: 10_000 })
    await expect(toolbar.getByRole('button', { name: /Switch branch/ }).first()).toContainText('audit/publish-me', { timeout: 20_000 })

    // Not on the remote yet: Publish branch pushes it.
    await expect(sync).toHaveAttribute('aria-label', /Not published/, { timeout: 20_000 })
    await sync.click()
    await menu.getByRole('menuitem', { name: /^Publish branch/ }).click()
    await expect
      .poll(() => {
        try {
          return execFileSync('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/audit/publish-me'], { encoding: 'utf8' }).trim()
        } catch {
          return ''
        }
      }, { timeout: 20_000 })
      .toBe(git(workspace, 'rev-parse', 'HEAD'))
    await expect(sync).toHaveAttribute('aria-label', 'Sync — Up to date with origin/audit/publish-me', { timeout: 20_000 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Files: highlighting, editor search, replace in files', () => {
  let launched: LaunchedApp
  let workspace: string
  const runId = 'run-audit-files'

  test.beforeAll(async () => {
    workspace = tempDir('files')
    mkdirSync(join(workspace, 'cmd'), { recursive: true })
    writeFileSync(
      join(workspace, 'cmd', 'main.go'),
      'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hello")\n}\n',
      'utf8'
    )
    writeFileSync(
      join(workspace, 'lib.rs'),
      'pub fn add(a: i32, b: i32) -> i32 {\n    let total = a + b;\n    total\n}\n',
      'utf8'
    )
    writeFileSync(join(workspace, 'notes.txt'), 'OLD_TOKEN here\nand OLD_TOKEN there\n', 'utf8')
    writeFileSync(join(workspace, 'more.md'), '# OLD_TOKEN\n', 'utf8')
    writeFileSync(join(workspace, 'untouched.txt'), 'nothing to see\n', 'utf8')
    launched = await launchApp({
      preLaunchSeed: (userDataDir) => {
        seedAppSettings(userDataDir, { navigationMode: 'sidebar', toolApprovalOnboardingDone: true })
        seedRunsInUserData(userDataDir, workspace, [{ runId, goal: 'Read the Go and Rust sources', updatedAt: new Date().toISOString() }])
        seedWorkspacesRegistry(userDataDir, workspace, runId)
      }
    })
  })
  test.afterAll(async () => {
    if (launched) await closeApp(launched)
  })

  async function openFiles(page: Page): Promise<void> {
    const panel = page.getByRole('tabpanel', { name: 'Files' })
    if (await panel.isVisible()) return
    await expect(page.locator('[data-task-pane]').first()).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('Alt+2')
    await expect(panel).toBeVisible({ timeout: 20_000 })
  }

  async function openFile(page: Page, name: string): Promise<void> {
    await page.getByRole('textbox', { name: 'Filter workspace files' }).fill(name)
    const item = page.locator('[role="treeitem"]').filter({ hasText: name })
    await expect(item).toBeVisible({ timeout: 10_000 })
    await item.getByRole('button').first().click()
    await expect(page.getByRole('tab', { name: new RegExp(name.replace('.', '\\.')) })).toBeVisible()
  }

  test('Go and Rust files open highlighted', async () => {
    const page = launched.window
    await openFiles(page)
    const editor = page.locator('[data-code-editor]')
    for (const [file, word] of [
      ['main.go', 'func'],
      ['lib.rs', 'pub']
    ] as const) {
      await openFile(page, file)
      await expect(editor.locator('.cm-content')).toContainText(word)
      // A language mode marks tokens: spans with a class inside the lines.
      await expect
        .poll(async () => editor.locator('.cm-line span[class]').count(), { timeout: 10_000 })
        .toBeGreaterThan(2)
    }
  })

  test('Ctrl+F in the editor opens CodeMirror search, not the record find bar', async () => {
    const page = launched.window
    await openFiles(page)
    await openFile(page, 'main.go')
    const editor = page.locator('[data-code-editor]')
    await editor.locator('.cm-content').click()
    await page.keyboard.press(`${MOD}+F`)
    const search = editor.locator('.cm-search')
    await expect(search).toBeVisible()
    await expect(page.locator('[data-record-find]')).toHaveCount(0)
    await page.keyboard.type('fmt')
    await expect.poll(async () => editor.locator('.cm-searchMatch').count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    // Focus stays in the search field: a late tree reveal must not take it.
    await expect.poll(async () => page.evaluate(() => Boolean(document.activeElement?.closest('.cm-search')))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(search).toHaveCount(0)
    await expect(page.locator('[data-record-find]')).toHaveCount(0)
  })

  test('Replace all in files rewrites the matches on disk after the confirm', async () => {
    const page = launched.window
    await openFiles(page)
    await page.getByRole('textbox', { name: 'Filter workspace files' }).fill('')
    await page.getByRole('button', { name: 'Workspace actions' }).click()
    await page.getByRole('menuitem', { name: 'Find in files' }).click()
    await page.getByRole('textbox', { name: 'Find in files' }).fill('OLD_TOKEN')
    await page.getByRole('button', { name: 'Replace in files' }).click()
    await page.getByRole('textbox', { name: 'Replace with' }).fill('NEW_TOKEN')
    await page.getByRole('button', { name: 'Replace all', exact: true }).first().click()

    const confirm = page.getByRole('dialog', { name: 'Replace in files' })
    await expect(confirm).toBeVisible({ timeout: 20_000 })
    await expect(confirm).toContainText('notes.txt')
    await expect(confirm).toContainText('more.md')
    // Nothing is written before the confirm.
    expect(readFileSync(join(workspace, 'notes.txt'), 'utf8')).toContain('OLD_TOKEN')
    await confirm.getByRole('button', { name: 'Replace all', exact: true }).click()

    await expect
      .poll(() => readFileSync(join(workspace, 'notes.txt'), 'utf8'), { timeout: 20_000 })
      .toBe('NEW_TOKEN here\nand NEW_TOKEN there\n')
    expect(readFileSync(join(workspace, 'more.md'), 'utf8')).toBe('# NEW_TOKEN\n')
    expect(readFileSync(join(workspace, 'untouched.txt'), 'utf8')).toBe('nothing to see\n')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
test.describe('New task folders, help, palette and Usage', () => {
  let launched: LaunchedApp
  let workspace: string
  let extra: string

  test.beforeAll(async () => {
    workspace = tempDir('help')
    extra = tempDir('extra')
    writeFileSync(join(extra, 'shared.txt'), 'shared\n', 'utf8')
    launched = await launchApp({
      preLaunchSeed: (userDataDir) => {
        seedAppSettings(userDataDir, { navigationMode: 'sidebar', toolApprovalOnboardingDone: true })
        // One finished task today that reported usage, so Usage has something to break down.
        const dir = join(sessionsRootFor(userDataDir, workspace), 'run-audit-usage')
        mkdirSync(dir, { recursive: true })
        const now = new Date()
        const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
        const goal = 'Tidy the release checklist'
        writeFileSync(join(dir, 'status.json'), JSON.stringify({ status: 'done', step: 1, updatedAt: now.toISOString(), goal }), 'utf8')
        writeFileSync(join(dir, 'messages.jsonl'), `${JSON.stringify({ role: 'user', content: goal })}\n`, 'utf8')
        writeFileSync(
          join(dir, 'receipt.json'),
          JSON.stringify({
            version: 5,
            writtenAt: now.toISOString(),
            runId: 'run-audit-usage',
            status: 'done',
            step: 1,
            goal,
            compactionCount: 0,
            toolStats: { totalCalls: 1, ok: 1, failed: 0, byName: { read_file: { ok: 1, failed: 0 } } },
            failureClusters: [],
            unreadEditPaths: [],
            wroteFiles: [],
            diagnostics: { calls: 0, ok: 0, clean: 0 },
            contractExcerpt: ''
          }),
          'utf8'
        )
        writeFileSync(
          join(dir, 'usage.json'),
          JSON.stringify({
            version: 1,
            lastTotals: { steps: 1, billedInputTokens: 50_000, outputTokens: 10_000, billedCost: 0.5, estimatedCost: 0, cachedInputTokens: 0, reasoningTokens: 0 },
            days: { [day]: { inputTokens: 50_000, outputTokens: 10_000, billedCost: 0.5 } }
          }),
          'utf8'
        )
        seedWorkspacesRegistry(userDataDir, workspace, null)
      }
    })
  })
  test.afterAll(async () => {
    if (launched) await closeApp(launched)
  })

  test('New task: Add folder… is offered, and /add-dir <path> adds the folder row', async () => {
    const page = launched.window
    const newTask = page.locator('[data-new-task]')
    await expect(newTask).toBeVisible({ timeout: 30_000 })
    await expect(newTask.getByRole('button', { name: 'Add folder…' })).toBeVisible()
    const brief = page.getByRole('combobox', { name: 'Brief' })
    await brief.fill(`/add-dir ${extra}`)
    await brief.press(`${MOD}+Enter`)
    const folders = newTask.getByRole('list', { name: 'Added folders' })
    await expect(folders).toBeVisible({ timeout: 20_000 })
    await expect(folders).toContainText(extra)
    // The command is spent, not sent as a task: still on New task, brief emptied.
    await expect(newTask).toBeVisible()
    await expect(brief).not.toContainText('/add-dir')
    await expect(page.locator('[data-nav-row]')).toHaveCount(1)
  })

  test('? and Ctrl+/ open Keyboard shortcuts', async () => {
    const page = launched.window
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await blur(page)
    await page.keyboard.press('?')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await blur(page)
    await page.keyboard.press(`${MOD}+Slash`)
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    // Typed into the brief, ? is just a character.
    const brief = page.getByRole('combobox', { name: 'Brief' })
    await brief.fill('')
    await brief.press('?')
    await expect(dialog).toBeHidden()
    await expect(brief).toContainText('?')
    await brief.fill('')
  })

  test('the command palette lists Open documentation, Scheduled tasks and Import task…', async () => {
    const page = launched.window
    await blur(page)
    await page.keyboard.press(`${MOD}+k`)
    const palette = page.getByRole('dialog', { name: 'Search and commands' })
    await expect(palette).toBeVisible()
    const input = palette.locator('input')
    for (const title of ['Open documentation', 'Scheduled tasks', 'Import task…']) {
      await input.fill(title)
      await expect(palette.getByRole('option', { name: title, exact: true })).toBeVisible()
    }
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
  })

  test('Usage offers 7/30/90/Custom and breaks down where it went', async () => {
    const page = launched.window
    await page.locator('[data-navigator]').getByRole('button', { name: 'Usage', exact: true }).click()
    const usage = page.locator('[data-usage]')
    await expect(usage).toBeVisible({ timeout: 20_000 })
    const range = page.getByRole('radiogroup', { name: 'Range' })
    for (const label of ['7 days', '30 days', '90 days', 'Custom']) {
      await expect(range.getByRole('radio', { name: label, exact: true })).toBeVisible()
    }
    const where = page.getByRole('region', { name: 'Where it went' })
    await expect(where).toBeVisible({ timeout: 20_000 })
    await expect(where).toContainText('Tidy the release checklist')
    await range.getByRole('radio', { name: 'Custom', exact: true }).click()
    await expect(page.getByLabel('From', { exact: true })).toBeVisible()
    await expect(page.getByLabel('To', { exact: true })).toBeVisible()
    await range.getByRole('radio', { name: '30 days', exact: true }).click()
    await expect(range.getByRole('radio', { name: '30 days', exact: true })).toHaveAttribute('aria-checked', 'true')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Repeat… and Scheduled tasks', () => {
  let launched: LaunchedApp
  let workspace: string
  const runId = 'run-audit-repeat'
  const GOAL = 'Summarise the changelog for the audit'

  test.beforeAll(async () => {
    workspace = tempDir('repeat')
    launched = await launchApp({
      e2eFixture: true,
      preLaunchSeed: (userDataDir) => {
        seedAppSettings(userDataDir, { navigationMode: 'sidebar', toolApprovalOnboardingDone: true, autoResumeInterruptedRuns: false })
        seedRunsInUserData(userDataDir, workspace, [{ runId, goal: GOAL, updatedAt: new Date().toISOString() }])
        seedWorkspacesRegistry(userDataDir, workspace, null)
      }
    })
  })
  test.afterAll(async () => {
    if (launched) await closeApp(launched)
  })

  test('the row menu offers Export as JSON and Repeat…; a schedule lists, runs now, and deletes', async () => {
    const page = launched.window
    const rows = page.locator('[data-nav-row]').filter({ hasText: GOAL })
    await expect(rows).toHaveCount(1, { timeout: 30_000 })
    await rows.first().click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Export as JSON' })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Repeat…' }).click()

    const repeat = page.getByRole('dialog', { name: 'Repeat task' })
    await expect(repeat).toBeVisible()
    await expect(repeat).toContainText(GOAL)
    await repeat.getByRole('radiogroup', { name: 'Repeat' }).getByRole('radio', { name: 'Every' }).click()
    await expect(repeat.locator('[data-schedule-preview]')).toContainText('Next run')
    await repeat.getByRole('button', { name: 'Repeat', exact: true }).click()
    await expect(repeat).toBeHidden({ timeout: 10_000 })

    await page.locator('[data-navigator-view]').click()
    await page.getByRole('menuitem', { name: 'Scheduled tasks…' }).click()
    const list = page.getByRole('dialog', { name: 'Scheduled tasks' })
    await expect(list).toBeVisible()
    const row = list.locator('[data-schedule-row]').filter({ hasText: GOAL })
    await expect(row).toHaveCount(1, { timeout: 10_000 })
    await expect(row).toContainText(/Every .*minutes|hour/)

    await row.getByRole('button', { name: 'Run now' }).click()
    // Run now opens the new task; it is a second row with the same brief.
    await expect(list).toBeHidden({ timeout: 10_000 })
    await expect(rows).toHaveCount(2, { timeout: 30_000 })
    // The opened task is the new run, marked as scheduled in the navigator.
    // (Its record stays empty here: the e2e fixture never persists messages,
    // and the run finishes before the window opens it.)
    // The pane no longer renders the task's title. Its run's own words would be
    // the record's brief row (`[data-brief="1"]`, Brief.tsx), but the record of
    // this run is empty here — see above — so the task that opened is named by
    // the navigator's selected row, which is where the title lives now.
    await expect(page.locator('[data-nav-row][aria-current="page"]')).toContainText(GOAL, { timeout: 20_000 })

    await page.locator('[data-navigator-view]').click()
    await page.getByRole('menuitem', { name: 'Scheduled tasks…' }).click()
    await expect(list).toBeVisible()
    await expect(row.locator('[data-schedule-outcome="started"]')).toBeVisible({ timeout: 10_000 })
    await row.getByRole('button', { name: /^Delete schedule / }).click()
    await expect(list.locator('[data-scheduled-empty]')).toBeVisible({ timeout: 10_000 })
    const left = await page.evaluate(async () => {
      const res = await window.vyotiq.listSchedules()
      return res.ok ? res.data.schedules.length : -1
    })
    expect(left).toBe(0)
    await page.keyboard.press('Escape')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Undo one hunk of a task’s edit', () => {
  let launched: LaunchedApp
  let workspace: string
  const runId = 'run-audit-hunk'
  const PATH = 'src/list.ts'
  const before = Array.from({ length: 24 }, (_, i) => `export const v${i + 1} = ${i + 1}`).join('\n') + '\n'
  const afterLines = before.split('\n')
  afterLines[1] = 'export const v2 = 200'
  afterLines[19] = 'export const v20 = 2000'
  const after = afterLines.join('\n')
  const firstOnly = (() => {
    const lines = before.split('\n')
    lines[1] = 'export const v2 = 200'
    return lines.join('\n')
  })()

  test.beforeAll(async () => {
    workspace = tempDir('hunk')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, PATH), after, 'utf8')
    launched = await launchApp({
      preLaunchSeed: (userDataDir) => {
        seedAppSettings(userDataDir, { navigationMode: 'sidebar', toolApprovalOnboardingDone: true })
        seedRunsInUserData(userDataDir, workspace, [{ runId, goal: 'Bump two constants', updatedAt: new Date().toISOString() }])
        const runDir = join(sessionsRootFor(userDataDir, workspace), runId)
        const rows = [
          { role: 'user', content: 'Bump two constants' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'edit', arguments: JSON.stringify({ path: PATH, contents: after }) }] },
          { role: 'tool', toolCallId: 'c1', toolName: 'edit', content: `Wrote ${PATH}`, ok: true },
          { role: 'assistant', content: 'Bumped v2 and v20.' }
        ]
        writeFileSync(join(runDir, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
        const cpId = '1a2b3c4d-0000-4000-8000-00000000a0d1'
        const cpDir = join(runDir, 'checkpoints', cpId)
        mkdirSync(dirname(join(cpDir, 'files', PATH)), { recursive: true })
        writeFileSync(join(cpDir, 'files', PATH), before, 'utf8')
        const createdAt = new Date(Date.now() - 60_000).toISOString()
        writeFileSync(
          join(cpDir, 'meta.json'),
          JSON.stringify({
            id: cpId,
            createdAt,
            anchorUserMessageIndex: 0,
            files: [{ path: PATH, action: 'modified', undoable: true, hash: createHash('sha256').update(after, 'utf8').digest('hex') }]
          }),
          'utf8'
        )
        writeFileSync(join(runDir, 'checkpoints', 'index.json'), JSON.stringify({ checkpoints: [{ id: cpId, createdAt }] }), 'utf8')
        seedRunEvents(userDataDir, workspace, runId, [
          { type: 'writes_checkpoint', runId, checkpointId: cpId, files: [{ path: PATH, action: 'modified', undoable: true }] }
        ])
        seedWorkspacesRegistry(userDataDir, workspace, runId)
      }
    })
  })
  test.afterAll(async () => {
    if (launched) await closeApp(launched)
  })

  test('Undo the second hunk takes only it out; Restore puts it back', async () => {
    const page = launched.window
    await expect(page.locator('[data-task-pane]').first()).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('Alt+1')
    const panel = page.locator('[data-changes-panel]')
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await expect(panel.getByRole('button', { name: 'Change scope' })).toContainText('This task')
    const fileRow = panel.locator(`[data-change-row="${PATH}"]`)
    await expect(fileRow).toBeVisible({ timeout: 20_000 })
    // A waiting file opens unfolded; unfold it only if it is not.
    const toggle = fileRow.getByRole('button', { name: `${PATH}, modified` })
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()

    const hunks = panel.locator('[data-hunk]')
    await expect(hunks).toHaveCount(2, { timeout: 20_000 })
    await hunks.nth(1).hover()
    await hunks.nth(1).getByRole('button', { name: /^Undo the hunk at line / }).click()

    await expect.poll(() => readFileSync(join(workspace, PATH), 'utf8'), { timeout: 20_000 }).toBe(firstOnly)
    const toast = page.locator('[data-toast]').filter({ hasText: 'Undid one hunk' })
    await expect(toast).toBeVisible()
    await expect(hunks).toHaveCount(1, { timeout: 20_000 })

    await toast.getByRole('button', { name: 'Restore' }).click()
    await expect.poll(() => readFileSync(join(workspace, PATH), 'utf8'), { timeout: 20_000 }).toBe(after)
    await expect(hunks).toHaveCount(2, { timeout: 20_000 })
  })
})
