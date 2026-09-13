import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))
vi.mock('@main/agent/codeindex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/codeindex')>()
  return {
    ...actual,
    queryIndexCandidates: async () => null,
    resolveCandidateFullPaths: () => []
  }
})

// One-shot re-read retry tests (audit M11) need the first read of the target
// file to return stale bytes while the re-read sees current disk content. The
// fs builtin namespace is frozen in ESM, so vi.spyOn cannot patch it — a hoisted
// module mock with a test-controlled route store is the repo pattern
// (ipcRegister.test.ts / gh.test.ts).
const { staleReadRoute } = vi.hoisted(() => ({
  staleReadRoute: {
    pathSuffix: null as string | null,
    stale: null as string | null,
    reads: 0
  }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readFileSync: (
      path: import('fs').PathLike,
      opts?: string | null
    ): string | ReturnType<typeof actual.readFileSync> => {
      if (
        staleReadRoute.pathSuffix != null &&
        typeof opts === 'string' &&
        String(path).replace(/\\/g, '/').endsWith(staleReadRoute.pathSuffix)
      ) {
        staleReadRoute.reads++
        // Non-null stale content serves exactly the first read; later reads
        // observe current disk bytes (the one-shot re-read semantics).
        const stale = staleReadRoute.stale
        staleReadRoute.stale = null
        if (stale != null) return stale
      }
      return actual.readFileSync(path, opts)
    }
  }
})

import { applyUnifiedDiff, toolEdit } from '@main/agent/tools/edit'
import { toolStrReplace, countOccurrences } from '@main/agent/tools/strReplace'
import { toolListDir } from '@main/agent/tools/listDir'
import { grepFilesForTest, toolGrep, GREP_DEFAULT_MAX_RESULTS } from '@main/agent/tools/grep'
import { toolDelete } from '@main/agent/tools/deletePath'
import { minimalDocx } from './helpers/minimalDocx'
import { toolApplyPatchAsync } from '@main/agent/tools/applyPatch'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-edittools-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('applyUnifiedDiff', () => {
  it('adds a line via a context diff', () => {
    const original = 'alpha\nbeta\ngamma\n'
    const diff = [
      '@@ -1,3 +1,4 @@',
      ' alpha',
      ' beta',
      '+inserted',
      ' gamma',
      ''
    ].join('\n')
    expect(applyUnifiedDiff(original, diff)).toBe('alpha\nbeta\ninserted\ngamma\n')
  })

  it('removes a line via a context diff', () => {
    const original = 'a\nb\nc\n'
    const diff = ['@@ -1,3 +1,2 @@', ' a', '-b', ' c', ''].join('\n')
    expect(applyUnifiedDiff(original, diff)).toBe('a\nc\n')
  })

  it('preserves CRLF in the original file', () => {
    const original = 'a\r\nb\r\nc\r\n'
    const diff = ['@@ -1,3 +1,4 @@', ' a', ' b', '+x', ' c', ''].join('\n')
    expect(applyUnifiedDiff(original, diff)).toBe('a\r\nb\r\nx\r\nc\r\n')
  })

  it('throws when there are no hunks', () => {
    expect(() => applyUnifiedDiff('hi', 'not a diff')).toThrow(/No unified-diff hunks/)
  })

  it('ignores the phantom blank context line from a trailing newline in the diff text', () => {
    // Regression: a diff string ending in '\n' was parsed as demanding a blank
    // context line after the hunk, failing every mid-file hunk with
    // "Diff hunk failed to match ... Expected: <line> \"\"".
    const diff = ['@@', '-old line', '+new line', ''].join('\n')
    expect(applyUnifiedDiff('start\nold line\nend\n', diff)).toBe('start\nnew line\nend\n')
  })

  it('still honors a real blank context line before the trailing newline', () => {
    const diff = ['@@', ' a', ' ', '-b', '+B', ''].join('\n')
    expect(applyUnifiedDiff('a\n\nb\n', diff)).toBe('a\n\nB\n')
  })

  it('keeps the explicit blank-removal EOF anchor working', () => {
    // ' -' as the last real hunk line (followed only by the '\n' terminator)
    // must still anchor at end-of-file, not be silently dropped.
    const diff = ['@@ -1,2 +1', ' a', '-', ''].join('\n')
    expect(applyUnifiedDiff('a\n\n', diff)).toBe('a\n')
  })

  it('reports a bare @@ hunk failure without a bogus line anchor and locates expected content', () => {
    const diff = ['@@', '-one', '-alphaX', '+ALPHA', ''].join('\n')
    try {
      applyUnifiedDiff('one\ntwo\nalpha\nthree\n', diff)
      expect.unreachable()
    } catch (err) {
      const message = (err as Error).message
      expect(message).toMatch(/bare @@ header declares no line/)
      expect(message).not.toMatch(/near line \d+/)
      expect(message).toContain('First expected line found at file line 1.')
    }
  })

  it('recovers a bare @@ hunk with stale context by anchoring on its removal lines (CRLF preserved)', () => {
    // Audit M11 logged failure shape: "Diff hunk failed to match
    // (context/removal mismatch); the bare @@ header declares no line." The
    // removals are intact in the file; only the model's context line drifted,
    // so the removal block anchors the edit and the file's real lines flow
    // through (stale context is neither trusted nor spliced).
    const original = [
      'import { readFileSync } from "fs"',
      'import { join } from "path"',
      '',
      'function loadConfig(root) {',
      '  const raw = readFileSync(join(root, "config.json"), "utf8")',
      '  return JSON.parse(raw)',
      '}',
      ''
    ].join('\r\n')
    const diff = [
      '@@',
      ' import { readFileSync } from "path"', // stale context — file says "fs"
      '-function loadConfig(root) {',
      '-  const raw = readFileSync(join(root, "config.json"), "utf8")',
      '-  return JSON.parse(raw)',
      '-}',
      '+export function loadConfig(root) {',
      '+  const raw = readFileSync(join(root, "config.json"), "utf8")',
      '+  return JSON.parse(raw)',
      '+}',
      ''
    ].join('\n')
    const next = applyUnifiedDiff(original, diff)
    expect(next).toBe(
      [
        'import { readFileSync } from "fs"',
        'import { join } from "path"',
        '',
        'export function loadConfig(root) {',
        '  const raw = readFileSync(join(root, "config.json"), "utf8")',
        '  return JSON.parse(raw)',
        '}',
        ''
      ].join('\r\n')
    )
  })

  it('keeps the bare @@ failure when the removal block is ambiguous or absent', () => {
    // Two identical target blocks → the removal-only anchor is ambiguous, so
    // the original bare-@@ mismatch error must surface untouched.
    const original = 'header\nfunction f() {\n  return 1\n}\nfunction f() {\n  return 1\n}\n'
    const ambiguous = [
      '@@',
      ' // stale comment the file does not have',
      '-function f() {',
      '-  return 1',
      '-}',
      '+function g() {',
      '+  return 1',
      '+}',
      ''
    ].join('\n')
    expect(() => applyUnifiedDiff(original, ambiguous)).toThrow(/bare @@ header declares no line/)

    // No removal lines at all → nothing to anchor on; failure preserved.
    const insertOnly = ['@@', ' // stale leading comment', '+inserted', ''].join('\n')
    expect(() => applyUnifiedDiff('alpha\nbeta\n', insertOnly)).toThrow(
      /bare @@ header declares no line/
    )
  })

  it('tells the model to regenerate when no expected line exists in the file', () => {
    const diff = ['@@ -1,2 +1,2 @@', ' header', '-gone', '+new', ''].join('\n')
    try {
      applyUnifiedDiff('one\ntwo\n', diff)
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).toMatch(/None of the expected context\/removal lines exist/)
    }
  })
})

describe('toolEdit', () => {
  it('creates a new file via contents', () => {
    const out = toolEdit(workspace, 'new.ts', 'console.log(1)\n')
    expect(out).toMatch(/Created/)
    expect(readFileSync(join(workspace, 'new.ts'), 'utf8')).toBe('console.log(1)\n')
  })

  it('writes over an existing file via contents', () => {
    writeFileSync(join(workspace, 'a.txt'), 'old\n', 'utf8')
    toolEdit(workspace, 'a.txt', 'new\n')
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('new\n')
  })

  it('applies a diff to an existing file', () => {
    writeFileSync(join(workspace, 'a.txt'), 'one\ntwo\n', 'utf8')
    const diff = ['@@ -1,2 +1,2 @@', ' one', '-two', '+2', ''].join('\n')
    toolEdit(workspace, 'a.txt', undefined, diff)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('one\n2\n')
  })

  it('recovers a context mismatch with a one-shot re-read retry when the file changed on disk', () => {
    // Audit M11 logged failure shape: "Diff hunk failed to match near line N
    // (context/removal mismatch)" because the in-memory copy was stale. The
    // first read returns the stale bytes; the one-shot re-read returns the
    // current disk content the hunk was actually written against.
    const stale = 'const a = 1\nconst b = 2\nconst c = 3\n'
    const fresh = 'const a = 1\nconst bb = 2\nconst c = 3\n'
    writeFileSync(join(workspace, 'a.ts'), fresh, 'utf8')
    const diff = ['@@ -1,3 +1,3 @@', ' const a = 1', '-const bb = 2', '+const b = 2', ''].join('\n')

    staleReadRoute.pathSuffix = '/a.ts'
    staleReadRoute.stale = stale

    try {
      expect(toolEdit(workspace, 'a.ts', undefined, diff)).toBe('Applied diff to a.ts')
      expect(staleReadRoute.reads).toBe(2)
      expect(readFileSync(join(workspace, 'a.ts'), 'utf8')).toBe(
        'const a = 1\nconst b = 2\nconst c = 3\n'
      )
    } finally {
      staleReadRoute.pathSuffix = null
      staleReadRoute.stale = null
      staleReadRoute.reads = 0
    }
  })

  it('still fails after the one-shot retry when the re-read bytes do not match either', () => {
    // Bounded behavior: mismatch → re-read → retry → still mismatch → the
    // original error surfaces and the file on disk is untouched. Exactly two
    // reads, never more.
    writeFileSync(join(workspace, 'a.ts'), 'const a = 1\nconst zz = 2\n', 'utf8')
    const diff = ['@@ -1,2 +1,2 @@', ' const a = 1', '-const bb = 2', '+const b = 2', ''].join('\n')

    staleReadRoute.pathSuffix = '/a.ts'
    staleReadRoute.stale = 'const a = 1\nconst yy = 2\n' // also cannot match

    try {
      try {
        toolEdit(workspace, 'a.ts', undefined, diff)
        expect.unreachable()
      } catch (err) {
        expect((err as Error).message).toMatch(/Diff hunk failed to match near line 1/)
        expect(staleReadRoute.reads).toBe(2)
      }
      expect(readFileSync(join(workspace, 'a.ts'), 'utf8')).toBe('const a = 1\nconst zz = 2\n')
    } finally {
      staleReadRoute.pathSuffix = null
      staleReadRoute.stale = null
      staleReadRoute.reads = 0
    }
  })

  it('refuses to overwrite a non-empty file with empty contents', () => {
    writeFileSync(join(workspace, 'a.txt'), 'x\n', 'utf8')
    expect(() => toolEdit(workspace, 'a.txt', '')).toThrow(/non-empty/)
  })

  it('refuses to write to a binary extension', () => {
    expect(() => toolEdit(workspace, 'model.bin', 'x')).toThrow(/binary/)
  })
})

describe('countOccurrences', () => {
  it('counts non-overlapping matches', () => {
    expect(countOccurrences('aaa', 'aa')).toBe(1)
    expect(countOccurrences('a a a', 'a')).toBe(3)
    expect(countOccurrences('abc', '')).toBe(0)
    expect(countOccurrences('miss', 'xyz')).toBe(0)
  })
})

describe('toolStrReplace', () => {
  it('replaces a single occurrence', () => {
    writeFileSync(join(workspace, 'a.txt'), 'foo bar foo\n', 'utf8')
    const out = toolStrReplace(workspace, 'a.txt', 'bar', 'baz')
    expect(out).toMatch(/1 occurrence/)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('foo baz foo\n')
  })

  it('replaces all occurrences with replace_all', () => {
    writeFileSync(join(workspace, 'a.txt'), 'foo foo foo\n', 'utf8')
    const out = toolStrReplace(workspace, 'a.txt', 'foo', 'bar', true)
    expect(out).toMatch(/3 occurrences/)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('bar bar bar\n')
  })

  it('throws when old_string is missing', () => {
    writeFileSync(join(workspace, 'a.txt'), 'abc\n', 'utf8')
    expect(() => toolStrReplace(workspace, 'a.txt', 'zzz', 'q')).toThrow(/not found/)
  })

  it('throws on multiple matches without replace_all', () => {
    writeFileSync(join(workspace, 'a.txt'), 'foo foo\n', 'utf8')
    expect(() => toolStrReplace(workspace, 'a.txt', 'foo', 'bar')).toThrow(
      /matched 2 times/
    )
  })

  it('normalizes CRLF on replacement', () => {
    writeFileSync(join(workspace, 'a.txt'), 'foo\r\nbar\r\n', 'utf8')
    toolStrReplace(workspace, 'a.txt', 'foo', 'baz')
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('baz\r\nbar\r\n')
  })
})

describe('toolListDir', () => {
  it('formats dirs and files with sizes', () => {
    mkdirSync(join(workspace, 'sub'))
    writeFileSync(join(workspace, 'one.txt'), '12345', 'utf8')
    const out = toolListDir(workspace, '.')
    expect(out).toContain('[dir]  sub/')
    expect(out).toContain('[file] one.txt (5B)')
  })

  it('skips IGNORED_DIRS entries', () => {
    mkdirSync(join(workspace, 'node_modules'))
    writeFileSync(join(workspace, 'node_modules', 'x.ts'), '1', 'utf8')
    writeFileSync(join(workspace, 'keep.ts'), '1', 'utf8')
    const out = toolListDir(workspace, '.')
    expect(out).not.toContain('node_modules')
    expect(out).toContain('keep.ts')
  })

  it('skips gitignored entries', () => {
    writeFileSync(join(workspace, '.gitignore'), 'secret.ts\n', 'utf8')
    writeFileSync(join(workspace, 'secret.ts'), '1', 'utf8')
    writeFileSync(join(workspace, 'visible.ts'), '1', 'utf8')
    const out = toolListDir(workspace, '.')
    expect(out).not.toContain('secret.ts')
    expect(out).toContain('visible.ts')
  })

  it('reports an empty directory', () => {
    mkdirSync(join(workspace, 'empty'))
    expect(toolListDir(workspace, 'empty')).toContain('empty is empty')
  })
})

describe('grepFilesForTest', () => {
  it('matches and formats hits', () => {
    writeFileSync(join(workspace, 'a.ts'), 'const x = 1\nconst y = 2\n', 'utf8')
    const out = grepFilesForTest(workspace, 'const', ['a.ts'])
    expect(out).toContain('a.ts:1: const x = 1')
    expect(out).toContain('a.ts:2: const y = 2')
  })

  it('honors context lines', () => {
    writeFileSync(join(workspace, 'a.ts'), 'a\nMATCH\nb\n', 'utf8')
    const out = grepFilesForTest(workspace, 'MATCH', ['a.ts'], { contextLines: 1 })
    expect(out).toContain('> 2| MATCH')
    expect(out).toContain(' 1| a')
    expect(out).toContain(' 3| b')
  })

  it('honors include glob', () => {
    writeFileSync(join(workspace, 'a.ts'), 'needle here\n', 'utf8')
    writeFileSync(join(workspace, 'b.md'), 'needle there\n', 'utf8')
    const out = grepFilesForTest(workspace, 'needle', ['a.ts', 'b.md'], {
      include: '*.ts'
    })
    expect(out).toContain('a.ts:1')
    expect(out).not.toContain('b.md')
  })

  it('truncates at maxResults', () => {
    writeFileSync(join(workspace, 'a.ts'), 'hit\nhit\nhit\n', 'utf8')
    const out = grepFilesForTest(workspace, 'hit', ['a.ts'], { maxResults: 2 })
    expect(out).toContain('… stopped at 2 matches')
  })

  it('greps extracted Word .docx text', () => {
    writeFileSync(join(workspace, 'notes.md.docx'), minimalDocx(['ArchDocxUniqueToken lives here']))
    const out = grepFilesForTest(workspace, 'ArchDocxUniqueToken', ['notes.md.docx'])
    expect(out).toContain('notes.md.docx:1')
    expect(out).toContain('ArchDocxUniqueToken')
  })

  it('treats ^ as the start of each line, not the start of the file', () => {
    writeFileSync(
      join(workspace, 'webFetch.ts'),
      'import { x } from "./y"\nexport function toolWebFetch() {}\n',
      'utf8'
    )
    const out = grepFilesForTest(workspace, '^export', ['webFetch.ts'])
    expect(out).toContain('webFetch.ts:2:')
    expect(out).toContain('export function toolWebFetch')
    expect(out).not.toMatch(/No matches/)
  })

  it('stops at the default 60-result cap with a truncation notice', () => {
    const lines = Array.from({ length: 70 }, (_, i) => `needle ${i + 1}`).join('\n')
    writeFileSync(join(workspace, 'cap.txt'), lines, 'utf8')
    const out = grepFilesForTest(workspace, 'needle', ['cap.txt'])
    const rows = out.split('\n')
    expect(rows).toHaveLength(GREP_DEFAULT_MAX_RESULTS + 1)
    expect(rows[0]).toContain('cap.txt:1:')
    expect(rows[GREP_DEFAULT_MAX_RESULTS - 1]).toContain(`cap.txt:${GREP_DEFAULT_MAX_RESULTS}:`)
    expect(rows[GREP_DEFAULT_MAX_RESULTS]).toBe(`… stopped at ${GREP_DEFAULT_MAX_RESULTS} matches`)
  })

  it('honours an explicit maxResults over the default cap', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `pin ${i + 1}`).join('\n')
    writeFileSync(join(workspace, 'pin.txt'), lines, 'utf8')
    const out = grepFilesForTest(workspace, 'pin', ['pin.txt'], { maxResults: 5 })
    expect(out).toContain('pin.txt:5:')
    expect(out).not.toContain('pin.txt:6:')
    expect(out).toContain('… stopped at 5 matches')
  })

  it('shows no truncation notice when hits are under the default cap', () => {
    writeFileSync(join(workspace, 'few.txt'), 'hit one\nhit two\nhit three\n', 'utf8')
    const out = grepFilesForTest(workspace, 'hit', ['few.txt'])
    expect(out).toContain('few.txt:3:')
    expect(out).not.toContain('stopped at')
  })
})

describe('toolGrep', () => {
  it('defaults to the 60-result cap when maxResults is omitted', async () => {
    const lines = Array.from({ length: 70 }, (_, i) => `capMarker ${i + 1}`).join('\n')
    writeFileSync(join(workspace, 'capMarker.txt'), lines, 'utf8')
    const out = await toolGrep(workspace, 'capMarker')
    expect(out).toContain(`… stopped at ${GREP_DEFAULT_MAX_RESULTS} matches`)
    expect(out).not.toContain('capMarker.txt:61:')
    expect(out).toContain('capMarker.txt:60:')
  })

  it('scans a real temp dir and formats hits', async () => {
    writeFileSync(join(workspace, 'a.ts'), 'alpha beta\n', 'utf8')
    writeFileSync(join(workspace, 'b.ts'), 'gamma\n', 'utf8')
    const out = await toolGrep(workspace, 'alpha')
    expect(out).toContain('a.ts:1: alpha beta')
    expect(out).toContain('index=live')
  })

  it('returns no-match notice', async () => {
    writeFileSync(join(workspace, 'a.ts'), 'zzz\n', 'utf8')
    const out = await toolGrep(workspace, 'nomatch123')
    expect(out).toContain('No matches')
  })

  it('live-greps Word .docx in a workspace walk', async () => {
    writeFileSync(join(workspace, 'notes.md.docx'), minimalDocx(['ArchDocxUniqueToken lives here']))
    const out = await toolGrep(workspace, 'ArchDocxUniqueToken')
    expect(out).toContain('notes.md.docx')
    expect(out).toContain('ArchDocxUniqueToken')
  })

  it('finds ^export on a later line when include is a single source file', async () => {
    writeFileSync(
      join(workspace, 'webFetch.ts'),
      'import { x } from "./y"\nexport function toolWebFetch() {}\n',
      'utf8'
    )
    const out = await toolGrep(workspace, '^export', { include: 'webFetch.ts', maxResults: 15 })
    expect(out).toContain('webFetch.ts:2:')
    expect(out).toContain('export function toolWebFetch')
    expect(out).not.toMatch(/No matches/)
  })
})

describe('toolDelete', () => {
  it('deletes a file', () => {
    writeFileSync(join(workspace, 'a.txt'), 'x', 'utf8')
    const out = toolDelete(workspace, 'a.txt')
    expect(out).toMatch(/Deleted/)
    expect(existsSync(join(workspace, 'a.txt'))).toBe(false)
  })

  it('deletes a directory recursively', () => {
    mkdirSync(join(workspace, 'dir', 'nested'), { recursive: true })
    writeFileSync(join(workspace, 'dir', 'nested', 'f.txt'), 'x', 'utf8')
    const out = toolDelete(workspace, 'dir', true)
    expect(out).toMatch(/Deleted directory/)
    expect(existsSync(join(workspace, 'dir'))).toBe(false)
  })

  it('refuses to delete a non-empty directory without recursive', () => {
    mkdirSync(join(workspace, 'dir'))
    writeFileSync(join(workspace, 'dir', 'f.txt'), 'x', 'utf8')
    expect(() => toolDelete(workspace, 'dir')).toThrow(/recursive=true/)
  })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

describe('toolApplyPatchAsync', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'vyotiq-patch-'))
    git(repo, ['init'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test'])
    git(repo, ['config', 'core.autocrlf', 'false'])
    git(repo, ['config', 'core.eol', 'lf'])
    writeFileSync(join(repo, 'file_a.txt'), 'hello\n', 'utf8')
    git(repo, ['add', 'file_a.txt'])
    git(repo, ['commit', '-m', 'init'])
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('applies a real generated diff', async () => {
    writeFileSync(join(repo, 'file_a.txt'), 'hello\nworld\n', 'utf8')
    const patch = git(repo, ['diff'])
    git(repo, ['checkout', 'file_a.txt'])
    expect(readFileSync(join(repo, 'file_a.txt'), 'utf8')).toBe('hello\n')

    const result = await toolApplyPatchAsync(
      repo,
      { patch },
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(repo, 'file_a.txt'), 'utf8')).toBe('hello\nworld\n')
  })

  it('supports check=true (dry run)', async () => {
    writeFileSync(join(repo, 'file_a.txt'), 'hello\nworld\n', 'utf8')
    const patch = git(repo, ['diff'])
    git(repo, ['checkout', 'file_a.txt'])

    const result = await toolApplyPatchAsync(
      repo,
      { patch, check: true },
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/applies cleanly/i)
    expect(readFileSync(join(repo, 'file_a.txt'), 'utf8')).toBe('hello\n')
  })

  it('fails on a non-matching patch', async () => {
    const patch = [
      'diff --git a/file_a.txt b/file_a.txt',
      '--- a/file_a.txt',
      '+++ b/file_a.txt',
      '@@ -1 +1 @@',
      '-does-not-match',
      '+x',
      ''
    ].join('\n')
    const result = await toolApplyPatchAsync(
      repo,
      { patch },
      new AbortController().signal
    )
    expect(result.ok).toBe(false)
  })

  it('requires a patch argument', async () => {
    const result = await toolApplyPatchAsync(repo, {}, new AbortController().signal)
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/patch is required/)
  })
})
