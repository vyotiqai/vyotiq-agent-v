import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function blockTokens(css: string, selector: string): Record<string, string> {
  let body: string | undefined
  if (selector === '[data-theme="light"]') {
    body = css.match(/:root,\s*\[data-theme="light"\]\s*\{([^}]+)\}/)?.[1]
  } else if (selector === '[data-theme="dark"]') {
    body = css.match(/(?:^|\n)\[data-theme="dark"\]\s*\{([^}]+)\}/m)?.[1]
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

  it('keeps shipped geometry tokens under [data-skin="default"]', () => {
    const tokens = blockTokens(css, '[data-skin="default"]')
    expect(tokens['--vy-radius-sm']).toBe('4px')
    expect(tokens['--vy-radius-md']).toBe('6px')
    expect(tokens['--vy-radius-lg']).toBe('8px')
    expect(tokens['--vy-radius-xl']).toBe('10px')
    expect(tokens['--vy-chrome-border-width']).toBe('1px')
    expect(tokens['--vy-font-sans']).toContain('Plus Jakarta Sans')
    expect(tokens['--vy-font-mono']).toContain('JetBrains Mono')
  })

  it('does not override palette in a [data-skin="default"][data-theme] block', () => {
    expect(css).not.toMatch(/\[data-skin="default"\]\[data-theme=/)
  })

  it('pins the Azure-tinted Default light palette in the base [data-theme="light"] block', () => {
    const tokens = blockTokens(css, '[data-theme="light"]')
    const expectToken = (name: string, value: string) =>
      expect((tokens[name] ?? '').toLowerCase()).toBe(value.toLowerCase())
    expectToken('--vy-bg', '#FFFFFF')
    expectToken('--vy-card', '#F7FAFC')
    expectToken('--vy-surface', '#EEF5F9')
    expectToken('--vy-surface-2', '#DCEAF2')
    expectToken('--vy-border', '#C9DCE8')
    expectToken('--vy-fg', '#17232B')
    expectToken('--vy-muted', '#4A5F6D')
    expectToken('--vy-accent', '#00638E')
  })

  it('pins the Azure-tinted Default dark palette in the base [data-theme="dark"] block', () => {
    const tokens = blockTokens(css, '[data-theme="dark"]')
    const expectToken = (name: string, value: string) =>
      expect((tokens[name] ?? '').toLowerCase()).toBe(value.toLowerCase())
    expectToken('--vy-bg', '#141414')
    expectToken('--vy-card', '#1A1E20')
    expectToken('--vy-surface', '#202528')
    expectToken('--vy-border', '#303A40')
    expectToken('--vy-fg', '#E8EDF0')
    expectToken('--vy-muted', '#9FB3BE')
    expectToken('--vy-accent', '#4FB3E8')
  })
})
