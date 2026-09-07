import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-write-guard-ud-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

import { toolEdit } from '@main/agent/tools/edit'
import {
  assertInlineInstancePathScope,
  assertInlineInstancePushDenied,
  assertInlineInstanceTerminalAllowed,
  assertInlineInstanceUnscopedToolAllowed,
  assertWritablePath,
  isRelPathInPathScope,
  isSafePathScopePrefix
} from '@main/agent/tools/writeGuard'
import { createRun } from '@main/agent/state'
import { resolveRunDir } from '@main/storage/paths'

describe('writeGuard', () => {
  it('allows large text writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-write-guard-large-'))
    const big = 'x'.repeat(100_000)
    const lines = Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join('\n')
    expect(() => assertWritablePath('notes.txt')).not.toThrow()
    expect(() => assertWritablePath('data.txt')).not.toThrow()
    toolEdit(dir, 'big.txt', big, undefined)
    toolEdit(dir, 'many-lines.txt', lines, undefined)
    expect(readFileSync(join(dir, 'big.txt'), 'utf8')).toBe(big)
    expect(readFileSync(join(dir, 'many-lines.txt'), 'utf8')).toBe(lines)
  })

  it('rejects text writes to binary extensions', () => {
    expect(() => assertWritablePath('model.gguf')).toThrow(/binary path/)
    expect(() =>
      toolEdit(mkdtempSync(join(tmpdir(), 'vyotiq-write-guard-bin-')), 'model.gguf', 'x', undefined)
    ).toThrow(/binary path/)
  })

  it('isRelPathInPathScope matches prefix boundaries', () => {
    expect(isRelPathInPathScope('src/main/a.ts', ['src/main'])).toBe(true)
    expect(isRelPathInPathScope('src/main', ['src/main/'])).toBe(true)
    expect(isRelPathInPathScope('src/main-other/x.ts', ['src/main'])).toBe(false)
  })

  it('isRelPathInPathScope rejects .. escape attempts', () => {
    expect(isRelPathInPathScope('src/allowed/../secret.ts', ['src/allowed'])).toBe(false)
    expect(isRelPathInPathScope('../secret.ts', ['src/allowed'])).toBe(false)
    expect(isRelPathInPathScope('src/allowed/nested.ts', ['src/allowed'])).toBe(true)
  })

  it('isSafePathScopePrefix allows trailing slashes and rejects escapes', () => {
    expect(isSafePathScopePrefix('src/main/')).toBe(true)
    expect(isSafePathScopePrefix('src')).toBe(true)
    expect(isSafePathScopePrefix('../secret')).toBe(false)
    expect(isSafePathScopePrefix('C:/Windows')).toBe(false)
    expect(isSafePathScopePrefix('/etc/passwd')).toBe(false)
  })

  describe('assertInlineInstancePathScope', () => {
    const root = join(tmpdir(), `vyotiq-path-scope-${process.pid}`)
    afterEach(() => {
      rmSync(root, { recursive: true, force: true })
    })

    it('denies out-of-scope writes for inline instances', () => {
      const workspace = join(root, 'ws')
      mkdirSync(workspace, { recursive: true })
      const runId = 'child-scope'
      createRun(workspace, runId, 'scoped', {
        inlineInstance: true,
        parentRunId: 'parent',
        pathScope: ['src/allowed/']
      })
      const runDir = resolveRunDir(workspace, runId)
      expect(() => assertInlineInstancePathScope(runDir, ['src/allowed/a.ts'])).not.toThrow()
      expect(() => assertInlineInstancePathScope(runDir, ['src/other/b.ts'])).toThrow(
        /outside this instance path_scope/
      )
    })

    it('no-ops when path_scope is unset', () => {
      const workspace = join(root, 'ws2')
      mkdirSync(workspace, { recursive: true })
      const runId = 'child-open'
      createRun(workspace, runId, 'open', {
        inlineInstance: true,
        parentRunId: 'parent'
      })
      expect(() =>
        assertInlineInstancePathScope(resolveRunDir(workspace, runId), ['anywhere.ts'])
      ).not.toThrow()
    })

    it('denies terminal for path_scope shared instances without worktree', () => {
      const workspace = join(root, 'ws-term')
      mkdirSync(workspace, { recursive: true })
      const runId = 'child-term'
      createRun(workspace, runId, 'scoped', {
        inlineInstance: true,
        parentRunId: 'parent',
        pathScope: ['src/allowed']
      })
      expect(() => assertInlineInstanceTerminalAllowed(resolveRunDir(workspace, runId))).toThrow(
        /terminal is denied/
      )
    })

    it('allows terminal for path_scope instances with a worktree', () => {
      const workspace = join(root, 'ws-term-wt')
      mkdirSync(workspace, { recursive: true })
      const runId = 'child-term-wt'
      createRun(workspace, runId, 'scoped', {
        inlineInstance: true,
        parentRunId: 'parent',
        pathScope: ['src/allowed'],
        worktreePath: join(workspace, '.wt')
      })
      expect(() =>
        assertInlineInstanceTerminalAllowed(resolveRunDir(workspace, runId))
      ).not.toThrow()
    })

    it('denies diagnostics git_commit and MCP for shared path_scope instances', () => {
      const workspace = join(root, 'ws-unscoped')
      mkdirSync(workspace, { recursive: true })
      const runId = 'child-unscoped'
      createRun(workspace, runId, 'scoped', {
        inlineInstance: true,
        parentRunId: 'parent',
        pathScope: ['src/allowed']
      })
      const dir = resolveRunDir(workspace, runId)
      expect(() => assertInlineInstanceUnscopedToolAllowed(dir, 'diagnostics')).toThrow(
        /diagnostics is denied/
      )
      expect(() => assertInlineInstanceUnscopedToolAllowed(dir, 'git_commit')).toThrow(
        /git_commit is denied/
      )
      expect(() => assertInlineInstanceUnscopedToolAllowed(dir, 'MCP')).toThrow(/MCP is denied/)
    })

    it('denies push for any inline instance', () => {
      const workspace = join(root, 'ws-push')
      mkdirSync(workspace, { recursive: true })
      const runId = 'child-push'
      createRun(workspace, runId, 'scoped', {
        inlineInstance: true,
        parentRunId: 'parent',
        pathScope: ['src/allowed'],
        worktreePath: join(workspace, '.wt')
      })
      expect(() => assertInlineInstancePushDenied(resolveRunDir(workspace, runId))).toThrow(
        /cannot push/i
      )
    })

    it('scopes git_commit paths for partitioned worktree instances', () => {
      const workspace = join(root, 'ws-commit-scope')
      mkdirSync(workspace, { recursive: true })
      const runId = 'child-commit-scope'
      createRun(workspace, runId, 'scoped', {
        inlineInstance: true,
        parentRunId: 'parent',
        pathScope: ['src/allowed'],
        worktreePath: join(workspace, '.wt')
      })
      const dir = resolveRunDir(workspace, runId)
      expect(() => assertInlineInstancePathScope(dir, ['src/other/x.ts'])).toThrow(/path_scope/)
      expect(() => assertInlineInstancePathScope(dir, ['src/allowed/x.ts'])).not.toThrow()
    })
  })
})
