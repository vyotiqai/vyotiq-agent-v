/**
 * @vitest-environment jsdom
 *
 * The mermaid theme object cannot take `var()`, which is the one place a
 * literal colour is sanctioned (CLAUDE.md, constraint 2). MermaidDiagram takes
 * that exception without the literals: every role is read from a `--vy-*`
 * token, so a skin's own values are the only thing that can reach a diagram.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readMermaidThemeVariables } from '@renderer/lib/ui/MermaidDiagram'

const SOURCE = readFileSync(
  join(__dirname, '../../../src/renderer/src/lib/ui/MermaidDiagram.tsx'),
  'utf8'
)

/** A distinct colour per token, so a role reading the wrong token shows up. */
const TOKENS: Record<string, string> = {
  '--vy-sunken': '#010101',
  '--vy-bg': '#020202',
  '--vy-surface': '#030303',
  '--vy-surface-2': '#040404',
  '--vy-card': '#050505',
  '--vy-border': '#060606',
  '--vy-border-strong': '#070707',
  '--vy-fg': '#080808',
  '--vy-fg-strong': '#090909',
  '--vy-muted': '#0a0a0a',
  '--vy-tertiary': '#0b0b0b'
}

function setTokens(): void {
  for (const [token, value] of Object.entries(TOKENS)) {
    document.documentElement.style.setProperty(token, value)
  }
}

afterEach(() => {
  for (const token of Object.keys(TOKENS)) document.documentElement.style.removeProperty(token)
})

describe('MermaidDiagram theme', () => {
  it('has no colour literal of its own to fall back on', () => {
    // A quoted hex — '…', "…" or `…` immediately followed by # — is the shape
    // a fallback takes. The read path's colour regex holds `#` too, but never
    // after a quote, so this cannot match it.
    expect(SOURCE).not.toMatch(/['"`]#[0-9a-f]{3,8}/i)
  })

  it('draws every role from the token read path, first token on the ladder', () => {
    setTokens()
    const vars = readMermaidThemeVariables(false)
    expect(vars.background).toBe(TOKENS['--vy-sunken'])
    expect(vars.primaryColor).toBe(TOKENS['--vy-surface'])
    expect(vars.mainBkg).toBe(TOKENS['--vy-surface'])
    expect(vars.secondaryColor).toBe(TOKENS['--vy-card'])
    expect(vars.clusterBkg).toBe(TOKENS['--vy-card'])
    expect(vars.secondaryBorderColor).toBe(TOKENS['--vy-border'])
    expect(vars.clusterBorder).toBe(TOKENS['--vy-border'])
    expect(vars.primaryBorderColor).toBe(TOKENS['--vy-border-strong'])
    expect(vars.nodeBorder).toBe(TOKENS['--vy-border-strong'])
    expect(vars.secondaryTextColor).toBe(TOKENS['--vy-fg'])
    expect(vars.textColor).toBe(TOKENS['--vy-fg'])
    expect(vars.primaryTextColor).toBe(TOKENS['--vy-fg-strong'])
    expect(vars.titleColor).toBe(TOKENS['--vy-fg-strong'])
    expect(vars.lineColor).toBe(TOKENS['--vy-muted'])
    // Not colours: the two flags mermaid takes as-is.
    expect(vars.darkMode).toBe(false)
    expect(vars.fontFamily).toBe('inherit')
  })

  it('carries no value that is not one of the tokens it read', () => {
    setTokens()
    const vars = readMermaidThemeVariables(true)
    const tokenValues = new Set(Object.values(TOKENS))
    for (const [key, value] of Object.entries(vars)) {
      if (key === 'darkMode' || key === 'fontFamily') continue
      expect(tokenValues.has(String(value))).toBe(true)
    }
    expect(vars.darkMode).toBe(true)
  })

  it('skips a token mermaid cannot parse and takes the next on the ladder', () => {
    setTokens()
    document.documentElement.style.setProperty('--vy-muted', 'color-mix(in srgb, red 50%, blue)')
    const vars = readMermaidThemeVariables(false)
    expect(vars.lineColor).toBe(TOKENS['--vy-tertiary'])
  })

  it('leaves a role mermaid its own default rather than inventing a colour', () => {
    // No tokens set at all (jsdom has no styles.css): every read is empty, so
    // no role may be handed a value the token layer did not supply.
    const vars = readMermaidThemeVariables(false)
    for (const [key, value] of Object.entries(vars)) {
      if (key === 'darkMode' || key === 'fontFamily') continue
      expect(String(value)).not.toMatch(/^#/)
    }
    expect('lineColor' in vars).toBe(false)
    expect('primaryColor' in vars).toBe(false)
    expect(vars.darkMode).toBe(false)
    expect(vars.fontFamily).toBe('inherit')
  })
})
