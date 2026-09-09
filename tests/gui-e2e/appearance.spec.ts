import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { APPEARANCE_LOCAL_STORAGE_KEY } from '../../src/shared/appearance'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedAppSettings } from './helpers/seedWorkspace'
import {
  leaveSettingsIfOpen,
  openAppearanceSection,
  openSettings,
  readAppearanceBootCache,
  readRootAppearance,
  resetAppearanceSettings,
  selectSettingsMenu
} from './helpers/settings'

let launched: LaunchedApp

test.beforeAll(async () => {
  launched = await launchApp()
}, { timeout: 90_000 })

test.afterAll(async () => {
  if (launched) await closeApp(launched)
})

test.beforeEach(async () => {
  const { window } = launched
  await leaveSettingsIfOpen(window)
  await resetAppearanceSettings(window)
})

test('settings nav opens appearance section with all controls', async () => {
  const { window } = launched
  await openAppearanceSection(window)

  await expect(window.getByRole('button', { name: /^theme$/i })).toBeVisible()
  await expect(window.getByText('Interface skin')).toBeVisible()
  await expect(window.getByRole('button', { name: /^text size$/i })).toBeVisible()
  await expect(window.getByRole('button', { name: /^ui density$/i })).toBeVisible()
  await expect(window.getByText('User CSS overlay')).toBeVisible()
})

test('settings search navigates to interface skin field', async () => {
  const { window } = launched
  await openSettings(window)

  const search = window.getByRole('textbox', { name: /search settings/i })
  await search.fill('template')
  await search.press('Enter')

  await expect(window.getByText('Interface skin')).toBeVisible({ timeout: 10_000 })
  await expect(window.getByRole('button', { name: /^bench$/i })).toBeVisible()
})

test('theme menu updates DOM, boot cache, and persisted settings', async () => {
  const { window, userDataDir } = launched
  await openAppearanceSection(window)
  await selectSettingsMenu(window, /^theme$/i, /^dark$/i)

  await expect
    .poll(async () => readRootAppearance(window))
    .toMatchObject({ theme: 'dark' })

  const cache = await readAppearanceBootCache(window)
  expect(cache?.theme).toBe('dark')
  expect(cache?.resolvedTheme).toBe('dark')

  await expect
    .poll(async () => {
      const res = await window.evaluate(async () => window.vyotiq.getSettings())
      return res.ok ? res.data.theme : null
    })
    .toBe('dark')

  const onDisk = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as {
    theme?: string
  }
  expect(onDisk.theme).toBe('dark')
})

test('font scale and density menus update document attributes and CSS tokens', async () => {
  const { window } = launched
  await openAppearanceSection(window)

  await selectSettingsMenu(window, /^text size$/i, /^large$/i)
  await selectSettingsMenu(window, /^ui density$/i, /^compact$/i)

  await expect
    .poll(async () => readRootAppearance(window))
    .toMatchObject({ fontScale: 'large', density: 'compact' })

  const tokens = await window.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    return {
      fontScale: style.getPropertyValue('--vy-font-scale').trim(),
      densityScale: style.getPropertyValue('--vy-density-scale').trim()
    }
  })
  expect(Number.parseFloat(tokens.fontScale)).toBeCloseTo(1.08, 2)
  expect(Number.parseFloat(tokens.densityScale)).toBeCloseTo(0.9, 2)

  const settings = await window.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    return res.ok ? res.data : null
  })
  expect(settings?.fontScale).toBe('large')
  expect(settings?.uiDensity).toBe('compact')
})

test('skin grid applies data-skin and persists proof', async () => {
  const { window } = launched
  await openAppearanceSection(window)
  await window.getByRole('button', { name: /^proof$/i }).click()

  await expect
    .poll(async () => readRootAppearance(window))
    .toMatchObject({ skin: 'proof' })

  const settings = await window.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    return res.ok ? res.data : null
  })
  expect(settings?.skinId).toBe('proof')
})

test('bench skin applies data-skin and persists', async () => {
  const { window } = launched
  await openAppearanceSection(window)
  await window.getByRole('button', { name: /^bench$/i }).click()

  await expect
    .poll(async () => readRootAppearance(window))
    .toMatchObject({ skin: 'bench' })

  const settings = await window.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    return res.ok ? res.data : null
  })
  expect(settings?.skinId).toBe('bench')
})

test('native skin applies data-skin and persists', async () => {
  const { window } = launched
  await openAppearanceSection(window)
  await window.getByRole('button', { name: /^native$/i }).click()

  await expect
    .poll(async () => readRootAppearance(window))
    .toMatchObject({ skin: 'native' })

  const settings = await window.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    return res.ok ? res.data : null
  })
  expect(settings?.skinId).toBe('native')
})

test('gild skin applies data-skin and persists', async () => {
  const { window } = launched
  await openAppearanceSection(window)
  await window.getByRole('button', { name: /^gild$/i }).click()

  await expect
    .poll(async () => readRootAppearance(window))
    .toMatchObject({ skin: 'gild' })

  const settings = await window.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    return res.ok ? res.data : null
  })
  expect(settings?.skinId).toBe('gild')
})

test('custom CSS overlay injects user skin style tag', async () => {
  const { window, userDataDir } = launched
  const cssPath = join(userDataDir, 'overlay.css')
  writeFileSync(cssPath, ':root { --vy-fg: #123456; }', 'utf8')

  await window.evaluate(async (path) => {
    await window.vyotiq.setSettings({ customCssPath: path, skinId: 'default' })
  }, cssPath)

  await expect
    .poll(async () =>
      window.evaluate(() => document.getElementById('vyotiq-user-skin')?.textContent ?? '')
    )
    .toContain('--vy-fg')

  const fg = await window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--vy-fg').trim()
  )
  expect(fg.toLowerCase()).toBe('#123456')
})

test('appearance boot cache survives reload before React hydrates', async () => {
  const { window } = launched
  await openAppearanceSection(window)
  await window.getByRole('button', { name: /^bench$/i }).click()
  await selectSettingsMenu(window, /^theme$/i, /^light$/i)
  await selectSettingsMenu(window, /^text size$/i, /^small$/i)
  await selectSettingsMenu(window, /^ui density$/i, /^comfortable$/i)

  await expect
    .poll(async () => readAppearanceBootCache(window))
    .toMatchObject({
      theme: 'light',
      resolvedTheme: 'light',
      fontScale: 'small',
      uiDensity: 'comfortable',
      skinId: 'bench'
    })

  await window.reload()
  await window.locator('body').waitFor({ state: 'attached', timeout: 45_000 })

  await expect
    .poll(async () => readRootAppearance(window))
    .toMatchObject({
      theme: 'light',
      fontScale: 'small',
      density: 'comfortable',
      skin: 'bench'
    })

  const settings = await window.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    return res.ok ? res.data : null
  })
  expect(settings).toMatchObject({
    theme: 'light',
    fontScale: 'small',
    uiDensity: 'comfortable',
    skinId: 'bench'
  })
})

test.describe('seeded appearance on boot', () => {
  let seeded: LaunchedApp

  test.afterAll(async () => {
    if (seeded) await closeApp(seeded)
  })

  test('applies seeded settings.json appearance on first paint', async () => {
    seeded = await launchApp({
      preLaunchSeed: (userDataDir) => {
        seedAppSettings(userDataDir, {
          theme: 'dark',
          fontScale: 'large',
          uiDensity: 'comfortable'
        })
      }
    })

    await expect
      .poll(async () => readRootAppearance(seeded.window))
      .toMatchObject({
        theme: 'dark',
        fontScale: 'large',
        density: 'comfortable'
      })

    const cache = await readAppearanceBootCache(seeded.window)
    expect(cache).toMatchObject({
      theme: 'dark',
      resolvedTheme: 'dark',
      fontScale: 'large',
      uiDensity: 'comfortable'
    })

    const onDisk = JSON.parse(readFileSync(join(seeded.userDataDir, 'settings.json'), 'utf8')) as {
      theme?: string
      fontScale?: string
      uiDensity?: string
    }
    expect(onDisk).toMatchObject({
      theme: 'dark',
      fontScale: 'large',
      uiDensity: 'comfortable'
    })
  })
})

test('corrupt appearance boot cache does not break startup', async () => {
  const { window } = launched
  await window.evaluate(
    ([key, payload]) => {
      localStorage.setItem(key, payload)
    },
    [APPEARANCE_LOCAL_STORAGE_KEY, '{not-json'] as const
  )

  await window.reload()
  await window.locator('body').waitFor({ state: 'attached', timeout: 45_000 })

  await expect(window.getByRole('button', { name: /^settings$/i })).toBeVisible({
    timeout: 15_000
  })

  const attrs = await readRootAppearance(window)
  expect(attrs.fontScale).toBe('default')
  expect(attrs.density).toBe('default')
  expect(attrs.skin).toBe('default')
})
