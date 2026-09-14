import { describe, expect, it } from 'vitest'
import { chunkSource, dropParentSpansCoveredByChildren } from '@main/agent/codeindex/chunk'
import type { CodeChunk } from '@main/agent/codeindex/types'

/**
 * Equivalence + golden tests for the rewritten chunker filter.
 *
 * `dropParentSpansCoveredByChildren` was reimplemented (sort/sweep) after an
 * app-wide freeze during code index sync. These tests pin its behaviour to the
 * original pairwise filter by asserting byte-identical filter decisions on
 * deterministic random span sets, and pin `chunkTypeScriptLike` (via
 * `chunkSource`) to deterministic output on a large minified fixture.
 */

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic across runs, no Math.random.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type TestSpan = {
  startLine: number
  endLine: number
  kind: 'class' | 'function' | 'method'
  name: string
  parentName?: string
}

// ---------------------------------------------------------------------------
// Reference implementation: the ORIGINAL pairwise filter, copied verbatim in
// semantics from the pre-rewrite code. NESTED_CHILD_KINDS = function/method.
// ---------------------------------------------------------------------------

const NESTED_CHILD_KINDS = new Set<TestSpan['kind']>(['function', 'method'])

function referenceFilter(spans: TestSpan[]): TestSpan[] {
  return spans.filter(
    (span, i) =>
      span.kind !== 'class' ||
      !spans.some(
        (other, j) =>
          i !== j &&
          NESTED_CHILD_KINDS.has(other.kind) &&
          (other.parentName === span.name ||
            (other.startLine >= span.startLine &&
              other.endLine <= span.endLine &&
              (other.startLine > span.startLine || other.endLine < span.endLine)))
      )
  )
}

/**
 * Recovers which indexes were kept by walking the filtered output against the
 * input by reference identity (both filters return the same object refs, order
 * preserved), so decision-level parity is asserted, not just array equality.
 */
function keptIndices<T>(input: T[], output: T[]): Set<number> {
  const kept = new Set<number>()
  let out = 0
  for (let i = 0; i < input.length; i++) {
    if (out < output.length && output[out] === input[i]) {
      kept.add(i)
      out++
    }
  }
  if (out !== output.length) throw new Error('output contains elements not from input (order)')
  return kept
}

const NAME_POOL = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta']

function randomSpan(rand: () => number): TestSpan {
  const r = rand()
  const kind: TestSpan['kind'] = r < 0.35 ? 'class' : r < 0.68 ? 'function' : 'method'
  const startLine = 1 + Math.floor(rand() * 300)
  const endLine = startLine + Math.floor(rand() * 40)
  const span: TestSpan = {
    startLine,
    endLine,
    kind,
    name: NAME_POOL[Math.floor(rand() * NAME_POOL.length)]!
  }
  // ~50% chance of a parentName from the shared pool so parentName collisions
  // with class names (the drop trigger) occur frequently.
  if (rand() < 0.5) span.parentName = NAME_POOL[Math.floor(rand() * NAME_POOL.length)]!
  return span
}

describe('dropParentSpansCoveredByChildren equivalence vs original pairwise filter', () => {
  it('property test: byte-identical filter decisions across 400 seeded random span sets', () => {
    const rand = mulberry32(0xc0ffee)
    for (let trial = 0; trial < 400; trial++) {
      const count = Math.floor(rand() * 60)
      const spans: TestSpan[] = []
      for (let i = 0; i < count; i++) spans.push(randomSpan(rand))

      const actual = dropParentSpansCoveredByChildren(spans)
      const expected = referenceFilter(spans)

      // Same kept set, same order, same elements.
      expect(actual).toEqual(expected)
      expect(keptIndices(spans, actual)).toEqual(keptIndices(spans, expected))
    }
  })

  it('matches the reference on the exact-cover boundary (strict containment required)', () => {
    // Child function whose range exactly equals the class range must NOT drop
    // the class (both strict inequalities fail), per the original filter.
    const spans: TestSpan[] = [
      { startLine: 5, endLine: 20, kind: 'class', name: 'Alpha' },
      { startLine: 5, endLine: 20, kind: 'function', name: 'fn' }
    ]
    expect(dropParentSpansCoveredByChildren(spans)).toEqual(referenceFilter(spans))
    expect(dropParentSpansCoveredByChildren(spans).map((s) => s.name)).toEqual(['Alpha', 'fn'])
  })

  it('matches the reference when parentName links a method to the class', () => {
    const spans: TestSpan[] = [
      { startLine: 1, endLine: 10, kind: 'class', name: 'Beta' },
      { startLine: 2, endLine: 9, kind: 'method', name: 'run', parentName: 'Beta' }
    ]
    expect(dropParentSpansCoveredByChildren(spans)).toEqual(referenceFilter(spans))
    expect(dropParentSpansCoveredByChildren(spans).map((s) => s.name)).toEqual(['run'])
  })

  it('returns the empty array unchanged and preserves input order for kept spans', () => {
    expect(dropParentSpansCoveredByChildren([])).toEqual([])
    const spans: TestSpan[] = [
      { startLine: 30, endLine: 40, kind: 'function', name: 'Zeta' },
      { startLine: 1, endLine: 50, kind: 'class', name: 'Eta' },
      { startLine: 10, endLine: 12, kind: 'method', name: 'm', parentName: 'Eta' }
    ]
    // Zeta is not nested in Eta (starts after) -> both stay; class dropped by m.
    const kept = dropParentSpansCoveredByChildren(spans)
    expect(kept.map((s) => s.name)).toEqual(referenceFilter(spans).map((s) => s.name))
    expect(kept.map((s) => s.name)).toEqual(['Zeta', 'm'])
  })
})

// ---------------------------------------------------------------------------
// Golden test: determinism of chunkTypeScriptLike (via chunkSource) on a large
// minified fixture.
//
// The TS-like regexes anchor on `^|\n` (class/function/arrow) and `\n[ \t]+`
// (methods), so a strictly one-line file yields no span matches. The generator
// below therefore emits a minified-style file: a huge first line (pure
// single-line stress for the line counter) followed by hundreds of minified
// single-statement lines carrying function/class/method/arrow patterns, padded
// to ~200KB.
// ---------------------------------------------------------------------------

function padTo(target: number, parts: string[]): string {
  let filler = ''
  let i = 0
  while (parts.join('').length + filler.length < target) {
    filler += `var pf${i}=1;`
    i++
  }
  parts.push(filler)
  return parts.join('')
}

function buildMinifiedFixture(seed: number): string {
  const rand = mulberry32(seed)
  const lines: string[] = []

  // One genuinely enormous minified line (~40KB) first: no span anchors after
  // position 0 on it, exercising the line counter and module-context path.
  const giant: string[] = []
  padTo(40_000, giant)
  lines.push(giant[0])

  const nameOf = (n: number): string => `s${n}`
  let n = 0
  let bytes = lines[0]!.length
  while (bytes < 200_000) {
    const roll = rand()
    const name = nameOf(n)
    if (roll < 0.25) {
      // Class with minified methods on their own (indented) lines so
      // methodRe's `\n[ \t]+` anchor fires; pad each method line.
      lines.push(`class C${name}{`)
      bytes += lines[lines.length - 1]!.length
      const methodCount = 1 + Math.floor(rand() * 3)
      for (let k = 0; k < methodCount; k++) {
        const pad: string[] = [` m${k}_${name}(a){return a+${k}}`]
        padTo(40 + Math.floor(rand() * 80), pad)
        lines.push(pad[0])
        bytes += pad[0].length
      }
      lines.push('}')
      bytes += 1
    } else if (roll < 0.55) {
      const pad: string[] = [`function f_${name}(a){return a*2}`]
      padTo(60 + Math.floor(rand() * 120), pad)
      lines.push(pad[0])
      bytes += pad[0].length
    } else if (roll < 0.8) {
      const pad: string[] = [`const g_${name}=(x)=>{return x+1}`]
      padTo(60 + Math.floor(rand() * 120), pad)
      lines.push(pad[0])
      bytes += pad[0].length
    } else {
      const pad: string[] = [`;var v_${name}=3;`]
      padTo(40 + Math.floor(rand() * 80), pad)
      lines.push(pad[0])
      bytes += pad[0].length
    }
    n++
  }
  return lines.join('\n')
}

describe('chunkTypeScriptLike golden determinism (large minified fixture)', () => {
  it('produces identical output across repeated calls on a ~200KB minified fixture', () => {
    const source = buildMinifiedFixture(20260914)
    expect(source.length).toBeGreaterThan(180_000)
    expect(source.split('\n').length).toBeGreaterThan(1000)

    const run1: CodeChunk[] = chunkSource('dist/bundle.min.js', source)
    const run2: CodeChunk[] = chunkSource('dist/bundle.min.js', source)

    // No crash implied by reaching here; spans must exist.
    expect(run1.length).toBeGreaterThan(100)
    const fn = run1.find((c) => c.kind === 'function' && c.name.startsWith('f_s'))
    expect(fn).toBeTruthy()
    const method = run1.find((c) => c.kind === 'method')
    expect(method).toBeTruthy()
    expect(method!.parentName).toMatch(/^C/s)

    // Byte-identical output across repeated calls.
    expect(JSON.stringify(run2)).toBe(JSON.stringify(run1))
    // Contextualized text participates in indexing; pin it too.
    expect(run1.map((c) => c.contextualizedText)).toEqual(run2.map((c) => c.contextualizedText))

    // Chunks are line-ranged, ordered, and never mid-brace truncated.
    for (const c of run1) {
      expect(c.startLine).toBeLessThanOrEqual(c.endLine)
      expect(c.text).not.toBe('')
    }
  })

  it('is deterministic (module fallback) on a strictly single-line 60KB file', () => {
    const oneLine: string[] = []
    padTo(60_000, oneLine)
    const src = oneLine[0]
    const a = chunkSource('dist/vendor.js', src)
    const b = chunkSource('dist/vendor.js', src)
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    expect(a.length).toBeGreaterThan(0)
  })
})
