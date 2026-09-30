import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs'
import { EventEmitter } from 'events'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  execPackageCommand,
  hasJavaScriptProject,
  hasTypeScriptProject,
  isSolutionStyleTsconfig,
  parseDiagnosticLines,
  parseEslintJsonDiagnostics,
  resolveDiagnosticsCommand,
  runSafeCommand,
  MAX_STREAM_BYTES,
  toolDiagnosticsAsync
} from '../../../src/main/agent/tools/diagnostics'

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({})
}))

/** A child stdio pipe that records how many times the settle path destroys it. */
function makeFakeStream(): EventEmitter & { destroyCount: number; destroy: () => void } {
  const stream = new EventEmitter() as EventEmitter & {
    destroyCount: number
    destroy: () => void
  }
  stream.destroyCount = 0
  stream.destroy = (): void => {
    stream.destroyCount += 1
  }
  return stream
}

describe('parseDiagnosticLines', () => {
  it('parses tsc-style diagnostics', () => {
    const text = [
      "src/app.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      'src/b.ts(1,1): warning TS6133: unused.'
    ].join('\n')
    const items = parseDiagnosticLines(text)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      file: 'src/app.ts',
      line: 10,
      col: 5,
      severity: 'error'
    })
    expect(items[0]!.message).toContain("Type 'string'")
  })

  it('parses eslint unix-style paths', () => {
    const items = parseDiagnosticLines('src/x.ts:3:7: error Missing semicolon')
    expect(items[0]).toMatchObject({
      file: 'src/x.ts',
      line: 3,
      col: 7,
      severity: 'error',
      message: 'Missing semicolon'
    })
  })

  it('parses eslint --format json output', () => {
    const text = JSON.stringify([
      {
        filePath: 'C:\\proj\\src\\a.ts',
        messages: [
          {
            line: 4,
            column: 2,
            severity: 2,
            message: "'x' is never reassigned",
            ruleId: 'prefer-const'
          },
          {
            line: 9,
            column: 1,
            severity: 1,
            message: 'Unexpected console',
            ruleId: 'no-console'
          }
        ]
      }
    ])
    const items = parseEslintJsonDiagnostics(text)
    expect(items).toHaveLength(2)
    expect(items![0]).toMatchObject({
      file: 'C:\\proj\\src\\a.ts',
      line: 4,
      col: 2,
      severity: 'error',
      message: "'x' is never reassigned (prefer-const)"
    })
    expect(items![1]).toMatchObject({
      severity: 'warning',
      message: 'Unexpected console (no-console)'
    })
    expect(parseDiagnosticLines(`npm warn noise\n${text}`)).toHaveLength(2)
  })

  // stdout and stderr arrive joined; a bracket on stderr broke the slice.
  it('finds the eslint JSON line past brackets in other output', () => {
    const json = JSON.stringify([
      { filePath: 'C:\\p\\a.js', messages: [{ line: 1, column: 7, severity: 2, message: "'x' is unused", ruleId: 'no-unused-vars' }] }
    ])
    expect(parseDiagnosticLines(`${json}\nnpm warn [deprecated] something`)).toEqual([
      { file: 'C:\\p\\a.js', line: 1, col: 7, severity: 'error', message: "'x' is unused (no-unused-vars)" }
    ])
  })

  it("reads this tool's own emitted lines back without a stray colon", () => {
    expect(parseDiagnosticLines("src/a.ts:1:7: error: Type 'string' is not assignable")).toEqual([
      { file: 'src/a.ts', line: 1, col: 7, severity: 'error', message: "Type 'string' is not assignable" }
    ])
  })

  it('parses eslint stylish output, the default for project lint scripts', () => {
    const text = [
      '> lint',
      '> eslint .',
      '',
      'C:\\p\\src\\a.js',
      "  1:7  error    'x' is assigned a value but never used  no-unused-vars",
      '  4:1  warning  Unexpected console statement            no-console',
      '',
      '✖ 2 problems (1 error, 1 warning)'
    ].join('\n')
    expect(parseDiagnosticLines(text)).toEqual([
      { file: 'C:\\p\\src\\a.js', line: 1, col: 7, severity: 'error', message: "'x' is assigned a value but never used (no-unused-vars)" },
      { file: 'C:\\p\\src\\a.js', line: 4, col: 1, severity: 'warning', message: 'Unexpected console statement (no-console)' }
    ])
  })

  it('parses rustc errors located by their --> line', () => {
    const text = [
      'error[E0308]: mismatched types',
      ' --> src\\main.rs:1:25',
      '  |',
      '1 | fn main() { let x: i32 = "a"; }',
      '',
      'error: aborting due to 1 previous error'
    ].join('\n')
    expect(parseDiagnosticLines(text)).toEqual([
      { file: 'src\\main.rs', line: 1, col: 25, severity: 'error', message: 'mismatched types' }
    ])
  })

  it('parses mypy lines, which carry no column', () => {
    expect(parseDiagnosticLines('main.py:3: error: Incompatible types in assignment\nmain.py:5: note: See docs')).toEqual([
      { file: 'main.py', line: 3, col: 1, severity: 'error', message: 'Incompatible types in assignment' },
      { file: 'main.py', line: 5, col: 1, severity: 'info', message: 'See docs' }
    ])
  })

  it('parses a Python syntax error', () => {
    const text = '  File "main.py", line 1\n    def f(:\n          ^\nSyntaxError: invalid syntax'
    expect(parseDiagnosticLines(text)).toEqual([
      { file: 'main.py', line: 1, col: 1, severity: 'error', message: 'SyntaxError: invalid syntax' }
    ])
  })

  it('does not read ordinary text with colons as an error', () => {
    // Parsed as an error in file "build finished at 12", this failed a clean run.
    expect(parseDiagnosticLines('build finished at 12:34:56: ok')).toEqual([])
    expect(parseDiagnosticLines('> vyotiq@1.0.0 lint\n> eslint src/\n\nDone in 3.2s')).toEqual([])
  })

  it('still parses go vet output', () => {
    expect(parseDiagnosticLines('./main.go:5:2: undefined: foo')).toEqual([
      { file: './main.go', line: 5, col: 2, severity: 'error', message: 'undefined: foo' }
    ])
  })
})

describe('solution-style tsconfig', () => {
  let dir: string
  beforeEach(() => {
    dir = join(tmpdir(), `vyotiq-solution-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // `tsc --noEmit` on `"files": []` + references checks zero files and exits 0.
  it('typechecks through the references with tsc -b', () => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      '{\n  // Vite template\n  "files": [],\n  "references": [{ "path": "./tsconfig.app.json" }]\n}\n'
    )
    expect(isSolutionStyleTsconfig(dir)).toBe(true)
    expect(resolveDiagnosticsCommand(dir, 'typecheck', null)).toBe('npm exec --no -- tsc -b --noEmit --pretty false')
  })

  it('keeps plain tsc --noEmit for an ordinary config', () => {
    writeFileSync(join(dir, 'tsconfig.json'), '{ "include": ["src"], "references": [{ "path": "./b" }], "files": [] }')
    expect(isSolutionStyleTsconfig(dir)).toBe(false)
    writeFileSync(join(dir, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }')
    expect(resolveDiagnosticsCommand(dir, 'typecheck', null)).toBe('npm exec --no -- tsc --noEmit --pretty false')
  })
})

describe('execPackageCommand', () => {
  it('inserts -- for npm so flags are not swallowed as npm config', () => {
    expect(execPackageCommand('npm', 'eslint', '. --format json')).toBe(
      'npm exec --no -- eslint . --format json'
    )
    expect(execPackageCommand('npm', 'tsc', '--noEmit --pretty false')).toBe(
      'npm exec --no -- tsc --noEmit --pretty false'
    )
  })

  it('keeps pnpm exec without --', () => {
    expect(execPackageCommand('pnpm', 'eslint', '. --format json')).toBe(
      'pnpm exec eslint . --format json'
    )
  })
})

describe('hasTypeScriptProject / typecheck skip', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-diag-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('is false for empty workspace and true when tsconfig exists', () => {
    expect(hasTypeScriptProject(workspace)).toBe(false)
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'x' }))
    expect(hasTypeScriptProject(workspace)).toBe(false)
    writeFileSync(join(workspace, 'tsconfig.json'), '{}')
    expect(hasTypeScriptProject(workspace)).toBe(true)
  })

  it('skips typecheck with ok when no TypeScript project (live 81cee96f)', async () => {
    const result = await toolDiagnosticsAsync(
      workspace,
      'typecheck',
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('typecheck skipped')
  })
})

describe('hasJavaScriptProject / lint skip', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-diag-js-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('is false for Python-only workspace and true with package.json', () => {
    writeFileSync(join(workspace, 'main.py'), 'print("hi")\n')
    writeFileSync(join(workspace, 'requirements.txt'), 'requests==2.0.0\n')
    expect(hasJavaScriptProject(workspace)).toBe(false)
    expect(hasTypeScriptProject(workspace)).toBe(false)
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'x' }))
    expect(hasJavaScriptProject(workspace)).toBe(true)
  })

  it('is true when eslint config exists without package.json', () => {
    writeFileSync(join(workspace, 'eslint.config.js'), 'export default []\n')
    expect(hasJavaScriptProject(workspace)).toBe(true)
  })

  it('skips lint with ok on Python-only workspace', async () => {
    writeFileSync(join(workspace, 'main.py'), 'print("hi")\n')
    const result = await toolDiagnosticsAsync(
      workspace,
      'lint',
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('lint skipped')
  })
})

describe('runSafeCommand stream cap', () => {
  it('caps captured stdout with a truncation marker and preserves the tail', async () => {
    // Generate the payload at runtime — a half-megabyte argv would exceed the
    // OS argument limit (spawn ENAMETOOLONG).
    const tail = 'TAIL-MARKER-END'
    const res = await runSafeCommand(
      'node',
      ['-e', `process.stdout.write('x' + 'y'.repeat(${MAX_STREAM_BYTES + 100_000}) + ${JSON.stringify(tail)})`],
      { cwd: tmpdir(), env: process.env }
    )
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain('earlier output truncated')
    expect(res.stdout.length).toBeLessThanOrEqual(MAX_STREAM_BYTES + 256)
    expect(res.stdout.endsWith(tail)).toBe(true)
  }, 30_000)

  it('leaves small outputs untouched', async () => {
    const res = await runSafeCommand('node', ['-e', "process.stdout.write('small')"], {
      cwd: tmpdir(),
      env: process.env
    })
    expect(res.stdout).toBe('small')
    expect(res.stdout).not.toContain('earlier output truncated')
  }, 30_000)
})

/**
 * Regression cover for the killProcessTree + settle path: a child that has to
 * be killed must still resolve the promise exactly once with `killed: true`,
 * and the 5 s settle fallback must work for a process that survives the kill
 * signal. Timing and semantics are unchanged — these tests only pin them.
 */
describe('runSafeCommand kill + settle', () => {
  it('settles a timed-out child once and reports killed', async () => {
    const script = "process.stdout.write('partial diagnostics\\n'); setInterval(() => {}, 1000)"
    const controller = new AbortController()
    const res = await runSafeCommand('node', ['-e', script], {
      cwd: tmpdir(),
      env: process.env,
      signal: controller.signal,
      timeoutMs: 200
    })
    expect(res.killed).toBe(true)
    // Output captured before the kill is kept, and the run is reported as
    // killed rather than as a clean exit.
    expect(res.stdout).toContain('partial diagnostics')
    // A second kill trigger after settling must change nothing.
    controller.abort()
    expect(res.killed).toBe(true)
  }, 30_000)

  it('settles through the kill path when the process ignores SIGTERM', async () => {
    // tree-kill signals the tree; a handler that swallows SIGTERM (POSIX) or
    // taskkill (Windows) still leaves the pipes open, so only the settle
    // fallback can resolve this. `close` never fires on its own here.
    const pidFile = join(
      tmpdir(),
      `vyotiq-diag-stubborn-${process.pid}-${Date.now()}.pid`
    )
    const script = [
      "require('fs').writeFileSync(" + JSON.stringify(pidFile) + ', String(process.pid))',
      "process.on('SIGTERM', () => {})",
      'setInterval(() => {}, 1000)'
    ].join(';')
    try {
      const res = await runSafeCommand('node', ['-e', script], {
        cwd: tmpdir(),
        env: process.env,
        timeoutMs: 200
      })
      expect(res.killed).toBe(true)
      // Settled by the timer with a null exit code — never a fake clean exit.
      expect(res.exitCode == null || res.exitCode !== 0).toBe(true)
    } finally {
      // The stub may have survived the kill on POSIX; never leak it.
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8').trim())
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // already gone
          }
        }
        rmSync(pidFile, { force: true })
      }
    }
  }, 30_000)

  it('destroys the pipes at most once when the settle fallback fires', async () => {
    vi.useFakeTimers()
    try {
      vi.resetModules()
      const stdout = makeFakeStream()
      const stderr = makeFakeStream()
      const child = Object.assign(new EventEmitter(), {
        pid: undefined, // no pid -> the SIGTERM branch, no real process tree
        stdout,
        stderr,
        kill: vi.fn()
      })
      const spawnMock = vi.fn(() => child)
      vi.doMock('cross-spawn', () => ({ default: spawnMock }))
      const { runSafeCommand: runMocked } = await import(
        '../../../src/main/agent/tools/diagnostics'
      )

      let settlements = 0
      const pending = runMocked('tsc', ['--noEmit'], {
        cwd: tmpdir(),
        env: process.env,
        timeoutMs: 100
      }).then((r) => {
        settlements += 1
        return r
      })

      await vi.advanceTimersByTimeAsync(5_500) // timeout kill + KILL_SETTLE_MS
      // The descendant keeps the pipes open: no `close` event was emitted.
      expect(settlements).toBe(1)
      expect(stdout.destroyCount).toBe(1)
      expect(stderr.destroyCount).toBe(1)

      // A late `close` must not settle a second time or destroy again.
      child.emit('close', 0)
      await vi.advanceTimersByTimeAsync(10)
      expect(settlements).toBe(1)
      expect(stdout.destroyCount).toBe(1)
      expect(stderr.destroyCount).toBe(1)

      const res = await pending
      expect(res.killed).toBe(true)
      expect(res.exitCode).toBeNull()
    } finally {
      vi.doUnmock('cross-spawn')
      vi.resetModules()
      vi.useRealTimers()
    }
  }, 30_000)
})
