import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { APPEARANCE_LOCAL_STORAGE_KEY, DEFAULT_SKIN_ID } from '../../src/shared/appearance'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedAppSettings } from './helpers/seedWorkspace'
import {
  chooseSettingsRadio,
  leaveSettingsIfOpen,
  openAppearanceSection,
  openSettings,
  readAppearanceBootCache,
  readRootAppearance,
  resetAppearanceSettings
} from './helpers/settings'

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
  await resetAppearanceSettings(window)
})

test('settings nav opens appearance section with all controls', async () => {
  const { window } = launched
  await openAppearanceSection(window)

  await expect(window.locator('[data-settings-field="appearance-skin"]')).toBeVisible()
  for (const skin of ['Native', 'Default', 'Proof', 'Bench', 'Gild']) {
    await expect(window.getByRole('button', { name: skin, exact: true })).toBeVisible()
  }
  await expect(window.getByRole('radiogroup', { name: 'Colour mode', exact: true })).toBeVisible()
  await expect(window.getByRole('radiogroup', { name: 'Text size', exact: true })).toBeVisible()
  await expect(window.getByRole('radiogroup', { name: 'Density', exact: true })).toBeVisible()
  await expect(window.getByText('User CSS overlay')).toBeVisible()
})

test('settings search navigates to the skin picker', async () => {
  const { window } = launched
  await openSettings(window)

  const search = window.getByRole('textbox', { name: /search settings/i })
  await search.fill('template')
  await search.press('Enter')

  await expect(window.locator('[data-settings-field="appearance-skin"]')).toBeVisible({ timeout: 10_000 })
  await expect(window.getByRole('button', { name: /^bench$/i })).toBeVisible()
})

test('colour mode updates DOM, boot cache, and persisted settings', async () => {
  const { window, userDataDir } = launched
  await openAppearanceSection(window)
  await chooseSettingsRadio(window, 'Colour mode', 'Dark')

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

test('text size and density update document attributes and CSS tokens', async () => {
  const { window } = launched
  await openAppearanceSection(window)

  await chooseSettingsRadio(window, 'Text size', 'Large')
  await chooseSettingsRadio(window, 'Density', 'Compact')

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
  // Native is the shipped skin, so the per-test reset already leaves it
  // selected: move off it first or the click proves nothing.
  await window.getByRole('button', { name: /^default$/i }).click()
  await expect.poll(async () => readRootAppearance(window)).toMatchObject({ skin: 'default' })

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

test.describe('custom CSS overlay', () => {
  let overlay: LaunchedApp

  test.afterAll(async () => {
    if (overlay) await closeApp(overlay)
  })

  // The renderer cannot name an arbitrary stylesheet any more: a path is
  // honoured only once the user has chosen it in the picker, or when it is
  // already the saved one. Booting with it saved is what a user who picked it
  // once has on every launch after, and it is the route this can still take.
  test('injects a saved user skin style tag', async () => {
    overlay = await launchApp({
      preLaunchSeed: (userDataDir) => {
        const cssPath = join(userDataDir, 'overlay.css')
        writeFileSync(cssPath, ':root { --vy-fg: #123456; }', 'utf8')
        // No skinId here on purpose: the overlay has to beat the shipped skin's
        // own [data-skin][data-theme] palette block, not just the base tokens.
        seedAppSettings(userDataDir, { customCssPath: cssPath })
      }
    })

    await expect
      .poll(async () =>
        overlay.window.evaluate(
          () => document.getElementById('vyotiq-user-skin')?.textContent ?? ''
        )
      )
      .toContain('--vy-fg')

    await expect
      .poll(async () =>
        overlay.window.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--vy-fg')
            .trim()
            .toLowerCase()
        )
      )
      .toBe('#123456')
  })
})

test('appearance boot cache survives reload before React hydrates', async () => {
  const { window } = launched
  await openAppearanceSection(window)
  await window.getByRole('button', { name: /^bench$/i }).click()
  await chooseSettingsRadio(window, 'Colour mode', 'Light')
  await chooseSettingsRadio(window, 'Text size', 'Small')
  await chooseSettingsRadio(window, 'Density', 'Comfortable')

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

  await expect(window.getByRole('button', { name: /^settings/i })).toBeVisible({
    timeout: 15_000
  })

  const attrs = await readRootAppearance(window)
  expect(attrs.fontScale).toBe('default')
  expect(attrs.density).toBe('default')
  expect(attrs.skin).toBe(DEFAULT_SKIN_ID)
})
