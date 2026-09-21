import { expect, type Page } from '@playwright/test'
import { APPEARANCE_LOCAL_STORAGE_KEY, DEFAULT_SKIN_ID } from '../../../src/shared/appearance'

export type RootAppearanceAttrs = {
  theme: string | null
  fontScale: string | null
  density: string | null
  skin: string | null
}

async function blurActiveElement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    active?.blur?.()
  })
}

export async function openSettings(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: /settings sections/i })
  if (await nav.isVisible().catch(() => false)) return

  await blurActiveElement(page)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${mod}+Comma`)
  await expect(nav).toBeVisible({ timeout: 15_000 })
}

export async function openAppearanceSection(page: Page): Promise<void> {
  await openSettings(page)
  await page.getByRole('button', { name: /^appearance$/i }).click()
  await expect(page.getByText('Color mode')).toBeVisible({ timeout: 10_000 })
}

export async function selectSettingsMenu(
  page: Page,
  menuAriaLabel: string | RegExp,
  optionLabel: string | RegExp
): Promise<void> {
  const trigger = page.getByRole('button', { name: menuAriaLabel })
  await expect(trigger).toBeVisible()
  await trigger.click()
  const listbox = page.getByRole('listbox', { name: menuAriaLabel })
  await expect(listbox).toBeVisible()
  await listbox.getByRole('option', { name: optionLabel }).click()
  await expect(listbox).toBeHidden({ timeout: 5_000 })
}

export async function readRootAppearance(page: Page): Promise<RootAppearanceAttrs> {
  return page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    fontScale: document.documentElement.getAttribute('data-font-scale'),
    density: document.documentElement.getAttribute('data-density'),
    skin: document.documentElement.getAttribute('data-skin')
  }))
}

export async function readAppearanceBootCache(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return null
    }
  }, APPEARANCE_LOCAL_STORAGE_KEY)
}

export async function resetAppearanceSettings(page: Page): Promise<void> {
  await page.evaluate(async (skinId) => {
    await window.vyotiq.setSettings({
      theme: 'system',
      fontScale: 'default',
      uiDensity: 'default',
      skinId,
      customCssPath: ''
    })
  }, DEFAULT_SKIN_ID)
  await leaveSettingsIfOpen(page)
  await page.reload()
  await page.locator('body').waitFor({ state: 'attached', timeout: 45_000 })
  await expect
    .poll(async () => readRootAppearance(page), { timeout: 15_000 })
    .toMatchObject({
      fontScale: 'default',
      density: 'default',
      skin: DEFAULT_SKIN_ID
    })
}

export async function leaveSettingsIfOpen(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await blurActiveElement(page)
  const back = page.getByRole('button', { name: /^back$/i })
  if (await back.isVisible().catch(() => false)) {
    await back.click()
    await expect(back).toBeHidden({ timeout: 10_000 })
  }
}
