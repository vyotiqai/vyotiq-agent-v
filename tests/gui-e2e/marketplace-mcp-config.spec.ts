import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { leaveSettingsIfOpen } from './helpers/settings'

let launched: LaunchedApp

// No options overload on beforeAll — the hook inherits the config timeout.
test.beforeAll(async () => {
  launched = await launchApp()
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
})

test.beforeEach(async () => {
  const { window } = launched
  await leaveSettingsIfOpen(window)
})

// Nothing here depends on what the catalog holds: an e2e build may not ship it.

test('extensions open from the navigator with a tab per kind', async () => {
  const { window } = launched

  await window.getByRole('button', { name: 'Extensions', exact: true }).click()

  const kinds = window.getByRole('tablist', { name: 'Extension kinds' })
  await expect(kinds).toBeVisible({ timeout: 15_000 })
  // Each tab carries its count, so match the name from its start.
  for (const name of [/^All/, /^MCP servers/, /^Skills/, /^Rules/, /^Packages/]) {
    await expect(kinds.getByRole('tab', { name })).toBeVisible()
  }
  await expect(kinds.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true')
})

test('search narrows the list and says when nothing matches', async () => {
  const { window } = launched

  await window.getByRole('button', { name: 'Extensions', exact: true }).click()
  const search = window.getByRole('textbox', { name: 'Search extensions' })
  await expect(search).toBeVisible({ timeout: 15_000 })

  await search.fill('zzzz-no-such-extension')
  await expect(window.getByText('Nothing matches “zzzz-no-such-extension”.')).toBeVisible()
  await search.fill('')
  await expect(window.getByText(/^Nothing matches/)).toHaveCount(0)
})

test('the gear opens registry and trust settings', async () => {
  const { window } = launched

  await window.getByRole('button', { name: 'Extensions', exact: true }).click()
  await window.getByRole('button', { name: 'Registry and trust' }).click()

  const dialog = window.getByRole('dialog', { name: 'Registry and trust' })
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  const registry = dialog.getByRole('region', { name: 'Package registry' })
  await expect(registry.getByText('Registry URL')).toBeVisible()
  await expect(registry.getByPlaceholder(/registry\.example\.com/i)).toBeVisible()

  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)
})
