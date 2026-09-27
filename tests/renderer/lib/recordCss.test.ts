import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '../../../src/renderer/src/styles.css'), 'utf8').replace(/\r\n/g, '\n')

/** The body of the first rule whose selector line is exactly `selector {`. */
function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  if (start < 0) throw new Error(`no rule for ${selector}`)
  return css.slice(start, css.indexOf('\n}', start))
}

/** Everything from the agent context card's comment to the next section. */
function agentContextBlock(): string {
  const start = css.indexOf('/* Agent context card')
  return css.slice(start, css.indexOf('/* ─────', start))
}

describe('agent context strip CSS', () => {
  it('is flat on the pane: no floating frame, radius or shadow', () => {
    const card = rule('.agent-context-card')
    expect(card).not.toMatch(/border-radius|box-shadow|background/)
  })

  it('uses named tokens and scale sizes, never invented opacities', () => {
    const block = agentContextBlock()
    expect(block).not.toContain('color-mix')
    expect(block).not.toMatch(/font-size:\s*[\d.]+rem/)
    expect(rule('.acc-label')).toContain('var(--text-caption)')
    expect(rule('.acc-label')).toContain('var(--vy-tracking-caps)')
  })

  it('shows keyboard focus on its one action', () => {
    expect(rule('.acc-action:focus-visible')).toContain('outline: 2px solid var(--vy-focus)')
  })
})

describe('markdown body CSS', () => {
  it('puts headings on the type scale', () => {
    const block = css.slice(css.indexOf('.markdown-body {'), css.indexOf('[data-plan-panel] .markdown-body {'))
    expect(block).toMatch(/h1 \{\n\s+font-size: var\(--text-title\)/)
    expect(block).toContain('font-size: var(--text-heading)')
    expect(block).toContain('font-size: var(--text-md)')
    expect(block).not.toContain('color-mix')
    expect(block).not.toContain('nth-child(even)')
  })

  it('drops the transcript rules nothing renders any more', () => {
    expect(css).not.toContain('[data-transcript-row]')
    expect(css).not.toContain('[data-user-prompt]')
    expect(css).not.toContain('.tool-status-morph')
  })
})
