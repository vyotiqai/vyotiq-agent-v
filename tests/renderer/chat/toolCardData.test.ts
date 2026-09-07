import { describe, expect, it } from 'vitest'
import {
  collectWritingChanges,
  parseDiffPreview,
  parseEditCardData,
  parseTerminalCardData,
  formatTerminalHeaderTarget,
  parseUnifiedDiff
} from '@renderer/features/chat/toolUi'
import { countLines, splitLines, splitLinesTail } from '@renderer/features/chat/toolUi/parsers/common'
import { truncateMiddle } from '@shared/utils/displayPath'
import type { UiToolRow } from '@shared/transcript'

function tool(overrides: Partial<UiToolRow> & Pick<UiToolRow, 'name'>): UiToolRow {
  return {
    id: 't1',
    summary: '',
    status: 'done',
    ...overrides
  }
}

describe('parseTerminalCardData', () => {
  it('extracts command, output, stderr, shell, and exit code', () => {
    const data = parseTerminalCardData(
      tool({
        name: 'terminal',
        argsPreview: JSON.stringify({ command: 'npm run build' }),
        content: 'cwd: /ws\nshell: powershell\n\nbuild output\nstderr:\nerror line\nexit_code: 1'
      })
    )
    expect(data.command).toBe('npm run build')
    expect(data.exitCode).toBe(1)
    expect(data.cwd).toBe('/ws')
    expect(data.shell).toBe('powershell')
    expect(data.stderr).toContain('error line')
    expect(data.output).toContain('build output')
  })

  it('strips session headers and exposes sessionStatus', () => {
    const data = parseTerminalCardData(
      tool({
        name: 'terminal',
        argsPreview: JSON.stringify({ command: 'sleep 1', session_id: 's1' }),
        content:
          'session_id: s1\nstatus: running\ncommand: sleep 1\ncwd: /ws\nshell: powershell\n\nstill going\nexit_code: -1'
      })
    )
    expect(data.sessionStatus).toBe('running')
    expect(data.output).toBe('still going')
    expect(data.output).not.toMatch(/session_id|status:|command:/)
    expect(data.shell).toBe('powershell')
  })

  it('uses the session command header when args omit command', () => {
    const data = parseTerminalCardData(
      tool({
        name: 'terminal',
        summary: '593c6fe3-db0b-47f3-9885-0e035ee8f371',
        argsPreview: JSON.stringify({ session_id: '593c6fe3-db0b-47f3-9885-0e035ee8f371' }),
        content: [
          'session_id: 593c6fe3-db0b-47f3-9885-0e035ee8f371',
          'status: done',
          'command: npx ts-node src/index.ts',
          'cwd: /ws',
          'shell: powershell',
          '',
          'Error: Cannot find module',
          'exit_code: 1'
        ].join('\n')
      })
    )
    expect(data.command).toBe('npx ts-node src/index.ts')
    expect(data.command).not.toMatch(/593c6fe3/)
  })
})

describe('formatTerminalHeaderTarget', () => {
  it('uses the first command line and appends N+ for extra lines', () => {
    expect(
      formatTerminalHeaderTarget({
        command: 'Get-ChildItem\nfoo\nbar',
        shell: 'powershell'
      })
    ).toBe('Get-ChildItem, 2+')
  })

  it('falls back to shell when command is empty', () => {
    expect(formatTerminalHeaderTarget({ command: '', shell: 'powershell' }, 'summary')).toBe(
      'powershell'
    )
  })
})

describe('parseEditCardData', () => {
  it('reports added line count for whole-file writes', () => {
    const data = parseEditCardData(
      tool({
        name: 'edit',
        argsPreview: JSON.stringify({ path: 'src/foo.ts', contents: 'a\nb\nc\n' })
      })
    )
    expect(data.path).toBe('src/foo.ts')
    expect(data.changeLabel).toBe('+3')
  })

  it('attaches created action from a new-file edit result', () => {
    expect(
      collectWritingChanges(
        tool({
          name: 'edit',
          argsPreview: JSON.stringify({ path: 'src/foo.ts', contents: 'a\nb\nc\n' }),
          content: 'Created src/foo.ts (6 chars)'
        })
      )
    ).toEqual([{ path: 'src/foo.ts', added: 3, removed: 0, action: 'created' }])
    expect(
      collectWritingChanges(
        tool({
          name: 'edit',
          argsPreview: JSON.stringify({ path: 'src/foo.ts', contents: 'a\nb\nc\n' }),
          content: 'Wrote src/foo.ts (6 chars)'
        })
      )
    ).toEqual([{ path: 'src/foo.ts', added: 3, removed: 0, action: 'modified' }])
    expect(
      collectWritingChanges(
        tool({
          name: 'edit',
          argsPreview: JSON.stringify({ path: 'src/empty.ts', contents: '' }),
          content: 'Created src/empty.ts (0 chars)'
        })
      )
    ).toEqual([{ path: 'src/empty.ts', added: 0, removed: 0, action: 'created' }])
  })

  it('counts diff lines from unified diff args', () => {
    const diff = '--- a\n+++ b\n@@\n-old\n+new\n+line'
    const data = parseEditCardData(
      tool({
        name: 'edit',
        argsPreview: JSON.stringify({ path: 'x.ts', diff })
      })
    )
    expect(data.changeLabel).toBe('+2 -1')
    expect(data.added).toBe(2)
    expect(data.removed).toBe(1)
  })
  it('keeps path empty when streaming args have no path yet', () => {
    const data = parseEditCardData(
      tool({
        name: 'edit',
        status: 'running',
        summary: '',
        argsPreview: '{"diff":"@@'
      })
    )
    expect(data.path).toBe('')
    expect(data.iconPath).toBe('')
  })

  it('does not use the file placeholder when a failed edit has no path', () => {
    const data = parseEditCardData(
      tool({
        name: 'edit',
        status: 'fail',
        summary: '',
        argsPreview: '{}'
      })
    )
    expect(data.path).toBe('')
    expect(data.iconPath).toBe('')
  })

  it('counts str_replace old/new strings for the header totals', () => {
    const data = parseEditCardData(
      tool({
        name: 'str_replace',
        argsPreview: JSON.stringify({
          path: 'x.ts',
          old_string: 'old\nline',
          new_string: 'new'
        })
      })
    )
    expect(data.path).toBe('x.ts')
    expect(data.added).toBe(1)
    expect(data.removed).toBe(2)
    expect(data.changeLabel).toBe('+1 -2')
  })
})

describe('parseDiffPreview', () => {
  it('numbers lines against the file as it stands after the edit', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -10,3 +10,4 @@', ' keep', '-gone', '+added', ' tail'].join(
      '\n'
    )
    const lines = parseDiffPreview(
      tool({ name: 'edit', argsPreview: JSON.stringify({ path: 'x.ts', diff }) })
    )

    expect(lines.map((line) => [line.kind, line.text, line.lineNumber])).toEqual([
      ['context', 'keep', 10],
      ['del', 'gone', null],
      ['add', 'added', 11],
      ['context', 'tail', 12]
    ])
  })

  it('skips git header metadata in parseUnifiedDiff', () => {
    const diff = [
      'diff --git a/.cursor/rules/x.mdc b/.cursor/rules/x.mdc',
      'new file mode 100644',
      'index 0000000..abc1234',
      '--- /dev/null',
      '+++ b/.cursor/rules/x.mdc',
      '@@ -0,0 +1,2 @@',
      '+line one',
      '+line two'
    ].join('\n')
    const lines = parseUnifiedDiff(diff)
    expect(lines.map((line) => line.text)).toEqual(['line one', 'line two'])
    expect(lines.every((line) => line.kind === 'add')).toBe(true)
    expect(lines.some((line) => line.text.includes('diff --git'))).toBe(false)
    expect(lines.some((line) => line.text.includes('index '))).toBe(false)
  })

  it('stops parseUnifiedDiff after maxLines', () => {
    const diff = [
      '@@ -0,0 +1,5 @@',
      '+one',
      '+two',
      '+three',
      '+four',
      '+five'
    ].join('\n')
    const lines = parseUnifiedDiff(diff, 2)
    expect(lines.map((line) => line.text)).toEqual(['one', 'two'])
  })

  it('separates hunks so distant edits do not read as adjacent', () => {
    const diff = ['@@ -1,1 +1,1 @@', '+first', '@@ -50,1 +50,1 @@', '+later'].join('\n')
    const kinds = parseDiffPreview(
      tool({ name: 'edit', argsPreview: JSON.stringify({ diff }) })
    ).map((line) => line.kind)

    expect(kinds).toEqual(['add', 'gap', 'add'])
  })

  it('accepts bare @@ hunk headers without emitting @@ as context (T1)', () => {
    const diff = [
      '@@',
      '-  <script src="js/audio.js"></script>',
      '+  <script src="js/setup.js"></script>',
      '+  <script src="js/audio.js"></script>'
    ].join('\n')
    const lines = parseUnifiedDiff(diff)
    expect(lines.some((line) => line.text === '@@')).toBe(false)
    expect(lines.map((line) => [line.kind, line.text, line.lineNumber])).toEqual([
      ['del', '  <script src="js/audio.js"></script>', null],
      ['add', '  <script src="js/setup.js"></script>', 1],
      ['add', '  <script src="js/audio.js"></script>', 2]
    ])
  })

  it('treats whole-file contents as an addition from line one', () => {
    const lines = parseDiffPreview(
      tool({ name: 'edit', argsPreview: JSON.stringify({ path: 'n.ts', contents: 'a\nb\n' }) })
    )

    expect(lines).toEqual([
      { kind: 'add', text: 'a', lineNumber: 1 },
      { kind: 'add', text: 'b', lineNumber: 2 }
    ])
  })

  it('returns nothing when the arguments never arrived', () => {
    expect(parseDiffPreview(tool({ name: 'edit' }))).toEqual([])
  })

  it('streams live diff lines from incomplete argsPreview JSON', () => {
    const incomplete = '{"path":"src/live.ts","diff":"@@\\n-old line\\n+new line'
    const lines = parseDiffPreview(
      tool({ name: 'edit', status: 'running', argsPreview: incomplete })
    )
    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ['del', 'old line'],
      ['add', 'new line']
    ])
    const card = parseEditCardData(
      tool({ name: 'edit', status: 'running', argsPreview: incomplete, summary: '' })
    )
    expect(card.path).toBe('src/live.ts')
    expect(card.iconPath).toBe('src/live.ts')
    expect(card.added).toBe(1)
    expect(card.removed).toBe(1)
  })

  it('grows parseDiffPreview as argsPreview chunks arrive', () => {
    const full = JSON.stringify({
      path: 'grow.ts',
      diff: ['@@', '-a', '+b', '+c', '+d'].join('\n')
    })
    // Cut inside the JSON-encoded diff string so JSON.parse fails until the end.
    const cuts = [30, 40, 50, 60, 70].filter((c) => c < full.length).concat([full.length])
    let prev = 0
    for (const cut of cuts) {
      const preview = full.slice(0, cut)
      const lines = parseDiffPreview(
        tool({ name: 'edit', status: 'running', argsPreview: preview })
      )
      expect(lines.length).toBeGreaterThanOrEqual(prev)
      prev = lines.length
    }
    expect(prev).toBeGreaterThanOrEqual(3)
  })

  it('does not invent diff lines from path-only or hunk-header-only args', () => {
    expect(
      parseDiffPreview(
        tool({ name: 'edit', status: 'running', argsPreview: '{"path":"a.ts","diff":"@@' })
      )
    ).toEqual([])
    expect(
      parseDiffPreview(tool({ name: 'edit', status: 'running', argsPreview: '{"path":"a.ts","di' }))
    ).toEqual([])
    expect(parseDiffPreview(tool({ name: 'edit', status: 'running', argsPreview: '{' }))).toEqual([])
    expect(parseDiffPreview(tool({ name: 'edit', status: 'running', argsPreview: '' }))).toEqual([])
  })

  it('parseDiffPreview fromEnd keeps only the peek tail of a large contents write', () => {
    const contents = Array.from({ length: 80 }, (_, index) => `L${index + 1}`).join('\n')
    const lines = parseDiffPreview(
      tool({
        name: 'edit',
        status: 'running',
        argsPreview: JSON.stringify({ path: 'a.ts', contents })
      }),
      { maxLines: 14, fromEnd: true }
    )
    expect(lines).toHaveLength(14)
    expect(lines[0]?.text).toBe('L67')
    expect(lines[13]?.text).toBe('L80')
    expect(lines.every((line) => line.rowKey)).toBe(true)
  })

  it('keeps stable rowKey for contents lines as the tail window slides', () => {
    const first = Array.from({ length: 16 }, (_, index) => `L${index + 1}`).join('\n')
    const next = `${first}\nL17`
    const before = parseDiffPreview(
      tool({
        name: 'edit',
        status: 'running',
        argsPreview: JSON.stringify({ path: 'a.ts', contents: first })
      }),
      { maxLines: 14, fromEnd: true }
    )
    const after = parseDiffPreview(
      tool({
        name: 'edit',
        status: 'running',
        argsPreview: JSON.stringify({ path: 'a.ts', contents: next })
      }),
      { maxLines: 14, fromEnd: true }
    )
    expect(before.map((line) => line.rowKey).slice(1)).toEqual(
      after.map((line) => line.rowKey).slice(0, 13)
    )
  })
})

describe('splitLinesTail', () => {
  it('returns the last n spans with stable start offsets', () => {
    expect(splitLinesTail('a\nb\nc\nd\ne', 3)).toEqual([
      { text: 'c', start: 4 },
      { text: 'd', start: 6 },
      { text: 'e', start: 8 }
    ])
  })

  it('drops a trailing newline the same way splitLines does', () => {
    expect(splitLinesTail('a\nb\nc\n', 2).map((span) => span.text)).toEqual(['b', 'c'])
    expect(splitLines('a\nb\nc\n')).toEqual(['a', 'b', 'c'])
  })
})

describe('countLines', () => {
  it('matches splitLines length without allocating the full array', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('hello')).toBe(1)
    expect(countLines('hello\n')).toBe(1)
    expect(countLines('a\nb\nc')).toBe(3)
    expect(countLines('a\nb\nc\n')).toBe(3)
  })
})

describe('truncateMiddle', () => {
  it('cuts at a separator instead of fusing two commands into one', () => {
    // The old head+tail slice produced `Get-ChildItem -P…D 7720`, which reads
    // as a single invented command made of two unrelated fragments.
    const out = truncateMiddle('Get-ChildItem -Path out; taskkill /PID 7720 /T /F', 30)
    expect(out).toContain(' … ')
    const [head, tail] = out.split(' … ')
    expect(head.endsWith(' ')).toBe(false)
    expect(tail.startsWith(' ')).toBe(false)
    // Each half must be a whole token, never a mid-identifier fragment.
    expect(out).not.toMatch(/[A-Za-z]…[A-Za-z]/)
  })

  it('leaves short text untouched', () => {
    expect(truncateMiddle('pnpm test', 56)).toBe('pnpm test')
  })
})

describe('command header labels', () => {
  it('cuts at a pipeline separator rather than mid-token', () => {
    const command = 'pnpm exec vitest run tests/renderer 2>&1 | Select-Object -Last 8'
    const label = formatTerminalHeaderTarget({ command, shell: 'powershell' })
    expect(label.length).toBeLessThanOrEqual(60)
    expect(label).toMatch(/…$/)
  })
})
