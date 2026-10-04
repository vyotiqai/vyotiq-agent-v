/**
 * @vitest-environment jsdom
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { MarkdownContent } from '@renderer/lib/ui'

afterEach(cleanup)

// jsdom here loads no stylesheet — vitest.config.ts runs environment 'node' with
// tests/setup.ts and nothing injects CSS — so getComputedStyle on a heading
// cannot resolve a font-size. This test locks the two halves of the contract
// separately and invents no measurement: the class the root carries (read from
// the rendered DOM) and the scale token each heading level reads in styles.css
// (read from source, resolved against the type scale's own declared px).

// Same idiom as tests/shared/defaultSkinBaseline.test.ts: vitest runs from the
// repo root, so resolve from cwd — import.meta.url is a Vite URL, not a file URL.
const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8').replace(
  /\r\n/g,
  '\n'
)

/** The `.markdown-body { … }` block only, comments included. */
function markdownBodyBlock(): string {
  const start = css.indexOf('.markdown-body {')
  expect(start).toBeGreaterThan(-1)
  const end = css.indexOf('\n}', start)
  return css.slice(start, end)
}

const rawBlock = markdownBodyBlock()

/** The same block with comments removed, so a comment can never read as a selector. */
const block = rawBlock.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Every nested rule as `selector → declarations`. A line walk, because a
 * selector list wraps across lines (`h1,\n  h2 {`). Later rules win, as in CSS.
 */
/**
 * Every rule as `selector → declarations`. Both capture groups exclude braces,
 * so a match can never span two rules; a selector list may wrap across lines.
 * A selector's declarations accumulate across the rules that name it, so
 * `ul` keeps the margin from `ul, ol` and the marker from its own rule.
 */
function rules(): Map<string, string> {
  const found = new Map<string, string>()
  for (const m of block.matchAll(/(?:^|\n)([^{}]+)\{([^{}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const key = part.trim().replace(/\s+/g, ' ')
      if (!key) continue
      found.set(key, [found.get(key), m[2].trim()].filter(Boolean).join('\n'))
    }
  }
  return found
}

const ruleMap = rules()

/** A rule's declarations, or a readable failure. */
function declsOf(selector: string): string {
  const found = ruleMap.get(selector)
  expect(found, `no rule for \`${selector}\` in .markdown-body`).toBeDefined()
  return found!
}

const ALL_LEVELS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']

/** The ink ramp, strongest first — heading ink steps down it as the level drops. */
const INK_RAMP = ['--vy-fg-strong', '--vy-fg', '--vy-secondary']

/** A heading level's `color: var(--…);` token. */
function headingInk(level: string): string {
  const match = declsOf(level).match(/color: var\((--[a-z0-9-]+)\);/)
  expect(match, `${level} has no ink colour of its own`).not.toBeNull()
  return match![1]
}

/** A heading level's position on INK_RAMP — lower is stronger. */
function inkStep(level: string): number {
  const ink = headingInk(level)
  const step = INK_RAMP.indexOf(ink)
  expect(step, `${level} uses ${ink}, which is not a step on the heading ink ramp`).toBeGreaterThanOrEqual(0)
  return step
}

/** The `--text-*` token a heading level reads, e.g. h4 → --text-sm. */
function headingToken(level: string): string {
  const match = declsOf(level).match(/font-size: var\((--[a-z0-9-]+)\);/)
  expect(match, `${level} has no scale-token font-size`).not.toBeNull()
  return match![1]
}

/** The type scale, resolved to the px its token declares. */
function scalePx(token: string): number {
  const match = css.match(new RegExp(`${token}: calc\\((\\d+)px`))
  expect(match, `${token} is not a scale token in styles.css`).not.toBeNull()
  return Number(match![1])
}

const MD = ['# One', '## Two', '### Three', '#### Four', '', 'Body paragraph.'].join('\n')

function renderMd(): HTMLElement {
  const { container } = render(createElement(MarkdownContent, { content: MD, size: 'md' }))
  return container as HTMLElement
}

describe('markdown-body root class contract', () => {
  it('carries exactly the md size and the relaxed line', () => {
    const root = renderMd().querySelector('.markdown-body')!
    expect(root.classList.contains('text-md')).toBe(true)
    expect(root.classList.contains('leading-relaxed')).toBe(true)
    // cn() does no merge, so nothing else may ride along.
    expect(root.classList.contains('text-sm')).toBe(false)
    expect(root.classList.contains('text-lg')).toBe(false)
  })
})

describe('markdown-body headings render one level per tag', () => {
  it('emits h1..h4 plus the body paragraph', () => {
    const container = renderMd()
    for (const tag of ['h1', 'h2', 'h3', 'h4']) {
      expect(container.querySelector(tag), tag).not.toBeNull()
    }
    expect(container.querySelector('p')).not.toBeNull()
  })
})

describe('.markdown-body heading scale', () => {
  const levels = ['h1', 'h2', 'h3', 'h4']

  it('gives h1..h4 four distinct, strictly descending steps', () => {
    const px = levels.map((level) => scalePx(headingToken(level)))
    for (let i = 1; i < px.length; i++) {
      expect(px[i], `${levels[i]} must be smaller than ${levels[i - 1]}`).toBeLessThan(px[i - 1])
    }
    expect(new Set(px).size).toBe(4)
  })

  it('keeps h4 below the body paragraph at size="md"', () => {
    expect(scalePx(headingToken('h4'))).toBeLessThan(scalePx('--text-md'))
  })

  it('drops h5/h6 to the caption step, one below h4', () => {
    expect(scalePx(headingToken('h5'))).toBeLessThan(scalePx(headingToken('h4')))
    expect(scalePx(headingToken('h6'))).toBe(scalePx(headingToken('h5')))
  })

  it('keeps the shared heading rule on all six levels', () => {
    // `ruleMap` accumulates, so each level carries the shared rule's declarations
    // plus its own size and ink. Ink is NOT shared — it steps down the ramp with
    // size, so that is asserted separately below.
    for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      const decls = declsOf(level)
      expect(decls, level).toContain('margin: var(--md-section) 0 var(--md-gap-tight);')
      expect(decls, level).toContain('font-weight: 600;')
      expect(decls, level).toContain('letter-spacing: var(--vy-tracking-tight);')
      expect(decls, level).toContain('line-height: 1.25;')
      expect(decls, level).not.toContain('font-size: 1em')
    }
  })

  it('steps heading ink strictly down the ramp, in token order', () => {
    // The contract is the ORDER of the ink, not three independent string hits:
    // h1/h2 take the top of the ramp, h3/h4 the body step, h5/h6 step back off
    // it. Asserting the ramp index per level catches a level that jumps the
    // queue (an h5 louder than an h3) as well as a token that is simply wrong.
    const steps = ALL_LEVELS.map((level) => inkStep(level))
    expect(steps).toEqual([0, 0, 1, 1, 2, 2])
    for (let i = 1; i < steps.length; i++) {
      expect(
        steps[i],
        `${ALL_LEVELS[i]} ink must not be stronger than ${ALL_LEVELS[i - 1]}`
      ).toBeGreaterThanOrEqual(steps[i - 1])
    }
    // Each step of the ramp is actually used, so the levels can't all sit at one.
    expect(new Set(steps).size).toBe(INK_RAMP.length)
  })
})

describe('.markdown-body emphasis', () => {
  it('makes bold weight-only: 600 with no colour of its own', () => {
    const decls = declsOf('strong')
    expect(decls).toContain('font-weight: 600;')
    // No colour here on purpose. The Result's body already sits at
    // --vy-fg-strong, so a colour on `strong` was a no-op there; anywhere else
    // it would jump a bold run to heading ink and pull the eye off the
    // sentence. Emphasis comes from weight plus the neighbours' contrast.
    expect(decls, 'bold must not declare its own colour').not.toMatch(/color\s*:/)
    expect(declsOf('b')).toBe(decls)
  })
})

describe('.markdown-body tables draw horizontal rules only', () => {
  const tableSelectors = [...ruleMap.keys()].filter(
    (selector) =>
      selector === 'table' ||
      selector === 'th' ||
      selector === 'td' ||
      selector.startsWith('tbody tr')
  )

  it('finds the table rules it is about to assert on', () => {
    expect(tableSelectors).toContain('table')
    expect(tableSelectors).toContain('th')
    expect(tableSelectors).toContain('td')
    expect(tableSelectors).toContain('tbody tr:not(:last-child) td')
  })

  it('draws no all-sides border and no vertical rule on any table rule', () => {
    // A 1px box per cell drew a lattice that fought the row rhythm and put
    // vertical lines through the columns. Alignment lines the columns up, so
    // the only borders left are horizontal rules.
    expect(tableSelectors.length).toBeGreaterThan(3)
    for (const selector of tableSelectors) {
      const decls = declsOf(selector)
      // `border:` all four sides — `border-collapse`/`border-top` are not it.
      expect(decls, `${selector} declares an all-sides border`).not.toMatch(
        /(?:^|[\s;])border\s*:/
      )
      expect(decls, `${selector} declares a vertical rule`).not.toMatch(/border-(?:left|right)\s*:/)
    }
  })

  it('keeps exactly the top, head and inter-row rules', () => {
    expect(declsOf('table')).toContain('border-top: 1px solid var(--vy-border);')
    expect(declsOf('th')).toContain('border-bottom: 1px solid var(--vy-border);')
    // One rule between rows, none under the last.
    expect(declsOf('tbody tr:not(:last-child) td')).toContain(
      'border-bottom: 1px solid var(--vy-border);'
    )
  })
})

describe('markdown inline-code chip carries no fill', () => {
  // Protects the chip from picking up a background again: with no surface
  // behind it there is nothing to deepen, and a fill would be a weight the
  // design system does not name on a control that is otherwise plain text —
  // hover is an underline. The chip still has to say "code" (font-mono) and to
  // keep its focus ring.
  const chip = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/lib/ui/MarkdownContent.tsx'),
    'utf8'
  ).replace(/\r\n/g, '\n')
  const codeBase = chip.match(/const CODE_BASE = '([^']*)'/)?.[1]
  const codeChipTemplate = chip.match(/const CODE_CHIP = `([^`]*)`/)?.[1]

  it('reads both class strings out of MarkdownContent.tsx', () => {
    expect(codeBase, 'CODE_BASE not found').toBeDefined()
    expect(codeChipTemplate, 'CODE_CHIP not found').toBeDefined()
  })

  it('declares no bg- class on the chip, base or full', () => {
    // CODE_CHIP is `${CODE_BASE} hover:underline …`, so resolve the template
    // against the base before looking for a fill.
    const classes = [codeBase!, codeChipTemplate!.replace('${CODE_BASE}', codeBase!)].join(' ')
    expect(classes).toMatch(/\bfont-mono\b/)
    expect(classes).toMatch(/\bfocus-visible:vy-focus-ring\b/)
    expect(classes, 'inline-code chip must carry no background fill').not.toMatch(
      /\bbg-(?!transparent)/
    )
  })
})

describe('.markdown-body vertical rhythm', () => {
  const tokens = ['--md-gap', '--md-gap-tight', '--md-section', '--md-nest']

  it('declares each spacing token once, inside the block', () => {
    for (const token of tokens) {
      const declared = css.match(new RegExp(`^  ${token}:`, 'gm')) ?? []
      expect(declared, `${token} declared ${declared.length}x in styles.css`).toHaveLength(1)
      expect(rawBlock, `${token} is not declared in .markdown-body`).toContain(`${token}:`)
    }
  })

  it('reads every vertical margin off a token', () => {
    // Vertical only: the checkbox's `margin-right` is a horizontal gap between
    // an inline box and the text beside it, not rhythm.
    const decls = block.match(/^\s*margin(?:-(?:top|bottom))?: [^;]*;$/gm) ?? []
    expect(decls.length).toBeGreaterThan(4)
    for (const decl of decls) {
      // `margin: 0` on img/table and the two first/last-child zeroes are not
      // rhythm steps; everything else must name one of the four tokens.
      const ok = /var\(--md-[a-z-]+\)/.test(decl) || /:\s*0;?$/.test(decl.trim())
      expect(ok, `literal vertical margin in .markdown-body: ${decl.trim()}`).toBe(true)
    }
  })

  it('keeps nested lists tighter than top-level ones', () => {
    expect(declsOf('li>ol')).toContain('margin: var(--md-nest) 0;')
    expect(declsOf('li>ul')).toContain('margin: var(--md-nest) 0;')
    expect(declsOf('li')).toContain('margin: var(--md-gap-tight) 0;')
    expect(declsOf('ul')).toContain('margin: var(--md-gap) 0;')
  })

  it('still zeroes the first and last child margins', () => {
    expect(rawBlock).toMatch(/&> :first-child \{\n\s*margin-top: 0;/)
    expect(rawBlock).toMatch(/&> :last-child \{\n\s*margin-bottom: 0;/)
  })
})

describe('.markdown-body constraints', () => {
  it('introduces no colour literal and no off-scale type size', () => {
    for (const decl of block.match(/font-size: [^;]+;/g) ?? []) {
      const ok = /var\(--text-[a-z0-9-]+\)/.test(decl) || /0\.\d+em/.test(decl)
      expect(ok, `off-scale font-size: ${decl}`).toBe(true)
    }
    expect(rawBlock).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(rawBlock).not.toMatch(/\brgba?\(/)
  })

  it('keeps the blockquote measure and the table density', () => {
    expect(declsOf('blockquote')).toContain('padding: 0.1em 0 0.1em 1rem;')
    expect(declsOf('blockquote')).toContain('border-left: 3px solid var(--vy-border);')
    expect(declsOf('td')).toContain('padding: 0.35em 0.65em;')
    expect(declsOf('th')).toContain('padding: 0.35em 0.65em;')
    expect(declsOf('table')).toContain('font-size: 0.92em;')
  })
})

describe('.record-prose keeps a reading measure', () => {
  // A measure that silently grows back to 100ch+ is what made the record's
  // prose an unreadable wall, so the cap is asserted in `ch` and held at 80 or
  // tighter — a px cap would drift with the type scale instead.
  const PROSE_ELEMENTS = ['p', 'ul', 'ol', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']
  const PROSE_SELECTOR = `.record-prose > :is(${PROSE_ELEMENTS.join(', ')})`
  // The rule sits beside the `.markdown-body` block, not inside it, so it is
  // read from the whole file rather than through `rules()`.
  const proseRule = css.match(/\n(\.record-prose > :is\([^)]*\))\s*\{([^}]*)\}/)

  it('caps the agent’s words at 80ch or tighter', () => {
    expect(proseRule, `${PROSE_SELECTOR} is not declared in styles.css`).not.toBeNull()
    expect(proseRule![1].replace(/\s+/g, ' '), 'the prose rule names a different element list').toBe(
      PROSE_SELECTOR
    )
    const maxWidth = proseRule![2].match(/(?:^|[\s;])max-width:\s*(\d+(?:\.\d+)?)ch\s*;/)
    expect(maxWidth, 'the prose measure must be a max-width in ch').not.toBeNull()
    expect(Number(maxWidth![1]), 'the prose measure must be 80ch or tighter').toBeLessThanOrEqual(80)
  })
})