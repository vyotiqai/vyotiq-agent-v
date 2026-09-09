import { expect, type Page } from '@playwright/test'
import { APPEARANCE_LOCAL_STORAGE_KEY } from '../../../src/shared/appearance'

export type RootAppearanceAttrs = {
  theme: string | null
  fontScale: string | null
  density: string | null
  skin: string | null
}

async function blurActiveElement(window: Page): Promise<void> {
  await window.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    active?.blur?.()
  })
}

export async function openSettings(window: Page): Promise<void> {
  const nav = window.getByRole('navigation', { name: /settings sections/i })
  if (await nav.isVisible().catch(() => false)) return

  await blurActiveElement(window)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await window.keyboard.press(`${mod}+Comma`)
  await expect(nav).toBeVisible({ timeout: 15_000 })
}

export async function openAppearanceSection(window: Page): Promise<void> {
  await openSettings(window)
  await window.getByRole('button', { name: /^appearance$/i }).click()
  await expect(window.getByText('Color mode')).toBeVisible({ timeout: 10_000 })
}

export async function selectSettingsMenu(
  window: Page,
  menuAriaLabel: string | RegExp,
  optionLabel: string | RegExp
): Promise<void> {
  const trigger = window.getByRole('button', { name: menuAriaLabel })
  await expect(trigger).toBeVisible()
  await trigger.click()
  const listbox = window.getByRole('listbox', { name: menuAriaLabel })
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name: optionLabel }).click()
  await expect(listbox).toBeHidden({ timeout: 5_000 })
}

export async function readRootAppearance(window: Page): Promise<RootAppearanceAttrs> {
  return window.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    fontScale: document.documentElement.getAttribute('data-font-scale'),
    density: document.documentElement.getAttribute('data-density'),
    skin: document.documentElement.getAttribute('data-skin')
  }))
}

export async function readAppearanceBootCache(window: Page): Promise<Record<string, unknown> | null> {
  return window.evaluate((key) => {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
  }, APPEARANCE_LOCAL_STORAGE_KEY)
}

export async function resetAppearanceSettings(window: Page): Promise<void> {
  await window.evaluate(async () => {
    await window.vyotiq.setSettings({
      theme: 'system',
      fontScale: 'default',
      uiDensity: 'default',
      skinId: 'default',
      customCssPath: ''
    })
  })
  await leaveSettingsIfOpen(window)
  await window.reload()
  await window.locator('body').waitFor({ state: 'attached', timeout: 45_000 })
  await expect
    .poll(async () => readRootAppearance(window), { timeout: 15_000 })
    .toMatchObject({
      fontScale: 'default',
      density: 'default',
      skin: 'default'
    })
}

export async function leaveSettingsIfOpen(window: Page): Promise<void> {
  await window.keyboard.press('Escape')
  await blurActiveElement(window)
  const back = window.getByRole('button', { name: /^back$/i })
  if (await back.isVisible().catch(() => false)) {
    await back.click()
    await expect(back).toBeHidden({ timeout: 10_000 })
  }
}
