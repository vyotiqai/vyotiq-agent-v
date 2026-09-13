import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SKIN_IDS } from '@shared/skins'

function themeTokens(css: string, blockRe: RegExp): Record<string, string> {
  const m = css.match(blockRe)
  if (!m) return {}
  const out: Record<string, string> = {}
  for (const line of m[1].split(';')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('--')) continue
    const idx = trimmed.indexOf(':')
    if (idx < 0) continue
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
  }
  return out
}

function mergedSkinTokens(
  css: string,
  skin: string,
  theme: 'light' | 'dark'
): Record<string, string> {
  const base = themeTokens(css, new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([^}]+)\\}`))
  const skinGeo =
    skin === 'default'
      ? themeTokens(css, /\[data-skin="default"\]\s*\{([^}]+)\}/)
      : themeTokens(css, new RegExp(`\\[data-skin="${skin}"\\]\\s*\\{([^}]+)\\}`))
  const skinTheme = themeTokens(
    css,
    new RegExp(`\\[data-skin="${skin}"\\]\\[data-theme="${theme}"\\]\\s*\\{([^}]+)\\}`)
  )
  return { ...base, ...skinGeo, ...skinTheme }
}

function resolveToken(tokens: Record<string, string>, name: string, depth = 0): string {
  const raw = tokens[name]
  if (!raw || depth > 10) return raw ?? ''
  const trimmed = raw.trim()
  const varMatch = trimmed.match(/^var\((--[^)]+)\)$/)
  if (!varMatch) return trimmed
  return resolveToken(tokens, varMatch[1]!, depth + 1)
}

function contrastRatio(fg: string, bg: string): number {
  const parse = (hex: string): number => {
    const h = hex.replace('#', '')
    const r = parseInt(h.slice(0, 2), 16) / 255
    const g = parseInt(h.slice(2, 4), 16) / 255
    const b = parseInt(h.slice(4, 6), 16) / 255
    const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  }
  const l1 = parse(fg)
  const l2 = parse(bg)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

function compositeRgbOverHex(rgba: string, backdrop: string): string | null {
  const match = rgba.match(
    /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*\)$/
  )
  if (!match || !backdrop.startsWith('#')) return null
  const alpha = Number(match[4])
  const bg = backdrop.replace('#', '')
  const backdropChannels = [0, 2, 4].map((at) => parseInt(bg.slice(at, at + 2), 16))
  const channels = [Number(match[1]), Number(match[2]), Number(match[3])].map((channel, i) =>
    Math.round(channel * alpha + backdropChannels[i]! * (1 - alpha))
  )
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

function expectAaOnBg(
  tokens: Record<string, string>,
  fgName: string,
  label: string,
  minRatio = 4.5
): void {
  const fg = resolveToken(tokens, fgName)
  const bg = resolveToken(tokens, '--vy-bg')
  if (!fg.startsWith('#') || !bg.startsWith('#')) return
  expect(contrastRatio(fg, bg), label).toBeGreaterThanOrEqual(minRatio)
}

function expectAaOnPair(
  tokens: Record<string, string>,
  fgName: string,
  bgName: string,
  label: string,
  minRatio = 4.5
): void {
  const fg = resolveToken(tokens, fgName)
  const bg = resolveToken(tokens, bgName)
  if (!fg.startsWith('#') || !bg.startsWith('#')) return
  expect(contrastRatio(fg, bg), label).toBeGreaterThanOrEqual(minRatio)
}

describe('skin contrast smoke', () => {
  const css = readFileSync(
    join(process.cwd(), 'src/renderer/src/styles.css'),
    'utf8'
  )

  for (const skin of SKIN_IDS) {
    for (const theme of ['light', 'dark'] as const) {
      it(`${skin} ${theme} keeps readable fg on bg`, () => {
        const tokens = mergedSkinTokens(css, skin, theme)
        expectAaOnBg(tokens, '--vy-fg', `${skin} ${theme} fg`)
      })

      it(`${skin} ${theme} keeps readable muted on bg`, () => {
        const tokens = mergedSkinTokens(css, skin, theme)
        expectAaOnBg(tokens, '--vy-muted', `${skin} ${theme} muted`)
      })

      it(`${skin} ${theme} keeps readable secondary on bg`, () => {
        const tokens = mergedSkinTokens(css, skin, theme)
        expectAaOnBg(tokens, '--vy-secondary', `${skin} ${theme} secondary`)
      })

      it(`${skin} ${theme} keeps accent visible on bg`, () => {
        const tokens = mergedSkinTokens(css, skin, theme)
        expectAaOnBg(tokens, '--vy-accent', `${skin} ${theme} accent`, 3)
      })

      it(`${skin} ${theme} keeps accent-fg readable on accent`, () => {
        const tokens = mergedSkinTokens(css, skin, theme)
        expectAaOnPair(
          tokens,
          '--vy-accent-fg',
          '--vy-accent',
          `${skin} ${theme} accent-fg`
        )
      })

      it(`${skin} ${theme} keeps focus indicator visible on bg`, () => {
        const tokens = mergedSkinTokens(css, skin, theme)
        expectAaOnBg(tokens, '--vy-focus', `${skin} ${theme} focus`, 3)
      })
    }
  }
})
