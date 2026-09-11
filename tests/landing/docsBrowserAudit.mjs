/* global document, getComputedStyle, location, window */

import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { chromium } from '@playwright/test'

const repo = process.cwd()
const contentRoot = join(repo, 'landing', 'src', 'content', 'docs')
const baseUrl = process.env.DOCS_BASE_URL ?? 'http://127.0.0.1:4321'
const DOC_SECTIONS = [
  'start',
  'agent',
  'customize',
  'tools',
  'concepts',
  'reference',
  'troubleshooting'
]

function markdownRoutes(dir, prefix = '') {
  const routes = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) routes.push(...markdownRoutes(join(dir, entry.name), rel))
    else if (entry.name.endsWith('.md')) routes.push(`/docs/${rel.replace(/\.md$/, '')}`)
  }
  return routes
}

function browserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : null,
    process.platform === 'win32' && process.env.PROGRAMFILES
      ? join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      : null,
    chromium.executablePath()
  ].filter(Boolean)
  const executable = candidates.find((candidate) => existsSync(candidate))
  if (!executable) throw new Error('No Playwright Chromium, Chrome, or Edge executable found')
  return executable
}

function luminance([red, green, blue]) {
  const channels = [red, green, blue].map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function contrastRatio(a, b) {
  const lighter = Math.max(luminance(a), luminance(b))
  const darker = Math.min(luminance(a), luminance(b))
  return (lighter + 0.05) / (darker + 0.05)
}

function rgb(value) {
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    return [...value.slice(1)].map((channel) => Number.parseInt(`${channel}${channel}`, 16))
  }
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    return [
      Number.parseInt(value.slice(1, 3), 16),
      Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16)
    ]
  }
  const channels = value.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number)
  if (!channels || channels.length !== 3) throw new Error(`Unsupported color: ${value}`)
  return channels
}

const articleRoutes = markdownRoutes(contentRoot).sort()
const docRoutes = [
  '/docs',
  ...DOC_SECTIONS.map((section) => `/docs/${section}`),
  ...articleRoutes
]
if (docRoutes.length !== 51) {
  throw new Error(`Expected 51 canonical docs routes, found ${docRoutes.length}`)
}

const viewports = [
  { name: 'compact', width: 1024, height: 484 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 }
]
const errors = []
const internalLinks = new Set()
const screenshots = {
  darkDesktop: join(tmpdir(), 'vyotiq-home-dark-1440x900.png'),
  darkCompact: join(tmpdir(), 'vyotiq-home-dark-1024x484.png'),
  darkTablet: join(tmpdir(), 'vyotiq-home-dark-768x1024.png'),
  darkMobile: join(tmpdir(), 'vyotiq-home-dark-390x844.png'),
  lightDesktop: join(tmpdir(), 'vyotiq-home-light-1440x900.png'),
  providerDetails: join(tmpdir(), 'vyotiq-provider-row-dark-1440x900.png')
}

function fail(message) {
  errors.push(message)
}

async function goto(page, route, label = route, expectedStatus = 200) {
  const response = await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' })
  if (response == null && route.includes('#')) return response
  if (response?.status() !== expectedStatus) {
    fail(`${label}: expected HTTP ${expectedStatus}, got ${response?.status()}`)
  }
  return response
}

async function checkNoOverflow(page, label) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  )
  if (overflow) fail(`${label}: horizontal page overflow`)
}

async function checkTargets(page, selector, label) {
  const undersized = await page.locator(selector).evaluateAll((elements) =>
    elements
      .filter((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      })
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return { text: element.getAttribute('aria-label') || element.textContent?.trim(), width: rect.width, height: rect.height }
      })
      .filter((target) => target.width < 44 || target.height < 44)
  )
  if (undersized.length > 0) fail(`${label}: undersized targets ${JSON.stringify(undersized)}`)
}

async function checkTypography(page, label) {
  const wrongFont = await page
    .locator('h1, h2, h3, button, nav, a, p, .docs-index-list')
    .evaluateAll((elements) =>
      elements
        .map((element) => ({
          text: element.textContent?.trim().slice(0, 80),
          family: getComputedStyle(element).fontFamily
        }))
        .filter(
          (element) =>
            !element.family.includes('Schibsted Grotesk') && !element.family.includes('IBM Plex Mono')
        )
    )
  if (wrongFont.length > 0) {
    fail(`${label}: interface typography is not Schibsted Grotesk or IBM Plex Mono ${JSON.stringify(wrongFont)}`)
  }
}

async function checkThemeContrast(page, route, viewport, theme) {
  await page.evaluate((nextTheme) => localStorage.setItem('vyotiq-theme', nextTheme), theme)
  await page.reload({ waitUntil: 'domcontentloaded' })
  const renderedTheme = await page.locator('html').getAttribute('data-theme')
  if (renderedTheme !== theme) fail(`${viewport} ${route}: expected ${theme} theme, got ${renderedTheme}`)
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    return {
      bg: style.getPropertyValue('--bg').trim(),
      muted: style.getPropertyValue('--muted').trim(),
      border: style.getPropertyValue('--border').trim(),
      surface: style.getPropertyValue('--surface').trim()
    }
  })
  for (const [foreground, background, threshold] of [
    ['muted', 'bg', 4.5],
    ['muted', 'surface', 4.5],
    ['border', 'bg', 3],
    ['border', 'surface', 3]
  ]) {
    const ratio = contrastRatio(rgb(tokens[foreground]), rgb(tokens[background]))
    if (ratio < threshold) {
      fail(`${viewport} ${route} ${theme}: ${foreground}/${background} contrast ${ratio.toFixed(2)} < ${threshold}`)
    }
  }
}

async function checkDocsRoute(page, route, viewport) {
  await goto(page, route, `${viewport} ${route}`)
  if ((await page.locator('main h1').count()) !== 1) fail(`${viewport} ${route}: expected one main h1`)
  if ((await page.locator('header').count()) !== 1 || (await page.locator('footer').count()) !== 1) {
    fail(`${viewport} ${route}: missing header or footer`)
  }
  const headingSkip = await page.locator('main h1, main h2, main h3').evaluateAll((headings) => {
    const depths = headings.map((heading) => Number(heading.tagName.slice(1)))
    return depths.some((depth, index) => index > 0 && depth > depths[index - 1] + 1)
  })
  if (headingSkip) fail(`${viewport} ${route}: heading level skipped`)

  const metadata = await page.evaluate(() => ({
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.getAttribute('content'),
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    alternate: document.querySelector('link[hreflang="en"]')?.getAttribute('href'),
    socialTitle: document.querySelector('meta[property="og:title"]')?.getAttribute('content'),
    schemas: [...document.querySelectorAll('script[type="application/ld+json"]')].map(
      (node) => node.textContent ?? ''
    )
  }))
  const onDocsIndex = route === '/docs' || route === '/docs/'
  const schemaCount = metadata.schemas.length
  const minSchema = onDocsIndex ? 1 : 2
  if (
    !metadata.title ||
    !metadata.description ||
    !metadata.canonical ||
    !metadata.alternate ||
    !metadata.socialTitle ||
    schemaCount < minSchema
  ) {
    fail(`${viewport} ${route}: incomplete metadata or structured data`)
  }
  if (metadata.schemas.some((text) => text.includes('SoftwareApplication'))) {
    fail(`${viewport} ${route}: SoftwareApplication JSON-LD should only appear on the homepage`)
  }

  await checkNoOverflow(page, `${viewport} ${route}`)
  await checkTypography(page, `${viewport} ${route}`)
  const current = page.locator('.docs-nav [aria-current="page"]')
  if ((await current.count()) !== 1) fail(`${viewport} ${route}: missing unique active navigation item`)
  const headerCurrent = page.locator('header a[href="/docs"][aria-current="page"]')
  const footerCurrent = page.locator('footer a[href="/docs"][aria-current="page"]')
  const headerCount = await headerCurrent.count()
  const footerCount = await footerCurrent.count()
  if (onDocsIndex) {
    if (headerCount !== 1 || footerCount !== 1) {
      fail(`${viewport} ${route}: docs chrome lacks current state`)
    }
  } else if (headerCount !== 0 || footerCount !== 0) {
    fail(`${viewport} ${route}: docs index link claims current page`)
  }

  const unsafeOverflow = await page.locator('pre, table').evaluateAll((elements) =>
    elements.some((element) => element.scrollWidth > element.clientWidth && getComputedStyle(element).overflowX === 'visible')
  )
  if (unsafeOverflow) fail(`${viewport} ${route}: code or table clips`)
  const brokenTocAnchor = await page.locator('.docs-toc a[href^="#"]').evaluateAll((anchors) =>
    anchors.some((anchor) => {
      const id = decodeURIComponent(anchor.getAttribute('href')?.slice(1) ?? '')
      return !id || !document.getElementById(id)
    })
  )
  if (brokenTocAnchor) fail(`${viewport} ${route}: broken TOC anchor`)
  const malformedExternal = await page.locator('a[href]').evaluateAll((anchors) =>
    anchors.some((anchor) => {
      const url = new URL(anchor.href)
      if (url.origin === location.origin) return false
      // mailto links never fetch a remote origin, so the https rule is web-only.
      if (url.protocol === 'mailto:') return false
      return url.protocol !== 'https:' || (anchor.target === '_blank' && !anchor.rel.includes('noopener'))
    })
  )
  if (malformedExternal) fail(`${viewport} ${route}: unsafe external link`)

  await checkTargets(
    page,
    'header a, header button, footer a, [data-docs-search-open], .docs-nav-summary, .docs-nav a, .docs-copy-button',
    `${viewport} ${route}`
  )
  if (viewport === 'desktop') {
    const links = await page.locator('a[href]').evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.href).filter((href) => href.startsWith(location.origin))
    )
    for (const link of links) internalLinks.add(link)
  }
}

function watchRuntime(page, label) {
  page.on('console', (message) => {
    const sourceUrl = message.location().url || page.url()
    const expectedMissingPage =
      new URL(sourceUrl).pathname === '/not-a-real-page' &&
      message.text().includes('Failed to load resource') &&
      message.text().includes('404')
    const expectedMissingFavicon =
      new URL(sourceUrl).pathname === '/favicon.ico' &&
      message.text().includes('Failed to load resource') &&
      message.text().includes('404')
    const expectedAbortedNav = message.text().includes('net::ERR_ABORTED')
    if (
      message.type() === 'error' &&
      !expectedMissingPage &&
      !expectedMissingFavicon &&
      !expectedAbortedNav
    ) {
      fail(`${label}: console error ${message.text()} (${sourceUrl})`)
    }
  })
  page.on('pageerror', (error) => fail(`${label}: page error ${error.message}`))
  page.on('requestfailed', (request) => {
    const errorText = request.failure()?.errorText ?? ''
    if (errorText.includes('ERR_ABORTED')) return
    fail(`${label}: network failure ${request.method()} ${request.url()} ${errorText}`)
  })
}

async function checkHomepage(page, viewport) {
  await goto(page, '/', `${viewport} homepage`)
  await checkNoOverflow(page, `${viewport} homepage`)
  if ((await page.locator('main h1').count()) !== 1) fail(`${viewport} homepage: expected one h1`)
  if ((await page.locator('main section').count()) !== 9) {
    fail(`${viewport} homepage: expected nine narrative sections`)
  }
  const headings = await page.locator('main h1, main h2, main h3').evaluateAll((elements) =>
    elements.map((element) => ({ depth: Number(element.tagName.slice(1)), text: element.textContent?.trim() }))
  )
  if (headings.some((heading, index) => index > 0 && heading.depth > headings[index - 1].depth + 1)) {
    fail(`${viewport} homepage: heading level skipped ${JSON.stringify(headings)}`)
  }
  for (const id of ['overview', 'capabilities']) {
    if ((await page.locator(`#${id}`).count()) !== 1) fail(`${viewport} homepage: missing #${id}`)
  }
  const sectionEyebrows = await page.locator('.eyebrow').allTextContents()
  const expectedEyebrows = [
    '01 One workspace',
    '02 Three modes',
    '03 Long-running work',
    '04 Provider choice',
    '05 Extensions',
    '06 Data boundaries',
    '07 Documentation',
    '→ Get started'
  ]
  if (
    JSON.stringify(sectionEyebrows.map((text) => text.trim().toLowerCase())) !==
    JSON.stringify(expectedEyebrows.map((text) => text.toLowerCase()))
  ) {
    fail(`${viewport} homepage: narrative section order changed ${JSON.stringify(sectionEyebrows)}`)
  }
  const heroStructure = await page.locator('#overview').evaluate((hero) => ({
    headings: hero.querySelectorAll('h1').length,
    paragraphs: hero.querySelectorAll('p').length,
    links: hero.querySelectorAll('a').length,
    text: hero.textContent?.trim() ?? ''
  }))
  if (
    heroStructure.headings !== 1 ||
    heroStructure.paragraphs < 1 ||
    heroStructure.links < 2 ||
    !heroStructure.text.includes('Agent V') ||
    heroStructure.text.includes('Vyotiq Agent V') ||
    /Desktop|Electron/.test(heroStructure.text)
  ) {
    fail(`${viewport} homepage: hero is not concise ${JSON.stringify(heroStructure)}`)
  }
  const heroLinks = await page.locator('#overview a').evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      href: anchor.getAttribute('href') ?? '',
      text: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim()
    }))
  )
  if (!heroLinks.some((link) => link.href.includes('github.com/vyotiqai/vyotiq-agent-v-releases/releases'))) {
    fail(`${viewport} homepage: hero missing GitHub Releases`)
  }
  if (!heroLinks.some((link) => link.href === '/docs')) {
    fail(`${viewport} homepage: hero missing Docs`)
  }
  // The releases repo is public: per-platform installer links are served
  // directly and probed for reachability. The releases-page link stays for
  // the "all downloads" path.
  const packageLinks = await page.locator('#overview [data-release-platform]').evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      platform: anchor.getAttribute('data-release-platform') ?? '',
      href: anchor.getAttribute('href') ?? '',
      text: (anchor.getAttribute('aria-label') ?? anchor.textContent ?? '').replace(/\s+/g, ' ').trim()
    }))
  )
  if (packageLinks.length === 0) {
    fail(`${viewport} homepage: missing installer download buttons`)
  }
  for (const id of ['win', 'mac', 'linux']) {
    if (!packageLinks.some((link) => link.platform === id)) {
      fail(`${viewport} homepage: missing ${id} installer button`)
    }
  }
  const expectedLabels = {
    win: 'Download for Windows',
    mac: 'Download for macOS',
    linux: 'Download for Linux'
  }
  for (const link of packageLinks) {
    if (!/^https:\/\/github\.com\/vyotiqai\/vyotiq-agent-v-releases\/releases\/download\//.test(link.href)) {
      fail(`${viewport} homepage: package link is not a GitHub asset ${JSON.stringify(link)}`)
    }
    const expected = expectedLabels[link.platform]
    if (expected && link.text !== expected) {
      fail(`${viewport} homepage: package label mismatch ${JSON.stringify(link)}`)
    }
    const probe = await page.request.fetch(link.href, {
      method: 'HEAD',
      maxRedirects: 5,
      timeout: 20000
    })
    if (![200, 206, 302, 303, 307, 308].includes(probe.status())) {
      const ranged = await page.request.fetch(link.href, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        maxRedirects: 5,
        timeout: 20000
      })
      if (![200, 206, 302, 303, 307, 308].includes(ranged.status())) {
        fail(
          `${viewport} homepage: ${link.platform} download HTTP ${probe.status()}/${ranged.status()} ${link.href}`
        )
      }
    }
  }
  const metadata = await page.evaluate(() => ({
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
    siteName: document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ?? '',
    homeLabel: document.querySelector('header a[href="/"]')?.getAttribute('aria-label') ?? '',
    headerText: document.querySelector('header a[href="/"]')?.textContent?.trim() ?? '',
    footerText: document.querySelector('footer')?.textContent ?? '',
    wordmarks: [...document.querySelectorAll('header img')].map((image) => image.getAttribute('src'))
  }))
  if (!metadata.title.includes('Agent V') || metadata.title.includes('Vyotiq Agent V')) {
    fail(`${viewport} homepage: title missing Agent V (${metadata.title})`)
  }
  if (
    !metadata.description.includes('Agent V') ||
    metadata.description.includes('Vyotiq Agent V')
  ) {
    fail(`${viewport} homepage: description missing Agent V`)
  }
  if (metadata.siteName !== 'Agent V') {
    fail(`${viewport} homepage: og:site_name is ${metadata.siteName}`)
  }
  if (metadata.homeLabel !== 'Agent V home') {
    fail(`${viewport} homepage: header aria-label is ${metadata.homeLabel}`)
  }
  if (metadata.headerText.includes('Agent V')) {
    fail(`${viewport} homepage: header lockup should stay the Vyotiq mark, not Agent V text`)
  }
  if (!metadata.wordmarks.some((src) => src?.includes('wordmark'))) {
    fail(`${viewport} homepage: header is missing the Vyotiq wordmark`)
  }
  if (!metadata.footerText.includes('Vyotiq') || !/\bAgent V\b/.test(metadata.footerText)) {
    fail(`${viewport} homepage: footer missing company or Agent V product text`)
  }
  const jsonLd = await page.evaluate(() =>
    [...document.querySelectorAll('script[type="application/ld+json"]')].map((node) => node.textContent ?? '')
  )
  if (!jsonLd.some((text) => text.includes('SoftwareApplication'))) {
    fail(`${viewport} homepage: missing SoftwareApplication JSON-LD`)
  }
  await checkTypography(page, `${viewport} homepage`)
  const providerMarks = page.locator('.provider-list .provider-mark svg')
  if ((await providerMarks.count()) !== 11) {
    fail(`${viewport} homepage: expected 11 provider marks`)
  }
  const brokenBrandImages = await page.locator('header img, footer img').evaluateAll((images) =>
    images.filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.getAttribute('src'))
  )
  if (brokenBrandImages.length > 0) {
    fail(`${viewport} homepage: broken brand images ${JSON.stringify(brokenBrandImages)}`)
  }
  const chromeLinks = await page.locator('header a, footer a').evaluateAll((anchors) =>
    anchors.map((anchor) => anchor.getAttribute('href'))
  )
  for (const href of [
    '/',
    '/#overview',
    '/#capabilities',
    '/docs',
    '/docs/agent/modes',
    '/docs/concepts/security',
    '/docs/concepts/privacy-data',
    '/privacy'
  ]) {
    if (!chromeLinks.includes(href)) fail(`${viewport} homepage: missing chrome link ${href}`)
  }
  const docsHrefs = await page.locator('main a[href^="/docs"]').evaluateAll((anchors) =>
    [...new Set(anchors.map((anchor) => anchor.getAttribute('href')).filter(Boolean))]
  )
  if (docsHrefs.length !== 10) fail(`${viewport} homepage: expected 10 unique docs links, found ${docsHrefs.length}`)
  for (const href of docsHrefs) {
    const response = await page.request.get(new URL(href, baseUrl).href)
    if (!response.ok()) fail(`${viewport} homepage link ${href}: HTTP ${response.status()}`)
  }
  const sticky = await page.locator('body > header').evaluate((element) => getComputedStyle(element).position)
  if (sticky !== 'sticky') fail(`${viewport} homepage: header is not sticky`)
  await checkTargets(page, 'header a, header button, footer a, main a', `${viewport} homepage`)
}

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true })

try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport })
    await context.addInitScript(() => {
      if (localStorage.getItem('vyotiq-theme') == null) localStorage.setItem('vyotiq-theme', 'light')
    })
    const page = await context.newPage()
    watchRuntime(page, viewport.name)

    for (const route of docRoutes) await checkDocsRoute(page, route, viewport.name)

    await checkHomepage(page, viewport.name)
    for (const route of ['/#overview', '/#capabilities']) {
      await goto(page, route, `${viewport.name} ${route}`)
      await checkNoOverflow(page, `${viewport.name} ${route}`)
      const id = route.slice(route.indexOf('#') + 1)
      if ((await page.locator(`#${id}`).count()) !== 1) fail(`${viewport.name} ${route}: missing anchor target`)
    }

    for (const route of ['/', '/docs/start/quickstart', '/not-a-real-page']) {
      await goto(page, route, `${viewport.name} theme ${route}`, route === '/not-a-real-page' ? 404 : 200)
      await checkNoOverflow(page, `${viewport.name} ${route}`)
      await checkThemeContrast(page, route, viewport.name, 'light')
      await checkThemeContrast(page, route, viewport.name, 'dark')
    }
    await context.close()
  }

  const context = await browser.newContext({ viewport: { width: 1024, height: 484 } })
  await context.addInitScript(() => {
    if (localStorage.getItem('vyotiq-theme') == null) localStorage.setItem('vyotiq-theme', 'light')
  })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl })
  const page = await context.newPage()
  watchRuntime(page, 'interaction audit')

  await page.setViewportSize({ width: 1024, height: 484 })
  await goto(page, '/')
  await page.evaluate(() => localStorage.setItem('vyotiq-theme', 'dark'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.screenshot({ path: screenshots.darkCompact })
  await page.setViewportSize({ width: 1440, height: 900 })
  await goto(page, '/')
  await page.screenshot({ path: screenshots.darkDesktop })
  await page.locator('.provider-band').screenshot({ path: screenshots.providerDetails })
  await page.evaluate(() => localStorage.setItem('vyotiq-theme', 'light'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.screenshot({ path: screenshots.lightDesktop })
  await page.evaluate(() => localStorage.setItem('vyotiq-theme', 'dark'))
  await page.setViewportSize({ width: 768, height: 1024 })
  await goto(page, '/')
  await page.screenshot({ path: screenshots.darkTablet })
  await page.setViewportSize({ width: 390, height: 844 })
  await goto(page, '/')
  await page.screenshot({ path: screenshots.darkMobile })

  await goto(page, '/docs')
  const catalog = await page.locator('.docs-index-list a').count()
  if (catalog < 40) fail(`docs index: expected catalog links, found ${catalog}`)

  await goto(page, '/not-a-real-page', '404 screenshot', 404)
  const robots = await page.locator('meta[name="robots"]').getAttribute('content')
  if (robots !== 'noindex, nofollow') fail(`404 robots is ${robots}`)
  const footerGeometry = await page.evaluate(() => {
    const footer = document.querySelector('footer')?.getBoundingClientRect()
    return { bottom: footer?.bottom ?? 0, viewport: window.innerHeight, scrollHeight: document.documentElement.scrollHeight }
  })
  if (footerGeometry.bottom < footerGeometry.viewport - 1) {
    fail(`404 footer does not reach viewport bottom ${JSON.stringify(footerGeometry)}`)
  }
  await page.getByRole('link', { name: 'Browse docs' }).click()
  if (new URL(page.url()).pathname !== '/docs') fail('404 Browse docs recovery failed')
  await goto(page, '/not-a-real-page', '/not-a-real-page', 404)
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  if (new URL(page.url()).pathname !== '/') fail('404 Home recovery failed')

  await page.setViewportSize({ width: 1440, height: 900 })
  await goto(page, '/docs/start/quickstart')
  await page.keyboard.press('Control+K')
  const dialog = page.locator('[data-docs-search-dialog]')
  if (!(await dialog.evaluate((element) => element.open))) fail('Ctrl+K did not open search')
  const input = page.locator('[data-docs-search-input]')
  if (!(await input.evaluate((element) => element === document.activeElement))) {
    fail('Search input did not receive focus')
  }
  await input.fill('MCP OAuth')
  const resultText = await page.locator('[data-docs-search-results]').innerText()
  if (!resultText.includes('MCP servers')) fail('Search did not return MCP servers')
  const mcpResult = page.locator('[data-docs-search-results] a[href="/docs/customize/mcp"]')
  if ((await mcpResult.count()) === 0) {
    fail('Search did not return the MCP servers page')
  } else {
    await Promise.all([
      page.waitForURL((url) => url.pathname === '/docs/customize/mcp', { timeout: 8000 }),
      mcpResult.first().click({ force: true })
    ]).catch((error) => {
      fail(`Search MCP navigation failed: ${error instanceof Error ? error.message : error}`)
    })
  }
  if (new URL(page.url()).pathname !== '/docs/customize/mcp') fail('Search result did not navigate')
  await goto(page, '/docs/start/quickstart')
  await page.keyboard.press('Control+K')
  await page.keyboard.press('Escape')
  const searchDialog = page.locator('[data-docs-search-dialog]')
  if (await searchDialog.evaluate((element) => element.open)) fail('Escape did not close search')

  await page.evaluate(() => localStorage.setItem('vyotiq-theme', 'light'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-theme-toggle]').click()
  await page.locator('[data-theme-option="dark"]').click()
  if ((await page.locator('html').getAttribute('data-theme')) !== 'dark') fail('Theme toggle did not reach dark')
  await page.reload({ waitUntil: 'domcontentloaded' })
  if ((await page.locator('html').getAttribute('data-theme')) !== 'dark') fail('Dark theme did not persist')

  const title = (await page.locator('main h1').innerText()).trim()
  const currentCrumb = page.locator('.docs-breadcrumbs [aria-current="page"]')
  if ((await currentCrumb.count()) !== 1 || (await currentCrumb.innerText()).trim() !== title) {
    fail('Breadcrumb does not expose current page')
  }
  await page.locator('[data-docs-copy]').click()
  // The handler fetches the raw markdown before writing the clipboard —
  // wait for the visible 'Copied' feedback instead of racing the write.
  await page
    .locator('[data-docs-copy-label]', { hasText: 'Copied' })
    .waitFor({ timeout: 8000 })
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  if (!copied.includes(title) || !copied.includes('/docs/start/quickstart')) fail('Copy page content is incomplete')

  await goto(page, '/docs/start/quickstart')
  const skipIsFirst = await page.locator('a[href], button, input, summary, [tabindex]').evaluateAll(
    (elements) => elements[0]?.classList.contains('skip-link') === true
  )
  if (!skipIsFirst) fail('Skip link is not first in focus order')
  await page.keyboard.press('Tab')
  if (!(await page.locator('.skip-link').evaluate((element) => element === document.activeElement))) {
    fail('Keyboard Tab did not focus the skip link first')
  }
  const focusStyle = await page.locator('.skip-link').evaluate((element) => {
    const style = getComputedStyle(element)
    return { width: element.getBoundingClientRect().width, outlineWidth: style.outlineWidth }
  })
  if (focusStyle.width < 44 || Number.parseFloat(focusStyle.outlineWidth) < 2) {
    fail(`Skip link focus is not visible ${JSON.stringify(focusStyle)}`)
  }
  await page.keyboard.press('Enter')
  const mainFocused = await page.locator('#main-content').evaluate((element) => element === document.activeElement)
  if (!mainFocused) fail('Skip link did not focus main content')

  await goto(page, '/docs/start/quickstart')
  const tocLink = page.locator('.docs-toc a[href^="#"]').first()
  if (await tocLink.isVisible()) {
    const expectedHash = await tocLink.getAttribute('href')
    await tocLink.click()
    if (new URL(page.url()).hash !== expectedHash) fail('TOC link did not update the article anchor')
  }
  const pagerLinks = page.locator('.docs-pager a')
  if ((await pagerLinks.count()) === 0) fail('Previous/next navigation is missing')
  else {
    const pagerHref = await pagerLinks.first().getAttribute('href')
    if (!pagerHref || !(await page.request.get(new URL(pagerHref, baseUrl).href)).ok()) {
      fail('Previous/next link failed')
    }
  }
  const related = page.locator('.docs-related a').first()
  if ((await related.count()) > 0) {
    const relatedHref = await related.getAttribute('href')
    if (!relatedHref || !(await page.request.get(new URL(relatedHref, baseUrl).href)).ok()) {
      fail('Related-page link failed')
    }
  }

  for (const href of internalLinks) {
    const response = await page.request.get(href)
    if (!response.ok()) fail(`internal link ${href}: HTTP ${response.status()}`)
  }
  for (const [oldRoute, target] of [
    ['/products/agent-v', '/'],
    ['/docs/start/product-tour', '/docs/start/quickstart'],
    ['/docs/guides/modes', '/docs/agent/modes'],
    ['/docs/guides/providers', '/docs/customize/providers'],
    ['/docs/guides/marketplace', '/docs/customize/marketplace'],
    ['/docs/guides/memory-and-search', '/docs/tools/memory'],
    ['/docs/guides/checkpoints', '/docs/agent/checkpoints'],
    ['/docs/guides/approval-browser-terminal', '/docs/tools/browser'],
    ['/docs/guides/git', '/docs/tools/changes-git'],
    ['/docs/concepts/context', '/docs/agent/context-compaction'],
    ['/docs/reference/layout', '/docs/agent/workspaces-sessions'],
    ['/docs/reference/slash-commands', '/docs/customize/slash-commands']
  ]) {
    await page.goto(`${baseUrl}${oldRoute}`, { waitUntil: 'domcontentloaded' })
    await page.waitForURL((url) => url.pathname === target, { timeout: 2000 }).catch(() => undefined)
    if (new URL(page.url()).pathname !== target) {
      fail(`redirect ${oldRoute}: expected ${target}, got ${new URL(page.url()).pathname}`)
    }
  }
  const llms = await page.request.get(`${baseUrl}/llms.txt`)
  const llmsText = await llms.text()
  if (
    !llms.ok() ||
    !llmsText.includes('MCP servers') ||
    !llmsText.includes('Agent V') ||
    llmsText.includes('Vyotiq Agent V')
  ) {
    fail('llms.txt incomplete')
  }
  await goto(page, '/docs/concepts/what-it-is')
  const whatHeading = await page.locator('main h1').innerText()
  if (!whatHeading.includes('Agent V') || whatHeading.includes('Vyotiq Agent V')) {
    fail('what-it-is heading missing Agent V')
  }
  await goto(page, '/docs/start/install')
  const installText = await page.locator('main').innerText()
  if (
    !installText.includes('pnpm pack:win') ||
    !installText.includes('download buttons for each installer') ||
    !installText.includes('https://github.com/vyotiqai/vyotiq-agent-v-releases/releases/latest') ||
    /the Vyotiq download page/i.test(installText)
  ) {
    fail('install page missing homepage downloads or pack-from-source')
  }
  await goto(page, '/privacy')
  const privacyHeading = await page.locator('main h1').innerText()
  const privacyText = await page.locator('main').innerText()
  if (!privacyHeading.includes('Website privacy')) fail('privacy page missing heading')
  if (!privacyText.includes('vyotiq-theme') || !privacyText.includes('does not load an analytics script')) {
    fail('privacy page missing website storage or analytics copy')
  }
  if (/the Vyotiq download page/i.test(privacyText)) fail('privacy page used retired download copy')
  const sitemap = await page.request.get(`${baseUrl}/sitemap-index.xml`)
  if (!sitemap.ok()) fail(`sitemap-index.xml: HTTP ${sitemap.status()}`)
  const robotsTxt = await page.request.get(`${baseUrl}/robots.txt`)
  const robotsBody = await robotsTxt.text()
  if (
    !robotsTxt.ok() ||
    !robotsBody.includes('Allow: /') ||
    !robotsBody.includes('Sitemap: https://vyotiq.com/sitemap-index.xml')
  ) {
    fail('robots.txt incomplete')
  }
  const securityTxt = await page.request.get(`${baseUrl}/.well-known/security.txt`)
  const securityBody = await securityTxt.text()
  if (
    !securityTxt.ok() ||
    !securityBody.includes('Contact: https://github.com/vyotiqai/vyotiq-agent-v/security/advisories/new') ||
    !securityBody.includes('Contact: mailto:security@vyotiq.com') ||
    !securityBody.includes('Canonical: https://vyotiq.com/.well-known/security.txt') ||
    !securityBody.includes('Policy: https://github.com/vyotiqai/vyotiq-agent-v/blob/main/SECURITY.md') ||
    !/^Expires:/m.test(securityBody)
  ) {
    fail('security.txt incomplete')
  }
  await context.close()

  const noScriptContext = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 }
  })
  const noScript = await noScriptContext.newPage()
  const noScriptResponse = await noScript.goto(`${baseUrl}/docs/start/quickstart`, {
    waitUntil: 'domcontentloaded'
  })
  if (
    !noScriptResponse?.ok() ||
    !(await noScript.locator('main').innerText()).includes('Configure a provider') ||
    !(await noScript.locator('#docs-nav-box').evaluate((element) => element.open))
  ) {
    fail('JavaScript-disabled fallback hides primary documentation')
  }
  await noScript.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' })
  if (
    (await noScript.locator('main section').count()) !== 9 ||
    !(await noScript.locator('main').innerText()).includes('Local by default. Explicit about the network.')
  ) {
    fail('JavaScript-disabled fallback hides homepage narrative')
  }
  await noScriptContext.close()

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const mobile = await mobileContext.newPage()
  await goto(mobile, '/docs/start/quickstart')
  const menu = mobile.locator('#docs-nav-box')
  if (await menu.evaluate((element) => element.open)) fail('Mobile docs menu starts open')
  await mobile.getByText('Docs menu', { exact: true }).click()
  if (!(await menu.evaluate((element) => element.open))) fail('Mobile docs menu did not open')
  await mobileContext.close()
} finally {
  await browser.close()
}

if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log(`PASS ${docRoutes.length} canonical docs routes at 390x844, 768x1024, 1024x484, and 1440x900`)
  console.log('PASS homepage narrative, docs links, anchors, redirects, 404 recovery, search, focus, themes, contrast, and responsive layout')
  for (const path of Object.values(screenshots)) console.log(`SCREENSHOT ${path}`)
}
