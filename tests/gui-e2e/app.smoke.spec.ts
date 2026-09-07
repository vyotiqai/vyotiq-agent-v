import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

let launched: LaunchedApp

test.beforeAll(async () => {
  launched = await launchApp()
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
})

/** Reset shell chrome between tests without relaunching Electron. */
test.beforeEach(async () => {
  const { window } = launched
  await window.keyboard.press('Escape')
  // Blur any editable so app chords are not skipped
  await window.evaluate(() => {
    const ae = document.activeElement as HTMLElement | null
    ae?.blur?.()
  })
  // Leave settings / marketplace if open
  const back = window.getByRole('button', { name: /^back$/i })
  if (await back.isVisible().catch(() => false)) {
    await back.click()
  }
  // Ensure desktop sidebar is expanded
  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }
})

test('app opens a main window', async () => {
  const { window } = launched
  await expect(window.locator('body')).toBeVisible()
  await expect(window.getByRole('button', { name: /^settings$/i })).toBeVisible()
})

test('Ctrl/Cmd+B toggles the sidebar', async () => {
  const { window } = launched
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

  const collapse = window.getByRole('button', { name: /collapse sidebar/i })
  await expect(collapse).toBeVisible({ timeout: 10_000 })
  await window.keyboard.press(`${mod}+B`)
  await expect(window.getByRole('button', { name: /expand sidebar/i })).toBeVisible()
  await window.keyboard.press(`${mod}+B`)
  await expect(window.getByRole('button', { name: /collapse sidebar/i })).toBeVisible()
})

test('Ctrl/Cmd+, opens settings', async () => {
  const { window } = launched
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await window.keyboard.press(`${mod}+Comma`)
  await expect(
    window.getByRole('button', { name: /general/i }).or(window.getByText(/^general$/i)).first()
  ).toBeVisible({ timeout: 10_000 })
})

test('skip link targets main content landmark', async () => {
  const { window } = launched
  await window.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
    // Chromium anchors sequential-focus navigation at the last focused
    // element (the boot-focused composer). body.focus() only becomes the
    // Tab start when body itself is focusable.
    document.body.setAttribute('tabindex', '-1')
    document.body.focus()
  })
  await window.keyboard.press('Tab')
  const skip = window.getByRole('link', { name: /skip to main content/i })
  await expect(skip).toBeFocused({ timeout: 5_000 })
  await expect(window.locator('#main-content')).toHaveAttribute('tabindex', '-1')
})

test('hover shows new chat tooltip', async () => {
  const { window } = launched
  // Settings uses native title=; IconButton (New chat) mounts role=tooltip.
  const newChat = window.getByRole('button', { name: /^new chat$/i }).first()
  await expect(newChat).toBeVisible()
  const box = await newChat.boundingBox()
  expect(box).toBeTruthy()
  await window.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2)
  const tip = window.locator('[role="tooltip"]')
  await expect(tip).toBeVisible({ timeout: 5_000 })
  await expect(tip).toContainText(/new chat/i)
  await window.keyboard.press('Escape')
  await expect(tip).toHaveCount(0)
})
