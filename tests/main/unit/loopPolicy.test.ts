import { describe, expect, it } from 'vitest'
import {
  applyToolCallToKnownPaths,
  combineLoopHints,
  deletePathFromToolCall,
  editPathsFromToolCall,
  isInspectToolName,
  loopHintAfterCompaction,
  loopHintForCompactionFailure,
  loopHintForCompactionVerifyFailed,
  runNoticeForContextAboveSoftTrigger,
  isPlausibleWorkspaceFilePath,
  isBuildOutputRelPath,
  isAbortStubToolResult,
  isNonMutatingWriteFailure,
  normalizeWorkspaceRelPath,
  readPathFromToolCall,
  seedKnownPathsFromMessages,
  toolArgsFromCall,
  unreadExistingEditPaths
} from '@main/agent/loopPolicy'

describe('loopPolicy', () => {
  it('normalizes workspace-relative paths', () => {
    expect(normalizeWorkspaceRelPath('  src\\foo.ts  ')).toBe('src/foo.ts')
  })

  it('rejects shell-operator junk in receipt paths', () => {
    expect(isPlausibleWorkspaceFilePath('src/stores')).toBe(true)
    expect(isPlausibleWorkspaceFilePath('src/stores;')).toBe(false)
    expect(isPlausibleWorkspaceFilePath('src/a.ts')).toBe(true)
    expect(isPlausibleWorkspaceFilePath('$env:TEMP/ext.ps1')).toBe(false)
  })

  it('classifies .NET bin/Debug output and abort/mode write failures', () => {
    expect(
      isBuildOutputRelPath(
        'murmur-youtube-main/windows/src/Murmur.App/bin/Debug/net10.0/Murmur.App.dll'
      )
    ).toBe(true)
    expect(isBuildOutputRelPath('src/obj/Debug/foo.cs')).toBe(true)
    expect(isBuildOutputRelPath('bin/cli.ts')).toBe(false)
    expect(isBuildOutputRelPath('src/main/agent/loopPolicy.ts')).toBe(false)

    expect(isAbortStubToolResult('Cancelled')).toBe(true)
    expect(isAbortStubToolResult('Interrupted')).toBe(true)
    expect(isAbortStubToolResult('exit 1')).toBe(false)

    expect(
      isNonMutatingWriteFailure(
        'Plan mode may only edit plan.md or contract.md (run plan artifacts). Call `switch_mode` with mode "agent" to edit product code.'
      )
    ).toBe(true)
    expect(isNonMutatingWriteFailure('Diff hunk failed to match near line 150')).toBe(false)
  })

  it('extracts read and edit paths from tool calls', () => {
    expect(readPathFromToolCall('read', { path: 'a\\b.ts' })).toBe('a/b.ts')
    expect(readPathFromToolCall('read', { file: 'alias.ts' })).toBe('alias.ts')
    expect(readPathFromToolCall('grep', { path: 'a.ts' })).toBeNull()
    expect(editPathsFromToolCall('str_replace', { path: 'x.ts' })).toEqual(['x.ts'])
    expect(editPathsFromToolCall('edit', { filepath: 'y.ts' })).toEqual(['y.ts'])
  })

  it('treats concrete grep include and glob pattern as inspect paths', () => {
    const known = new Set<string>()
    applyToolCallToKnownPaths(known, 'grep', { pattern: 'foo', include: 'src/a.ts' }, true)
    expect(known.has('src/a.ts')).toBe(true)
    applyToolCallToKnownPaths(known, 'grep', { pattern: 'bar', path: 'src/c.ts' }, true)
    expect(known.has('src/c.ts')).toBe(true)
    applyToolCallToKnownPaths(known, 'glob', { pattern: 'src/**/*.ts' }, true)
    expect(known.has('src/**/*.ts')).toBe(false)
    applyToolCallToKnownPaths(known, 'glob', { pattern: 'src/b.ts' }, true)
    expect(known.has('src/b.ts')).toBe(true)
  })

  it('treats list_dir path as inspect', () => {
    const known = new Set<string>()
    applyToolCallToKnownPaths(known, 'list_dir', { path: 'src/pkg' }, true)
    expect(known.has('src/pkg')).toBe(true)
  })

  it('treats search hit paths as inspect', () => {
    expect(isInspectToolName('search')).toBe(true)
    const known = new Set<string>()
    applyToolCallToKnownPaths(
      known,
      'search',
      { query: 'foo' },
      true,
      'file: src/a.ts\nsrc/b.ts:3: foo bar\nindex=live'
    )
    expect(known.has('src/a.ts')).toBe(true)
    expect(known.has('src/b.ts')).toBe(true)
  })

  it('tracks known paths only on successful read/write', () => {
    const known = new Set<string>()
    applyToolCallToKnownPaths(known, 'read', { path: 'a.ts' }, false)
    expect(known.size).toBe(0)
    applyToolCallToKnownPaths(known, 'read', { path: 'a.ts' }, true)
    expect(known.has('a.ts')).toBe(true)
    applyToolCallToKnownPaths(known, 'edit', { path: 'b.ts' }, true)
    expect(known.has('b.ts')).toBe(true)
  })

  it('invalidates known paths after successful delete (always clears descendants)', () => {
    expect(deletePathFromToolCall('delete', { path: 'src\\a.ts' })).toBe('src/a.ts')
    expect(deletePathFromToolCall('edit', { path: 'src/a.ts' })).toBeNull()

    const known = new Set(['src/a.ts', 'src/dir/b.ts', 'src/dir/c.ts', 'other.ts'])
    applyToolCallToKnownPaths(known, 'delete', { path: 'src/a.ts' }, true)
    expect(known.has('src/a.ts')).toBe(false)
    expect(known.has('src/dir/b.ts')).toBe(true)

    // toolDelete always removes dir trees on success — clear descendants even without recursive arg
    applyToolCallToKnownPaths(known, 'delete', { path: 'src/dir' }, true)
    expect(known.has('src/dir/b.ts')).toBe(false)
    expect(known.has('src/dir/c.ts')).toBe(false)
    expect(known.has('other.ts')).toBe(true)

    // Failed delete must not clear inspect state.
    known.add('keep.ts')
    applyToolCallToKnownPaths(known, 'delete', { path: 'keep.ts' }, false)
    expect(known.has('keep.ts')).toBe(true)
  })

  it('treats delete-then-recreate as unread before edit for receipt observation', () => {
    const known = new Set<string>()
    applyToolCallToKnownPaths(known, 'read', { path: 'a.ts' }, true)
    applyToolCallToKnownPaths(known, 'delete', { path: 'a.ts' }, true)
    expect(known.has('a.ts')).toBe(false)
    const exists = (p: string) => p === 'a.ts'
    expect(unreadExistingEditPaths(known, 'edit', { path: 'a.ts' }, exists)).toEqual(['a.ts'])
  })

  it('detects existing unread edit paths for receipt observation', () => {
    const known = new Set(['seen.ts'])
    const exists = (p: string) => p === 'exists.ts' || p === 'seen.ts'
    expect(
      unreadExistingEditPaths(known, 'str_replace', { path: 'exists.ts' }, exists)
    ).toEqual(['exists.ts'])
    expect(
      unreadExistingEditPaths(known, 'str_replace', { path: 'seen.ts' }, exists)
    ).toEqual([])
    expect(
      unreadExistingEditPaths(known, 'edit', { path: 'brand-new.ts' }, exists)
    ).toEqual([])
    expect(unreadExistingEditPaths(known, 'read', { path: 'exists.ts' }, exists)).toEqual([])
  })

  it('combineLoopHints joins defined hints and skips undefined', () => {
    expect(combineLoopHints('mcp hint', undefined)).toBe('mcp hint')
    expect(combineLoopHints(undefined, undefined)).toBeUndefined()
  })

  it('returns undefined without retained decisions after compaction', () => {
    expect(loopHintAfterCompaction()).toBeUndefined()
    expect(combineLoopHints('mcp omit', undefined)).toBe('mcp omit')
  })

  it('includes retained ask_question decisions in post-compaction hint', () => {
    const hint = loopHintAfterCompaction(['Use PostgreSQL'])
    expect(hint).toMatch(/do not re-ask/i)
    expect(hint).toContain('Use PostgreSQL')
  })

  it('hints when compaction summary failed verification', () => {
    const hint = loopHintForCompactionVerifyFailed()
    expect(hint).toMatch(/failed verification/i)
    expect(hint).toMatch(/was not applied/i)
    expect(hint).toMatch(/memory_write/)
    expect(hint).not.toMatch(/context meter/i)
    expect(hint).not.toMatch(/(?<![a-zA-Z])\/compact(?![a-zA-Z])/)
  })

  it('does not coach user Compact UI in compaction loop hints', () => {
    const hints = [
      loopHintForCompactionFailure(),
      loopHintForCompactionVerifyFailed(),
      runNoticeForContextAboveSoftTrigger()
    ]
    for (const hint of hints) {
      expect(hint).toBeTruthy()
      expect(hint).not.toMatch(/context meter/i)
      expect(hint).not.toMatch(/(?<![a-zA-Z])\/compact(?![a-zA-Z])/)
    }
  })

  it('seeds known paths only from successful matched tool results on resume', () => {
    const known = seedKnownPathsFromMessages([
      {
        role: 'assistant',
        toolCalls: [
          { id: 'r1', name: 'read', arguments: '{"path":"src/a.ts"}' },
          {
            id: 'e1',
            name: 'str_replace',
            arguments: '{"path":"src\\\\b.ts","old_string":"x","new_string":"y"}'
          },
          { id: 'r2', name: 'read', arguments: '{"path":"src/failed.ts"}' }
        ]
      },
      { role: 'tool', toolCallId: 'r1', toolName: 'read', ok: true },
      { role: 'tool', toolCallId: 'e1', toolName: 'str_replace', ok: true },
      { role: 'tool', toolCallId: 'r2', toolName: 'read', ok: false }
    ])
    expect(known.has('src/a.ts')).toBe(true)
    expect(known.has('src/b.ts')).toBe(true)
    expect(known.has('src/failed.ts')).toBe(false)
  })

  it('treats same-step concrete grep as inspect for unread observation', () => {
    const known = new Set<string>()
    const exists = (p: string) => p === 'src/a.ts'
    const calls = [
      { id: '1', name: 'grep' as const, arguments: '{"pattern":"x","include":"src/a.ts"}' },
      { id: '2', name: 'edit' as const, arguments: '{"path":"src/a.ts","content":"y"}' }
    ]
    for (const call of calls) {
      if (isInspectToolName(call.name)) {
        applyToolCallToKnownPaths(known, call.name, toolArgsFromCall(call.arguments), true)
      }
    }
    const unread: string[] = []
    for (const call of calls) {
      unread.push(
        ...unreadExistingEditPaths(known, call.name, toolArgsFromCall(call.arguments), exists)
      )
      if (!isInspectToolName(call.name)) {
        applyToolCallToKnownPaths(known, call.name, toolArgsFromCall(call.arguments), true)
      }
    }
    expect(unread).toHaveLength(0)
  })

  it('treats codebase_search hit paths from result as inspect', () => {
    expect(isInspectToolName('codebase_search')).toBe(true)
    const known = new Set<string>()
    const result = `index: 2 chunks / 1 files · model=local-hash-v1 · fallback=hash · hits=1

1. src/auth.ts:1-8 [function validateAuthToken] score=0.5000
export function validateAuthToken`
    applyToolCallToKnownPaths(
      known,
      'codebase_search',
      { query: 'where is auth validated' },
      true,
      result
    )
    expect(known.has('src/auth.ts')).toBe(true)
    const unread = unreadExistingEditPaths(
      known,
      'edit',
      { path: 'src/auth.ts', content: 'x' },
      () => true
    )
    expect(unread).toHaveLength(0)
  })
})
