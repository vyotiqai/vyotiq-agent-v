import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  execPackageCommand,
  hasJavaScriptProject,
  hasTypeScriptProject,
  parseDiagnosticLines,
  parseEslintJsonDiagnostics,
  runSafeCommand,
  MAX_STREAM_BYTES,
  toolDiagnosticsAsync
} from '../../../src/main/agent/tools/diagnostics'

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({})
}))

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
})

describe('execPackageCommand', () => {
  it('inserts -- for npm so flags are not swallowed as npm config', () => {
    expect(execPackageCommand('npm', 'eslint', '. --format json')).toBe(
      'npm exec -- eslint . --format json'
    )
    expect(execPackageCommand('npm', 'tsc', '--noEmit --pretty false')).toBe(
      'npm exec -- tsc --noEmit --pretty false'
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
