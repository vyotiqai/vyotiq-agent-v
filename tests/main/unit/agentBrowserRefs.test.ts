import { describe, expect, it } from 'vitest'
import {
  formatInteractiveRefs,
  formatInteractiveRefsWithinBudget,
  parseBrowserTarget
} from '@main/app/agentBrowserRefs'

describe('parseBrowserTarget', () => {
  it('parses @eN and eN refs', () => {
    expect(parseBrowserTarget('@e12')).toEqual({ kind: 'ref', id: 'e12' })
    expect(parseBrowserTarget('e3')).toEqual({ kind: 'ref', id: 'e3' })
    expect(parseBrowserTarget(' @E7 ')).toEqual({ kind: 'ref', id: 'e7' })
  })

  it('treats CSS selectors as css', () => {
    expect(parseBrowserTarget('button.submit')).toEqual({
      kind: 'css',
      selector: 'button.submit'
    })
    expect(parseBrowserTarget('#login')).toEqual({ kind: 'css', selector: '#login' })
  })
})

describe('formatInteractiveRefs', () => {
  it('formats empty and populated lists', () => {
    expect(formatInteractiveRefs([])).toBe('(no interactive elements found)')
    expect(
      formatInteractiveRefs([
        { id: 'e1', selector: '#go', tag: 'BUTTON', role: 'button', name: 'Go' }
      ])
    ).toContain('@e1 role="button" name="Go"')
  })

  it('formats multi-word roles with named fields', () => {
    expect(
      formatInteractiveRefs([
        {
          id: 'e2',
          selector: '[role="menuitem"]',
          tag: 'DIV',
          role: 'menu item',
          name: 'Settings'
        }
      ])
    ).toContain('role="menu item"')
  })
})

describe('formatInteractiveRefsWithinBudget', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `e${i + 1}`,
    selector: `div:nth-of-type(${i + 1}) > a`,
    tag: 'A',
    role: 'link',
    name: `Result ${i + 1}`
  }))

  it('omits trailing refs when over budget', () => {
    const { text, included, omitted } = formatInteractiveRefsWithinBudget(many, 180)
    expect(included).toBeGreaterThan(0)
    expect(omitted).toBeGreaterThan(0)
    expect(included + omitted).toBe(many.length)
    expect(text).toMatch(/more interactive refs omitted/)
    expect(text).toContain('@e1')
  })

  it('includes all refs when budget is ample', () => {
    const { included, omitted, text } = formatInteractiveRefsWithinBudget(many, 50_000)
    expect(included).toBe(20)
    expect(omitted).toBe(0)
    expect(text).not.toMatch(/omitted/)
  })
})
