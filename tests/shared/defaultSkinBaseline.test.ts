import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function blockTokens(css: string, selector: string): Record<string, string> {
  let body: string | undefined
  if (selector === '[data-theme="light"]') {
    body = css.match(/:root,\s*\[data-theme="light"\]\s*\{([^}]+)\}/)?.[1]
  } else if (selector === '[data-theme="dark"]') {
    body = css.match(/(?:^|\n)\[data-theme="dark"\]\s*\{([^}]+)\}/m)?.[1]
  } else if (selector === '[data-skin]') {
    body = css.match(/:root,\s*\[data-skin\]\s*\{([^}]+)\}/)?.[1]
  } else {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    body =
      css.match(new RegExp(`:root,\\s*${escaped}\\s*\\{([^}]+)\\}`))?.[1] ??
      css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`, 'm'))?.[1]
  }
  if (!body) return {}
  const out: Record<string, string> = {}
  for (const line of body.split(';')) {
    const withoutComment = line.replace(/\/\*[\s\S]*?\*\//g, '')
    const trimmed = withoutComment.trim()
    if (!trimmed.startsWith('--')) continue
    const idx = trimmed.indexOf(':')
    if (idx < 0) continue
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
  }
  return out
}

describe('default skin baseline', () => {
  const css = readFileSync(
    join(process.cwd(), 'src/renderer/src/styles.css'),
    'utf8'
  )

  it('keeps shipped geometry tokens in the base [data-skin] block', () => {
    const tokens = blockTokens(css, '[data-skin]')
    expect(tokens['--vy-radius-sm']).toBe('4px')
    expect(tokens['--vy-radius-md']).toBe('6px')
    expect(tokens['--vy-radius-lg']).toBe('8px')
    expect(tokens['--vy-radius-xl']).toBe('10px')
    expect(tokens['--vy-font-sans']).toContain('Plus Jakarta Sans')
    expect(tokens['--vy-font-mono']).toContain('JetBrains Mono')
  })

  it('keeps panes flush in every skin: one hairline, no gap, radius or shadow', () => {
    const panel = /@utility vy-panel \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(panel).toContain('border-left: 1px solid var(--vy-border)')
    expect(panel).not.toMatch(/radius|shadow|margin/)
    expect(css).not.toMatch(/--vy-panel-(gap|radius|shadow|border-width)/)
  })

  it('does not override palette in a [data-skin="default"][data-theme] block', () => {
    expect(css).not.toMatch(/\[data-skin="default"\]\[data-theme=/)
  })

  it('pins the Azure-tinted Default light palette in the base [data-theme="light"] block', () => {
    const tokens = blockTokens(css, '[data-theme="light"]')
    const expectToken = (name: string, value: string) =>
      expect((tokens[name] ?? '').toLowerCase()).toBe(value.toLowerCase())
    expectToken('--vy-chrome', '#f1f4f6')
    expectToken('--vy-bg', '#ffffff')
    expectToken('--vy-card', '#f7f9fa')
    expectToken('--vy-surface', '#eef2f5')
    expectToken('--vy-surface-2', '#e3e9ee')
    expectToken('--vy-border', '#dde4ea')
    expectToken('--vy-fg', '#1a252d')
    expectToken('--vy-muted', '#5d6b76')
    expectToken('--vy-accent', '#00638e')
  })

  it('pins the Azure-tinted Default dark palette in the base [data-theme="dark"] block', () => {
    const tokens = blockTokens(css, '[data-theme="dark"]')
    const expectToken = (name: string, value: string) =>
      expect((tokens[name] ?? '').toLowerCase()).toBe(value.toLowerCase())
    expectToken('--vy-chrome', '#0c0f11')
    expectToken('--vy-bg', '#13171a')
    expectToken('--vy-card', '#171c1f')
    expectToken('--vy-surface', '#1d2327')
    expectToken('--vy-border', '#252d33')
    expectToken('--vy-fg', '#dde4e9')
    expectToken('--vy-muted', '#8795a1')
    expectToken('--vy-accent', '#4fb3e8')
  })
})
