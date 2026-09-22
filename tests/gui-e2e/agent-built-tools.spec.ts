import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

/**
 * Agent-built tools, in the real app.
 *
 * `build_tool` writes a module under `<userData>/agent-tools/` and the loader
 * picks it up on the next step. Everything about that is covered by unit tests
 * EXCEPT the one thing that actually broke: resolving the directory. The read
 * paths used to call the synchronous `agentToolsDir()`, which answers with a
 * tmpdir fallback until something resolves userData — and only `build_tool`
 * did. Unit tests never saw it because they call `build_tool` first; a fresh
 * launch scanning a previous session's tools is what exposed it, so that is
 * what this spec reproduces.
 */

let launched: LaunchedApp
let workspacePath: string

const TOOL_NAME = 'changelog-diff'
const TOOL_DESCRIPTION = 'Summarises the diff between two git tags as release-note bullets.'

test.setTimeout(120_000)

/** A module exactly as `build_tool` composes it, written before Electron boots. */
function seedAgentTool(userDataDir: string): void {
  const dir = join(userDataDir, 'agent-tools')
  mkdirSync(dir, { recursive: true })
  const header = JSON.stringify(
    {
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from', 'to']
      }
    },
    null,
    2
  )
  writeFileSync(
    join(dir, `${TOOL_NAME}.mjs`),
    `/* @agent-tool ${header} */\n\nexport async function handler(args) {\n  return { from: args.from, to: args.to }\n}\n`,
    'utf8'
  )
}

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-agent-tools-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ preLaunchSeed: seedAgentTool })

  const addRes = await launched.window.evaluate(
    async (path) => window.vyotiq.addWorkspace(path),
    workspacePath
  )
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true })
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
  await expect(launched.window.locator('body')).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  await closeApp(launched)
  rmSync(workspacePath, { recursive: true, force: true })
})

test('a tool written by an earlier session is in the catalog on a fresh launch', async () => {
  const catalog = await launched.window.evaluate(async () => window.vyotiq.toolsCatalogGet({}))
  expect(catalog.ok).toBe(true)
  if (!catalog.ok) throw new Error(catalog.error)

  const built = catalog.data.entries.filter((entry) => entry.source === 'agent')
  expect(built).toHaveLength(1)
  expect(built[0]!.name).toBe(TOOL_NAME)
  expect(built[0]!.description).toBe(TOOL_DESCRIPTION)
  // Agent mode only, and nothing defers it the way an MCP server's schemas are.
  expect(built[0]!.modes).toEqual(['agent'])
  expect(built[0]!.active).toBe(true)

  // build_tool itself is a builtin and rides the same catalog.
  expect(catalog.data.entries.some((entry) => entry.name === 'build_tool')).toBe(true)
})

test('Settings names what a run wrote, and says calls are re-approved when it changes', async () => {
  const page = launched.window
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Tools', exact: true }).click()

  const heading = page.getByText('Agent-built tools (1)')
  await expect(heading).toBeVisible({ timeout: 20_000 })
  // Reading the module means opening the file, so the one thing the list can
  // do is say how it is gated.
  await expect(page.getByText(/each call asks you, and asks again whenever the code changes/)).toBeVisible()
  await expect(page.getByText(TOOL_DESCRIPTION)).toBeVisible()
})
