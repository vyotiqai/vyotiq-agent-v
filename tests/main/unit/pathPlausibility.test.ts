import { describe, expect, it } from 'vitest'
import {
  isConcreteWorkspacePath,
  isStrictWorkspaceFilePath,
  looksLikeWorkspacePath,
  normalizeWorkspaceFileRelPath,
  normalizeWorkspaceRelPath
} from '@main/agent/pathPlausibility'

/**
 * The divergence table. These two predicates used to be same-named copies in
 * `context/foldFacts.ts` and `loopPolicy.ts`; this table is why they are now
 * two differently-named functions in one module rather than one merged rule.
 *
 * `strict` = isStrictWorkspaceFilePath (compaction verification — a summary's
 * claimed path; admitting junk means accusing the summarizer of inventing a
 * path and discarding the fold).
 *
 * `loose` = looksLikeWorkspacePath (checkpoints / receipts / terminal scraping
 * — a tool arg or shell token; rejecting a real path means a run under-reports
 * what it touched and a checkpoint is not recorded).
 *
 * `norm` / `fileNorm` are the paired normalizers. They differ only on trailing
 * slashes, and that difference is load-bearing in both directions: `loose`
 * needs `docs/` to keep its slash (the only dir signal an extensionless token
 * has), and `strict` needs `src/a.ts/` to lose it (so identity comparison in
 * verifyCompaction matches `src/a.ts`).
 */
type Row = readonly [
  input: string,
  strict: boolean,
  loose: boolean,
  norm: string,
  fileNorm: string
]

const TABLE: readonly Row[] = [
  // --- both accept: ordinary workspace files -------------------------------
  ['src/cli/index.ts', true, true, 'src/cli/index.ts', 'src/cli/index.ts'],
  ['package.json', true, true, 'package.json', 'package.json'],
  ['.gitignore', true, true, '.gitignore', '.gitignore'],
  ['.cursor/rules/foo.mdc', true, true, '.cursor/rules/foo.mdc', '.cursor/rules/foo.mdc'],
  ['dist/bundle.js', true, true, 'dist/bundle.js', 'dist/bundle.js'],
  ['C:/tmp/x.ts', true, true, 'C:/tmp/x.ts', 'C:/tmp/x.ts'],
  ['src\\main\\agent\\loop.ts', true, true, 'src/main/agent/loop.ts', 'src/main/agent/loop.ts'],
  // Predicates agree, normalizers do not — see fileNorm.
  ['src/foo.ts/', true, true, 'src/foo.ts/', 'src/foo.ts'],

  // --- both reject ---------------------------------------------------------
  ['*.ts', false, false, '*.ts', '*.ts'],
  ['a,b.ts', false, false, 'a,b.ts', 'a,b.ts'],
  ['src/stores;', false, false, 'src/stores;', 'src/stores;'],
  ['src/a.ts)', false, false, 'src/a.ts)', 'src/a.ts)'],
  ['Makefile', false, false, 'Makefile', 'Makefile'],
  // Was the one input strict accepted and loose rejected: its basename carries
  // a source extension, but a PowerShell env path is not a workspace file.
  ['$env:TEMP/ext.ps1', false, false, '$env:TEMP/ext.ps1', '$env:TEMP/ext.ps1'],

  // --- they diverge: directories -------------------------------------------
  // loose must keep these (`mkdir src/stores` is a checkpoint-worthy write);
  // strict must drop them (`src/core` in a summary is a topic, not a claim).
  ['src/stores', false, true, 'src/stores', 'src/stores'],
  ['src/core', false, true, 'src/core', 'src/core'],
  ['src/main/agent', false, true, 'src/main/agent', 'src/main/agent'],
  ['src/core/llm/', false, true, 'src/core/llm/', 'src/core/llm'],
  ['docs/', false, true, 'docs/', 'docs'],

  // --- they diverge: model prose that is not a path ------------------------
  // Only strict ever sees these, and only strict needs to reject them.
  ['@modelcontextprotocol/sdk', false, true, '@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk'],
  ['e.g.', false, true, 'e.g.', 'e.g.'],
  ['GET /health', false, true, 'GET /health', 'GET /health'],
  ['--prompt/-p', false, true, '--prompt/-p', '--prompt/-p'],
  ['process.env', false, true, 'process.env', 'process.env'],
  ['src/core/telemetry.ts:28', false, true, 'src/core/telemetry.ts:28', 'src/core/telemetry.ts:28'],
  ['https://x.com', false, true, 'https://x.com', 'https://x.com'],
  ['src/x.unknownext', false, true, 'src/x.unknownext', 'src/x.unknownext'],
  ['foo bar/baz.ts', false, true, 'foo bar/baz.ts', 'foo bar/baz.ts'],
  ['/', false, true, '/', '/']
]

/**
 * How many of the table's inputs the two predicates answer differently.
 * Pinned so that "fixing" one copy into agreement with the other, or letting
 * them drift further apart, fails here and forces the module note to be read.
 */
const DIVERGENT_COUNT = 15

describe('workspace path plausibility table', () => {
  it.each(TABLE)(
    '%j -> strict=%s loose=%s',
    (input, strict, loose, norm, fileNorm) => {
      expect(isStrictWorkspaceFilePath(input)).toBe(strict)
      expect(looksLikeWorkspacePath(input)).toBe(loose)
      expect(normalizeWorkspaceRelPath(input)).toBe(norm)
      expect(normalizeWorkspaceFileRelPath(input)).toBe(fileNorm)
    }
  )

  it('diverges on exactly the rows the table records', () => {
    const divergent = TABLE.filter(([, strict, loose]) => strict !== loose)
    expect(divergent).toHaveLength(DIVERGENT_COUNT)
    // Measured, not asserted by hand: the predicates must actually disagree.
    for (const [input] of divergent) {
      expect(isStrictWorkspaceFilePath(input)).not.toBe(looksLikeWorkspacePath(input))
    }
  })

  it('is asymmetric — strict admits nothing loose rejects', () => {
    // Every divergence runs strict=false / loose=true. A row the other way
    // round means strict has a hole (as `$env:TEMP/ext.ps1` once did).
    for (const [input, strict, loose] of TABLE) {
      if (strict) expect(loose).toBe(true)
      expect(isStrictWorkspaceFilePath(input) && !looksLikeWorkspacePath(input)).toBe(false)
    }
  })

  it('normalizers differ only on trailing slashes', () => {
    for (const [input, , , norm, fileNorm] of TABLE) {
      expect(norm.replace(/(?<=.)\/+$/, '')).toBe(fileNorm)
      expect(normalizeWorkspaceRelPath(input)).toBe(norm)
    }
  })
})

describe('normalizeWorkspaceRelPath / normalizeWorkspaceFileRelPath', () => {
  it('trims and converts separators', () => {
    expect(normalizeWorkspaceRelPath('  src\\foo.ts  ')).toBe('src/foo.ts')
    expect(normalizeWorkspaceFileRelPath('  src\\foo.ts  ')).toBe('src/foo.ts')
  })

  it('keeps the root and empty input intact', () => {
    expect(normalizeWorkspaceFileRelPath('/')).toBe('/')
    expect(normalizeWorkspaceFileRelPath('')).toBe('')
    expect(normalizeWorkspaceFileRelPath('   ')).toBe('')
  })

  it('collapses repeated trailing slashes for file identity only', () => {
    expect(normalizeWorkspaceRelPath('src/a.ts///')).toBe('src/a.ts///')
    expect(normalizeWorkspaceFileRelPath('src/a.ts///')).toBe('src/a.ts')
  })
})

describe('isConcreteWorkspacePath', () => {
  it('rejects globs and relative stubs, accepts real paths', () => {
    expect(isConcreteWorkspacePath('src/a.ts')).toBe(true)
    expect(isConcreteWorkspacePath('src/**/*.ts')).toBe(false)
    expect(isConcreteWorkspacePath('src/{a,b}.ts')).toBe(false)
    expect(isConcreteWorkspacePath('.')).toBe(false)
    expect(isConcreteWorkspacePath('..')).toBe(false)
    expect(isConcreteWorkspacePath('')).toBe(false)
  })
})
