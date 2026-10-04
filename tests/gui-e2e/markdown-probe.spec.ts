import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * A typography probe, not an assertion: one live run (fixtures/markdown-probe.json)
 * puts every markdown construct in a single Result, both themes are captured as
 * `${PROBE_LABEL}-dark.png` / `${PROBE_LABEL}-light.png` in
 * test-results/markdown-polish/, and the computed type is printed as
 * MARKDOWN_PROBE. Run it again with PROBE_LABEL=after a CSS change to get a true
 * before/after pair off the same run.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-markdown-probe-ws-'))
  launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/markdown-probe.json' })
  const added = await launched.window.evaluate((path) => window.vyotiq.addWorkspace(path), workspacePath)
  if (!added.ok) throw new Error(added.error)
  workspacePath = requireActivePath(added.data.activePath)
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ skinId: 'default', theme: 'dark', showThinking: true })
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(workspacePath, { recursive: true, force: true })
})

test('one Result of every markdown construct, captured in both themes', async () => {
  const page = launched.window
  const label = process.env.PROBE_LABEL ?? 'before'
  const outDir = join('test-results', 'markdown-polish')
  mkdirSync(outDir, { recursive: true })

  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 })
  })
  await page.keyboard.press('Control+n')
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await brief.fill('Run the suite and report')
  await brief.press('Control+Enter')

  const result = page.locator('section[aria-label="Result"]')
  await expect(result).toBeVisible({ timeout: 30_000 })

  await result.scrollIntoViewIfNeeded()
  await result.screenshot({ path: join(outDir, `${label}-dark.png`) })

  await page.evaluate(async () => {
    await window.vyotiq.setSettings({ theme: 'light' })
  })
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light')
  await result.scrollIntoViewIfNeeded()
  await result.screenshot({ path: join(outDir, `${label}-light.png`) })

  // Capture only: the numbers are the deliverable, and today's CSS is the before.
  const measured = await result.locator('.markdown-body').evaluate((root) => {
    const box = (el: Element | null): Record<string, string> | null => {
      if (!el) return null
      const cs = getComputedStyle(el)
      return {
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        marginTop: cs.marginTop,
        marginBottom: cs.marginBottom
      }
    }
    const sel = (s: string): Record<string, string> | null => box(root.querySelector(s))
    // Redesign contracts, measured from layout not from CSS: the inline chip's fill
    // and ink against the prose ink, each heading level's own colour, and the
    // table's rule shape (horizontal only, no lattice).
    const ink = (el: Element | null) => {
      if (!el) return null
      const cs = getComputedStyle(el)
      return {
        text: (el.textContent ?? '').trim().slice(0, 32),
        backgroundColor: cs.backgroundColor,
        color: cs.color,
        borderBottomWidth: cs.borderBottomWidth,
        borderBottomColor: cs.borderBottomColor,
        textDecorationLine: cs.textDecorationLine
      }
    }
    const headingInk = (s: string) => {
      const el = root.querySelector(s)
      if (!el) return null
      const cs = getComputedStyle(el)
      return { text: (el.textContent ?? '').trim().slice(0, 32), color: cs.color, fontWeight: cs.fontWeight, fontSize: cs.fontSize }
    }
    const tableEl = root.querySelector('table')
    const thEl = tableEl?.querySelector('th') ?? null
    const tdBorders = tableEl
      ? [...tableEl.querySelectorAll('td')].map((td) => {
          const cs = getComputedStyle(td)
          return {
            text: (td.textContent ?? '').trim().slice(0, 24),
            borderTopWidth: cs.borderTopWidth,
            borderRightWidth: cs.borderRightWidth,
            borderBottomWidth: cs.borderBottomWidth,
            borderLeftWidth: cs.borderLeftWidth
          }
        })
      : []
    const chip = root.querySelector<HTMLElement>('[data-code-chip]')
    const chipStyle = chip ? getComputedStyle(chip) : null
    const prose = root.querySelector<HTMLElement>('.record-prose > p') ?? document.querySelector<HTMLElement>('.record-prose > p')
    // Scannability contracts, measured from layout and not from the CSS text:
    // does the 72ch measure actually bind inside the pane it sits in, and is the
    // hairline on h2 alone.
    const measuredBox = (el: Element | null) => {
      if (!el) return null
      const cs = getComputedStyle(el)
      const any = cs as unknown as Record<string, string>
      return {
        text: (el.textContent ?? '').trim().slice(0, 32),
        maxWidth: cs.maxWidth,
        clientWidth: el instanceof HTMLElement ? el.clientWidth : null,
        textWrap: any.textWrap ?? null,
        textWrapStyle: any.textWrapStyle ?? null,
        borderBottomWidth: cs.borderBottomWidth,
        borderBottomColor: cs.borderBottomColor
      }
    }
    const proseP = prose
    const proseH2 = root.querySelector<HTMLElement>('.record-prose > h2')
    // The block containing the prose: maxWidth under this number means the cap binds.
    const containingBlockClientWidth =
      proseP?.parentElement instanceof HTMLElement ? proseP.parentElement.clientWidth : null
    const markdownBodyClientWidth = root instanceof HTMLElement ? root.clientWidth : null
    // `ch` resolved on the prose's own font, so maxWidth reads back in characters.
    const chProbe = document.createElement('span')
    chProbe.style.position = 'absolute'
    chProbe.style.visibility = 'hidden'
    chProbe.style.width = '1ch'
    proseP?.parentElement?.append(chProbe)
    const resolvedChPx = chProbe.getBoundingClientRect().width || null
    chProbe.remove()
    // getClientRects() on the block returns its fragments (one for an unbroken
    // block), so the real line-box count comes from a Range over its text.
    const proseLineRects = proseP
      ? (() => {
          const range = document.createRange()
          range.selectNodeContents(proseP)
          return [...range.getClientRects()].filter((r) => r.width > 0)
        })()
      : []
    const pCs = proseP ? getComputedStyle(proseP) : null
    const pFontSize = pCs ? parseFloat(pCs.fontSize) : null
    // Characters per *rendered* line, counted from layout: one rect per
    // character, grouped by its line's top edge. Zero-width whitespace rects
    // are skipped, so these are the visible characters on each line.
    const charsPerRenderedLine = (() => {
      if (!proseP) return null
      const walker = document.createTreeWalker(proseP, NodeFilter.SHOW_TEXT)
      const byLine = new Map<number, number>()
      const range = document.createRange()
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? ''
        for (let i = 0; i < text.length; i++) {
          range.setStart(node, i)
          range.setEnd(node, i + 1)
          const r = range.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) continue
          const top = Math.round(r.top)
          byLine.set(top, (byLine.get(top) ?? 0) + 1)
        }
      }
      const counts = [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)
      return {
        renderedLineCount: counts.length,
        charsPerLine: counts,
        longestLineChars: counts.length ? Math.max(...counts) : null
      }
    })()
    return {
      markdownBody: box(root),
      // Prose ink at the root, so a chip's colour can be compared against it.
      markdownBodyInk: getComputedStyle(root).color,
      p: sel('p'),
      ul: sel('ul'),
      li: sel('li'),
      blockquote: sel('blockquote'),
      h1: sel('h1'),
      h2: sel('h2'),
      h3: sel('h3'),
      h4: sel('h4'),
      h1Ink: headingInk('h1'),
      h2Ink: headingInk('h2'),
      h3Ink: headingInk('h3'),
      h4Ink: headingInk('h4'),
      pre: sel('pre'),
      table: sel('table'),
      tableBorders: {
        tableBorderTopWidth: tableEl ? getComputedStyle(tableEl).borderTopWidth : null,
        tableBorderBottomWidth: tableEl ? getComputedStyle(tableEl).borderBottomWidth : null,
        thBorderBottomWidth: thEl ? getComputedStyle(thEl).borderBottomWidth : null,
        thBorderBottomColor: thEl ? getComputedStyle(thEl).borderBottomColor : null,
        tdCount: tdBorders.length,
        td: tdBorders
      },
      codeChip: chipStyle
        ? { ...ink(chip), fontSize: chipStyle.fontSize, padding: chipStyle.padding }
        : null,
      inlineCode: ink(root.querySelector(':not(pre) > code')),
      recordProsePMaxWidth: prose ? getComputedStyle(prose).maxWidth : null,
      // The scannability pass, measured off the live layout: does 72ch bind,
      // and is the hairline on h2 alone. `charsPerLineEstimate` is a proxy at
      // 0.5em average glyph — the raw numbers beside it are the proof.
      scannability: {
        proseP: measuredBox(proseP),
        proseH2: measuredBox(proseH2),
        headingBorders: {
          h1: measuredBox(root.querySelector('h1')),
          h2: measuredBox(root.querySelector('h2')),
          h3: measuredBox(root.querySelector('h3')),
          h4: measuredBox(root.querySelector('h4'))
        },
        measure: {
          containingBlockClientWidth,
          markdownBodyClientWidth,
          resolvedChPx: resolvedChPx === null ? null : Number(resolvedChPx.toFixed(2)),
          proseClientWidth: proseP instanceof HTMLElement ? proseP.clientWidth : null,
          proseMaxWidth: proseP ? getComputedStyle(proseP).maxWidth : null,
          proseScrollWidth: proseP instanceof HTMLElement ? proseP.scrollWidth : null,
          fontSize: pFontSize === null ? null : pFontSize,
          charsPerLineEstimate:
            proseP instanceof HTMLElement && pFontSize
              ? Math.round(proseP.clientWidth / (pFontSize * 0.5))
              : null
        },
        lines: {
          // ClientRects on the block is one fragment for an unbroken block; the
          // Range rects are the real line boxes.
          blockClientRectCount: proseP instanceof HTMLElement ? proseP.getClientRects().length : null,
          textLineRectCount: proseLineRects.length,
          firstLineWidthPx: proseLineRects[0] ? Number(proseLineRects[0].width.toFixed(2)) : null,
          lastLineWidthPx: proseLineRects.length
            ? Number(proseLineRects[proseLineRects.length - 1]!.width.toFixed(2))
            : null,
          longestLineWidthPx: proseLineRects.length
            ? Number(Math.max(...proseLineRects.map((r) => r.width)).toFixed(2))
            : null,
          charsPerRenderedLine,
          text: (proseP?.textContent ?? '').trim()
        }
      }
    }
  })
  console.log('MARKDOWN_PROBE ' + JSON.stringify(measured, null, 2))

  // Wrap-alignment measurement: does a wrapped list line sit under its item's text
  // (delta 0) or run back under the marker (negative)? Read from layout, not CSS.
  const wrap = await result.locator('.markdown-body').evaluate((root) => {
    const items = [...root.querySelectorAll('li')]
    const pick = (predicate: (li: HTMLElement) => boolean) =>
      items.find((li) => predicate(li as HTMLElement)) ?? null
    const describe = (li: HTMLElement | null) => {
      if (!li) return null
      const rects = [...li.getClientRects()].filter((r) => r.width > 0 && r.height > 0)
      const cs = getComputedStyle(li)
      const list = li.closest('ul, ol') as HTMLElement | null
      const listCs = list ? getComputedStyle(list) : null
      const first = rects[0]?.left ?? null
      const second = rects[1]?.left ?? null
      return {
        text: (li.textContent ?? '').trim().slice(0, 60),
        clientRectCount: rects.length,
        firstRectLeft: first,
        secondRectLeft: second,
        wrapDeltaPx: first !== null && second !== null ? Number((second - first).toFixed(2)) : null,
        boundingLeft: li.getBoundingClientRect().left,
        listStylePosition: listCs?.listStylePosition ?? null,
        listPaddingLeft: listCs?.paddingLeft ?? null,
        liTextIndent: cs.textIndent,
        liPaddingLeft: cs.paddingLeft,
        liPaddingRight: cs.paddingRight
      }
    }
    const wrapped =
      pick((li) => li.getClientRects().length > 1) ??
      pick((li) => li.scrollWidth > li.clientWidth + 1)
    return {
      totalListItems: items.length,
      itemsWithMultipleClientRects: items.filter((li) => li.getClientRects().length > 1).length,
      wrappedItem: describe(wrapped),
      firstListItem: describe(pick((li) => true)),
      longestItem: describe(
        items.reduce<HTMLElement | null>(
          (best, li) =>
            (li as HTMLElement).getClientRects().length >
            (best?.getClientRects().length ?? 0)
              ? (li as HTMLElement)
              : best,
          null
        )
      )
    }
  })
  console.log('MARKDOWN_PROBE_WRAP ' + JSON.stringify(wrap, null, 2))
})