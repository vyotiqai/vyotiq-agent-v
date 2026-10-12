import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * New task's responsive tiers, measured on the live window: the brief keeps the
 * record's 780px measure and the rail keeps its 296px beside it while the
 * column can hold both; under 1100px of column the rail gives the width back to
 * the field and reads two facts to a line. Nothing overflows horizontally at
 * any width. Screenshots of each tier land in test-results/new-task-layout.
 */
let launched: LaunchedApp
let ws: string

test.beforeAll(async () => {
  ws = mkdtempSync(join(tmpdir(), 'vyotiq-nt-shots-'))
  launched = await launchApp()
  const added = await launched.window.evaluate((p) => window.vyotiq.addWorkspace(p), ws)
  if (!added.ok) throw new Error(added.error)
  ws = requireActivePath(added.data.activePath)
  await launched.window.evaluate(() => {
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(ws, { recursive: true, force: true })
})

test('the brief and its rail at 1920 / 1440 / 1280 / 1100 / 900', async () => {
  const page = launched.window
  const outDir = join('test-results', 'new-task-layout')
  mkdirSync(outDir, { recursive: true })
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 30_000 })
  await brief.fill('Redraw the queue drawer and keep the keyboard chords')
  const check = page.getByRole('textbox', { name: 'New check' })
  await check.fill('pnpm test passes')
  await check.press('Enter')
  await check.fill('No new dependency')
  await check.press('Enter')

  for (const width of [1920, 1440, 1280, 1100, 900]) {
    await launched.app.evaluate(({ BrowserWindow }, w) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: w, height: 900 })
    }, width)
    await page.waitForTimeout(250)
    const m = await page.evaluate(() => {
      const r = (s: string) => {
        const el = document.querySelector(s)
        const b = el?.getBoundingClientRect()
        return b ? { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) } : null
      }
      const de = document.documentElement
      return { box: r('[data-brief]'), rail: r('[data-agent-sees]'), pad: r('[data-new-task]'), overflowX: de.scrollWidth - de.clientWidth }
    })
    // The rail takes the 296px it is owed beside the box while the column can
    // hold both, and gives the width back to the field when it cannot.
    expect(m.box && m.rail && m.pad, `brief and rail at ${width}`).toBeTruthy()
    expect(m.overflowX, `no horizontal overflow at ${width}`).toBe(0)
    expect(m.box!.w, `brief keeps its measure at ${width}`).toBeGreaterThanOrEqual(760)
    if (width >= 1440) {
      expect(m.rail!.w, `rail width at ${width}`).toBe(296)
      expect(m.rail!.x, `rail beside the brief at ${width}`).toBeGreaterThan(m.box!.x + m.box!.w)
    } else {
      expect(m.rail!.y, `rail under the brief at ${width}`).toBeGreaterThanOrEqual(m.box!.y + m.box!.h)
    }
    console.log('NT_LAYOUT ' + JSON.stringify({ width, ...m }))
    await page.screenshot({ path: join(outDir, `nt-${width}.png`) })
  }

  // Two more reads of the same column: the other theme, and a skin with a
  // different paper, so the tokens are checked where the layout is widest.
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 900 })
  })
  await page.evaluate(async () => {
    await window.vyotiq.setSettings({ theme: 'light', skinId: 'gild' })
  })
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light')
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(outDir, 'nt-1440-light-gild.png') })

  // The same column with the inspector open beside it: this is where the rail
  // has to give the width back to the field.
  await page.evaluate(async () => {
    await window.vyotiq.setSettings({ theme: 'dark', skinId: 'default' })
  })
  await page.waitForTimeout(250)
  await page.keyboard.press('Alt+2')
  await page.waitForTimeout(500)
  const stacked = await page.evaluate(() => {
    const r = (s: string) => {
      const b = document.querySelector(s)?.getBoundingClientRect()
      return b ? { y: +b.y.toFixed(1), w: +b.width.toFixed(1) } : null
    }
    return { box: r('[data-brief]'), rail: r('[data-agent-sees]'), pane: r('[data-new-task]') }
  })
  console.log('NT_SHOTS inspector-open ' + JSON.stringify(stacked))
  await page.screenshot({ path: join(outDir, 'nt-1440-inspector.png') })
})
