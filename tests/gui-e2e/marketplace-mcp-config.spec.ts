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

test('marketplace opens from the navigator with browse controls', async () => {
  const { window } = launched

  await window.getByRole('button', { name: 'Extensions' }).click()

  // Section header + tab list render.
  await expect(window.getByRole('tablist', { name: 'Marketplace sections' })).toBeVisible({
    timeout: 15_000
  })
  await expect(window.getByRole('tab', { name: 'Browse' })).toBeVisible()
  await expect(window.getByRole('tab', { name: 'Manage' })).toBeVisible()
})

test('marketplace browse exposes search and kind filter', async () => {
  const { window } = launched

  await window.getByRole('button', { name: 'Extensions' }).click()
  const search = window.getByRole('textbox', { name: 'Search marketplace' })
  await expect(search).toBeVisible({ timeout: 15_000 })

  await search.fill('whisper')
  await expect(search).toHaveValue('whisper')
  await search.fill('')

  await expect(window.getByRole('combobox', { name: /filter by kind/i })).toBeVisible()
})

test('manage tab reveals registry settings panel', async () => {
  const { window } = launched

  await window.getByRole('button', { name: 'Extensions' }).click()
  await window.getByRole('tab', { name: 'Manage' }).click()

  const registry = window.getByRole('region', { name: 'Package registry' })
  await expect(registry).toBeVisible({ timeout: 10_000 })
  await expect(registry.getByText('Registry URL')).toBeVisible()
  await expect(registry.getByPlaceholder(/registry\.example\.com/i)).toBeVisible()
  await expect(window.getByRole('tablist', { name: 'Manage marketplace' })).toBeVisible()
})
