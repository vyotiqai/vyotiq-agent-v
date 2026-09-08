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
  loopHintForIdenticalStepStreak,
  loopHintForConsecutiveToolFailures,
  isPlausibleWorkspaceFilePath,
  isBuildOutputRelPath,
  isAbortStubToolResult,
  isNonMutatingWriteFailure,
  normalizeWorkspaceRelPath,
  readPathFromToolCall,
  runBudgetStopMessage,
  seedKnownPathsFromMessages,
  summarizeRecentToolFailure,
  toolArgsFromCall,
  unreadExistingEditPaths
} from '@main/agent/loopPolicy'

describe('loopPolicy', () => {
  it('hints ask_question schema after consecutive arg failures', () => {
    const hint = loopHintForConsecutiveToolFailures(2, {
      tool: 'ask_question',
      summary: 'question or questions is required. Pass questions: [{ id, prompt, type...'
    })
    expect(hint).toBeTruthy()
    expect(hint).toMatch(/ask_question requires questions/i)
    expect(hint).toMatch(/Never call it with \{\}/i)

    const typeHint = loopHintForConsecutiveToolFailures(2, {
      tool: 'ask_question',
      summary: 'questions[0].type must be single, multi, boolean, or text'
    })
    expect(typeHint).toMatch(/ask_question requires questions/i)

    const emptyHint = loopHintForConsecutiveToolFailures(2, {
      tool: 'ask_question',
      summary: 'questions must contain at least 1 item'
    })
    expect(emptyHint).toMatch(/ask_question requires questions/i)

    const malformedHint = loopHintForConsecutiveToolFailures(2, {
      tool: 'ask_question',
      summary:
        'Arguments for ask_question must be one complete JSON object — the payload arrived malformed, truncated, or non-object.'
    })
    expect(malformedHint).toMatch(/ask_question requires questions/i)

    const optionsHint = loopHintForConsecutiveToolFailures(2, {
      tool: 'ask_question',
      summary: 'Invalid arguments'
    })
    expect(optionsHint).toMatch(/at least 2 distinct non-blank options/i)

    const directOptionsHint = loopHintForConsecutiveToolFailures(2, {
      tool: 'ask_question',
      summary:
        'questions[0] (single) requires at least 2 options (duplicate or blank options are removed first)'
    })
    expect(directOptionsHint).toMatch(/at least 2 distinct non-blank options/i)

    expect(
      loopHintForConsecutiveToolFailures(1, {
        tool: 'ask_question',
        summary: 'question or questions is required'
      })
    ).toBeUndefined()
  })

  it('hints diff after an empty edit would truncate an existing file', () => {
    const hint = loopHintForConsecutiveToolFailures(2, {
      tool: 'edit',
      summary: 'edit refuses to replace non-empty src/a.ts with empty contents'
    })
    expect(hint).toMatch(/non-empty contents/i)
    expect(hint).toMatch(/use diff to remove contents explicitly/i)
  })

  it('hints stale edit diffs and missing str_replace snippets', () => {
    const diffHint = loopHintForConsecutiveToolFailures(2, {
      tool: 'edit',
      summary:
        'Diff hunk failed to match near line 150 (context/removal mismatch). Expected: "import"'
    })
    expect(diffHint).toMatch(/did not match the file/i)
    expect(diffHint).toMatch(/Re-read/i)

    const replaceHint = loopHintForConsecutiveToolFailures(2, {
      tool: 'str_replace',
      summary:
        'old_string not found in src/main/agent/loopPolicy.ts. Closest match near line 8:'
    })
    expect(replaceHint).toMatch(/old_string was not found/i)
    expect(replaceHint).toMatch(/startLine\/endLine/i)
  })

  it('hints workspace-root path escapes and Plan-mode product edits', () => {
    const escapeHint = loopHintForConsecutiveToolFailures(2, {
      tool: 'read',
      summary: 'Path escapes workspace: vyotiq'
    })
    expect(escapeHint).toMatch(/outside the workspace root/i)
    expect(escapeHint).toMatch(/workspace-relative/i)

    const planHint = loopHintForConsecutiveToolFailures(2, {
      tool: 'edit',
      summary:
        'Plan mode may only edit plan.md or contract.md (run plan artifacts). Call `switch_mode` with mode "agent" to edit product code.'
    })
    expect(planHint).toMatch(/switch_mode/i)
    expect(planHint).toMatch(/plan\.md/i)
  })

  it('hints read instead of unzipping Word .docx in the terminal', () => {
    const hint = loopHintForConsecutiveToolFailures(2, {
      tool: 'terminal',
      summary:
        'Do not unzip Word .docx in the terminal. Call read on the .docx path — it returns extracted document text.'
    })
    expect(hint).toMatch(/Call read on the \.docx path/i)
    expect(hint).toMatch(/extracted document text/i)
  })

  it('hints missing PATH instead of retrying swift/dotnet not-recognized', () => {
    const hint = loopHintForConsecutiveToolFailures(2, {
      tool: 'terminal',
      summary:
        "swift : The term 'swift' is not recognized as the name of a cmdlet, function, script file, or operable program."
    })
    expect(hint).toMatch(/not on PATH/i)
    expect(hint).toMatch(/Do not retry the same invocation/i)

    const parseHint = loopHintForConsecutiveToolFailures(2, {
      tool: 'terminal',
      summary: "The term '=' is not recognized as the name of a cmdlet"
    })
    expect(parseHint).not.toMatch(/not on PATH/i)
  })

  it('hints PowerShell space-before-dot member access', () => {
    const hint = loopHintForConsecutiveToolFailures(2, {
      tool: 'terminal',
      summary: "Unexpected token '.Line' in expression or statement."
    })
    expect(hint).toMatch(/\$_\.Line not \$_ \.Line/)
    expect(hint).toMatch(/Get-Content/)
  })

  it('coaches ssh remote polls toward explicit verdicts instead of grep exit 1', () => {
    // Verbatim summary shape from run 1de9344a invoke 2: ssh-poll frames whose
    // 240-char summary is consumed by the session header + ssh command.
    const hint = loopHintForConsecutiveToolFailures(2, {
      tool: 'terminal',
      summary:
        "e9bcc8de-25dd-4f48-aec1-2a9e4b47aedc | status: done | command: ssh -i .vmkey\\id_ed25519 -p 2222 -o StrictHostKeyChecking=no root@127.0.0.1 'n=$(grep -aoE \"[0-9]+/847\" /root/build.log)'; exit_code: 1"
    })
    expect(hint).toMatch(/ssh exits with the remote script/)
    expect(hint).toMatch(/explicit verdict/)
    expect(hint).toMatch(/can.t create/)

    // Local ssh-not-on-PATH still gets the PATH hint, not the remote-poll one.
    const pathHint = loopHintForConsecutiveToolFailures(2, {
      tool: 'terminal',
      summary: "ssh : The term 'ssh' is not recognized as the name of a cmdlet"
    })
    expect(pathHint).toMatch(/not on PATH/i)
    expect(pathHint).not.toMatch(/explicit verdict/)
  })

  it('coaches terminal deadline failures toward background sessions', () => {
    // Verbatim deadline content from executeStepTools.ts (TOOL_SOFT_DEADLINE_MS).
    const hint = loopHintForConsecutiveToolFailures(2, {
      tool: 'terminal',
      summary:
        'Tool "terminal" exceeded its 10-minute deadline and was stopped. Split the work into smaller calls or check whether the tool is stuck.'
    })
    expect(hint).toContain('background')
    expect(hint).toMatch(/background session/i)
    expect(hint).toMatch(/narrow the command/i)
  })

  it('hints duplicate JSON keys so the dropped path is not retried as one call', () => {
    const hint = loopHintForConsecutiveToolFailures(2, {
      tool: 'read',
      summary:
        'Duplicate JSON key "path" ("murmur-youtube-main/windows/global.json" and "murmur-youtube-main/windows/Directory.Build.props"). JSON keeps only the last value. Call the tool once per file.'
    })
    expect(hint).toMatch(/Duplicate JSON key/)
    expect(hint).toMatch(/once per file/)
  })

  it('hints todo_write Zod field errors, not only todos: Required', () => {
    const hint = loopHintForConsecutiveToolFailures(2, {
      tool: 'todo_write',
      summary: 'todos.0.content: Required'
    })
    expect(hint).toMatch(/todos: \[\{ id, content, status \}\]/i)
  })

  it('hints snapshot refresh instead of reusing stale browser refs', () => {
    const hint = loopHintForConsecutiveToolFailures(2, {
      tool: 'browser_hover',
      summary: 'Unknown snapshot ref @e5. Call browser_snapshot first and use a listed @eN ref.'
    })
    expect(hint).toMatch(/refs reset on every navigation/i)
    expect(hint).toMatch(/browser_snapshot/i)
    expect(hint).toMatch(/fresh @eN/i)
  })

  it('hints page-state check instead of repeating blind URL waits', () => {
    const hint = loopHintForConsecutiveToolFailures(2, {
      tool: 'browser_wait_for_url',
      summary:
        'Timed out after 10000ms waiting for URL matching "/secure" (last: "https://the-internet.herokuapp.com/login", title: "The Internet")'
    })
    expect(hint).toMatch(/do not repeat the same wait/i)
    expect(hint).toMatch(/browser_snapshot/i)
    expect(hint).toMatch(/last URL/i)
  })

  it('hints stop-and-report instead of retrying denied PR creation', () => {
    const hint = loopHintForConsecutiveToolFailures(2, {
      tool: 'github_pr_create',
      summary:
        'The user denied permission to run github_pr_create. Do not retry it; ask what to do instead or continue without it.'
    })
    expect(hint).toMatch(/do not retry/i)
    expect(hint).toMatch(/branch/i)
    expect(hint).toMatch(/gh auth login/i)
  })

  it('hints re-sync or Settings alignment for lexical-only codebase search', () => {
    const hint = loopHintForConsecutiveToolFailures(2, {
      tool: 'codebase_search',
      summary:
        'index: 1234 chunks / 89 files · model=lighton-denseon · lexical-only · hits=5\nQuery embedder does not match the indexed model; hits are lexical only (not dense semantic search).'
    })
    expect(hint).toMatch(/re-sync|re-index/i)
    expect(hint).toMatch(/embedder|Settings → Indexing/i)
  })

  it('does not specialize mixed read offset/limit errors (line-range already wins at Zod)', () => {
    const hint = loopHintForConsecutiveToolFailures(2, {
      tool: 'read',
      summary: 'offset: offset/limit cannot be combined with startLine/endLine'
    })
    expect(hint).toBeTruthy()
    expect(hint).toMatch(/read the last tool_result errors/i)
    expect(hint).not.toMatch(/omit offset\/limit/i)
  })

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
      runNoticeForContextAboveSoftTrigger(),
      loopHintForConsecutiveToolFailures(6)
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

  it('mentions identical-step shape at streak 2', () => {
    const hint = loopHintForIdenticalStepStreak(2)
    expect(hint).toMatch(/repeated the same tool call shape/i)
  })

  it('summarizes the latest failed tool message', () => {
    expect(
      summarizeRecentToolFailure([
        { role: 'tool', toolName: 'read', content: 'ok', ok: true },
        { role: 'tool', toolName: 'edit', content: 'path: Required', ok: false }
      ])
    ).toEqual({ tool: 'edit', summary: 'path: Required' })
  })
})

describe('runBudgetStopMessage', () => {
  const totals = {
    billedCost: 5,
    billedInputTokens: 1_000_000,
    outputTokens: 10_000
  }

  it('returns undefined when both limits are 0 (disabled)', () => {
    expect(runBudgetStopMessage({ runSpendLimitUsd: 0, runTokenLimit: 0 }, totals)).toBeUndefined()
    expect(runBudgetStopMessage({}, totals)).toBeUndefined()
  })

  it('stops at the spend limit and names both limit and billed amount', () => {
    const msg = runBudgetStopMessage({ runSpendLimitUsd: 4, runTokenLimit: 0 }, totals)
    expect(msg).toMatch(/spend limit \(\$4\.00; \$5\.00 billed\)/)
    expect(msg).toMatch(/budget guard/)
  })

  it('keeps running below the spend limit', () => {
    expect(
      runBudgetStopMessage({ runSpendLimitUsd: 10, runTokenLimit: 0 }, totals)
    ).toBeUndefined()
  })

  it('stops at the token limit counting billed input + output', () => {
    const msg = runBudgetStopMessage({ runSpendLimitUsd: 0, runTokenLimit: 1_000_000 }, totals)
    expect(msg).toMatch(/token limit \(1,000,000 tokens; 1,010,000 used\)/)
  })

  it('checks spend before tokens when both are exceeded', () => {
    const msg = runBudgetStopMessage({ runSpendLimitUsd: 1, runTokenLimit: 100 }, totals)
    expect(msg).toMatch(/spend limit/)
  })
})
