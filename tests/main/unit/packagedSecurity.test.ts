import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Packaged-app security smoke test — pins the hardening invariants that new
 * windows, views, or build config could silently regress:
 *   1. every webPreferences is fully hardened (main window AND agent tabs),
 *   2. no unsafe webPreferences flag exists anywhere in main/preload source,
 *   3. certificate verification has no bypass path,
 *   4. the packaged build keeps asar integrity + updater signature verification,
 *   5. the renderer boundary is exposed only through contextBridge.
 * Source-reading (like ipcChannelParity) because creating real windows in unit
 * tests is impossible; the flags live verbatim in the source that runs.
 */

const ROOT = process.cwd()

function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walkTsFiles(p, out)
    else if ((entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) && !entry.name.endsWith('.d.ts')) {
      out.push(p)
    }
  }
  return out
}

/** Extract a top-level YAML block's body (lines until the next top-level key). */
function topLevelBlock(yaml: string, key: string): string {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex((line) => line.startsWith(`${key}:`))
  if (start === -1) return ''
  const body: string[] = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) break
    body.push(line)
  }
  return body.join('\n')
}

/** Brace-balanced extraction of an arrow-function block following `head`. */
function extractArrowBlock(src: string, head: string): string {
  const start = src.indexOf(head)
  if (start === -1) return ''
  const open = src.indexOf('{', start + head.length)
  if (open === -1) return ''
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return ''
}

describe('webPreferences hardening', () => {
  it('hardens the main window', () => {
    const src = readSrc('src/main/app/window.ts')
    expect(src).toMatch(/contextIsolation:\s*true/)
    expect(src).toMatch(/nodeIntegration:\s*false/)
    expect(src).toMatch(/sandbox:\s*true/)
    expect(src).toMatch(/webSecurity:\s*true/)
  })

  it('hardens agent browser tab views and attaches their security hooks', () => {
    const src = readSrc('src/main/app/agentBrowser.ts')
    const tabPrefs = src.match(/new WebContentsView\(\{\s*webPreferences:\s*\{([\s\S]*?)\}\s*\}\)/)
    expect(tabPrefs).toBeTruthy()
    const prefs = tabPrefs![1]!
    expect(prefs).toMatch(/contextIsolation:\s*true/)
    expect(prefs).toMatch(/nodeIntegration:\s*false/)
    expect(prefs).toMatch(/sandbox:\s*true/)
    expect(prefs).toMatch(/webSecurity:\s*true/)
    // Guest security (window-open deny, permission gates) attaches at creation.
    expect(src).toMatch(/attachAgentSecurity\(view\.webContents\)/)
  })

  it('finds no unsafe webPreferences flag anywhere in main or preload source', () => {
    const forbidden = [
      /nodeIntegration:\s*true/,
      /contextIsolation:\s*false/,
      /webSecurity:\s*false/,
      /sandbox:\s*false/,
      /allowRunningInsecureContent:\s*true/,
      /enableRemoteModule/
    ]
    const files = [...walkTsFiles(join(ROOT, 'src/main')), ...walkTsFiles(join(ROOT, 'src/preload'))]
    const offenders: string[] = []
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      for (const pattern of forbidden) {
        if (pattern.test(src)) offenders.push(`${file}: ${String(pattern)}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('certificate verification', () => {
  it('has no bypass path — verify proc only defers to Chromium', () => {
    const src = readSrc('src/main/app/security.ts')
    const body = extractArrowBlock(src, 'setCertificateVerifyProc')
    expect(body).toBeTruthy()
    expect(body).not.toMatch(/callback\(\s*(0|true)\s*\)/)
    expect(body).toMatch(/callback\(-3\)/)
  })
})

describe('preload boundary', () => {
  it('exposes the API only through contextBridge', () => {
    const src = readSrc('src/preload/index.ts')
    expect(src).toMatch(/contextBridge\.exposeInMainWorld/)
    expect(src).not.toMatch(/nodeIntegration/)
  })
})

describe('packaged build config (electron-builder.yml)', () => {
  const yaml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')

  it('ships the app inside asar', () => {
    expect(yaml).toMatch(/^asar: true\s*$/m)
    expect(yaml).toMatch(/^asarUnpack:/m)
  })

  it('keeps the updater signature-verification stance explicit', () => {
    const win = topLevelBlock(yaml, 'win')
    // publisherName is intentionally unset while release builds are unsigned —
    // setting it without a cert breaks every auto-update (ERR_UPDATER_INVALID_
    // SIGNATURE). The tripwire: it is either configured, or its documented
    // absence stays attached so the hardening cannot be silently forgotten.
    const hasPublisherName = /^ {2}publisherName:/m.test(win)
    if (hasPublisherName) return
    expect(win).toMatch(/publisherName enables NSIS updater signature verification/)
  })
})
