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

  it('matches light theme neutral palette via base [data-theme="light"]', () => {
    const tokens = blockTokens(css, '[data-theme="light"]')
    expect(tokens['--vy-bg']).toBe('var(--vy-gray-base)')
    expect(tokens['--vy-gray-base']).toBe('#ffffff')
    expect(tokens['--vy-gray-900']).toBe('#171717')
    expect(tokens['--vy-gray-600']).toBe('#525252')
    expect(tokens['--vy-muted']).toBe('var(--vy-gray-600)')
  })

  it('ships the Azure light accent in the base [data-theme="light"] block', () => {
    const tokens = blockTokens(css, '[data-theme="light"]')
    expect(tokens['--vy-accent']).toBe('#00638e')
    expect(tokens['--vy-accent-fg']).toBe('#ffffff')
    expect(tokens['--vy-accent-hover']).toBe('#004a6b')
    expect(tokens['--vy-focus']).toBe('#bfd8e3')
  })

  it('ships the Azure dark accent in the base [data-theme="dark"] block', () => {
    const tokens = blockTokens(css, '[data-theme="dark"]')
    expect(tokens['--vy-accent']).toBe('#4fb3e8')
    expect(tokens['--vy-accent-fg']).toBe('#0a0a0a')
    expect(tokens['--vy-accent-hover']).toBe('#8cb9cc')
    expect(tokens['--vy-focus']).toBe('#8cb9cc')
  })

  it('matches dark theme neutral palette via base [data-theme="dark"]', () => {
    const tokens = blockTokens(css, '[data-theme="dark"]')
    expect(tokens['--vy-gray-base']).toBe('#000000')
    expect(tokens['--vy-gray-900']).toBe('#f5f5f5')
    expect(tokens['--vy-gray-600']).toBe('#a3a3a3')
  })
})
