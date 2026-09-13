import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildRunReceipt,
  writeRunReceipt,
  wroteFilesFromEvents,
  RUN_RECEIPT_FILENAME,
  RUN_RECEIPT_VERSION
} from '@main/agent/runReceipt'
import { RunReceiptSchema } from '@shared/ipc'
import type { ChatMessage, PersistedEvent, RunStatus } from '@shared/ipc'

describe('runReceipt', () => {
  it('does not stamp codebase_search health into the receipt', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'codebase_search', arguments: '{"query":"where is X"}' }]
      },
      {
        role: 'tool',
        toolCallId: 'c1',
        toolName: 'codebase_search',
        ok: true,
        content:
          'index: 100 chunks / 10 files · model=lightonai/mDenseOn@onnx-int8 · hits=5\n\n1. src/a.ts:1-2 [function f] score=0.5'
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c2', name: 'codebase_search', arguments: '{"query":"legacy model"}' }]
      },
      {
        role: 'tool',
        toolCallId: 'c2',
        toolName: 'codebase_search',
        ok: true,
        content:
          'index: 100 chunks / 10 files · model=onnx-community/DenseOn@onnx-int8 · lexical-only · hits=3\nQuery embedder does not match the indexed model.'
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c3', name: 'codebase_search', arguments: '{"query":"offline"}' }]
      },
      {
        role: 'tool',
        toolCallId: 'c3',
        toolName: 'codebase_search',
        ok: true,
        content:
          'index: 100 chunks / 10 files · model=local-hash-v1 · fallback=hash · hits=2\nNeural embeddings are unavailable.'
      },
      {
        role: 'tool',
        toolCallId: 'c4',
        toolName: 'codebase_search',
        ok: false,
        content: 'index: 0 chunks / 0 files · model=local-hash-v1 · fallback=hash · hits=0'
      }
    ]
    const receipt = buildRunReceipt({
      runId: 'run-cbs',
      status: {
        status: 'done',
        step: 2,
        updatedAt: '2026-09-03T00:00:00.000Z'
      },
      messages,
      events: [],
      contract: '## Goal\n\ncbs health\n'
    })
    expect(receipt.codebaseSearch).toBeUndefined()
    expect(RunReceiptSchema.parse(receipt).codebaseSearch).toBeUndefined()
  })

  it('aggregates tool stats, failures, unread edits, and diagnostics', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'r1', name: 'read', arguments: '{"path":"a.ts"}' },
          { id: 'e1', name: 'str_replace', arguments: '{"path":"b.ts"}' }
        ]
      },
      { role: 'tool', toolCallId: 'r1', toolName: 'read', ok: true, content: 'ok' },
      {
        role: 'tool',
        toolCallId: 'e1',
        toolName: 'str_replace',
        ok: false,
        content: 'ENOENT missing'
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'd1', name: 'diagnostics', arguments: '{"kind":"typecheck"}' }]
      },
      {
        role: 'tool',
        toolCallId: 'd1',
        toolName: 'diagnostics',
        ok: true,
        content: 'clean'
      },
      { role: 'assistant', content: 'All done — task complete.' }
    ]
    const events: PersistedEvent[] = [
      {
        at: '2026-07-30T00:00:00.000Z',
        event: {
          type: 'writes_checkpoint',
          runId: 'run-1',
          checkpointId: 'c1',
          files: [{ path: 'b.ts', action: 'modified', undoable: true }]
        }
      },
      {
        at: '2026-07-30T00:00:01.000Z',
        event: {
          type: 'step_usage',
          runId: 'run-1',
          step: 1,
          inputTokens: 100,
          outputTokens: 20
        }
      },
      {
        at: '2026-07-30T00:00:02.000Z',
        event: { type: 'compaction', runId: 'run-1', summary: 'folded' }
      },
      {
        at: '2026-07-30T00:00:03.000Z',
        event: {
          type: 'incomplete',
          runId: 'run-1',
          reason: 'truncated',
          message: 'cut off'
        }
      }
    ]
    const status: RunStatus = {
      status: 'error',
      step: 3,
      updatedAt: '2026-07-30T00:00:01.000Z',
      goal: 'Fix b.ts',
      mode: 'agent',
      error: 'boom'
    }
    const receipt = buildRunReceipt({
      runId: 'run-1',
      status,
      messages,
      events,
      contract: '## Goal\n\nFix\n\n## Done when\n\n- tests pass\n',
    })
    expect(receipt.version).toBe(RUN_RECEIPT_VERSION)
    expect(receipt.toolStats.totalCalls).toBe(3)
    expect(receipt.toolStats.failed).toBe(1)
    expect(receipt.toolStats.byName.str_replace?.failed).toBe(1)
    expect(receipt.codebaseSearch).toBeUndefined()
    expect(receipt.failureClusters[0]?.key).toMatch(/str_replace/)
    expect(receipt.unreadEditPaths).toContain('b.ts')
    expect(receipt.unreadEditPaths).not.toContain('a.ts')
    expect(receipt.wroteFiles).toEqual(['b.ts'])
    expect(receipt.diagnostics).toEqual({ calls: 1, ok: 1, clean: 1 })
    expect(receipt.contractExcerpt).toMatch(/Done when/)
    expect(receipt.statusError).toBe('boom')
    expect(receipt.incomplete).toEqual({ reason: 'truncated', message: 'cut off' })
    expect(receipt.tokenUsage).toEqual({
      inputTokens: 100,
      billedInputTokens: 100,
      peakInputTokens: 100,
      outputTokens: 20
    })
    expect(receipt.compactionCount).toBe(1)
    expect(receipt.maxConsecutiveToolFailures).toBe(1)
    expect(RunReceiptSchema.parse(receipt).runId).toBe('run-1')
  })

  it('measures the longest consecutive failed-tool-call run', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'f1', name: 'edit', arguments: '{"path":"a.ts"}' },
          { id: 'f2', name: 'edit', arguments: '{"path":"b.ts"}' },
          { id: 'f3', name: 'edit', arguments: '{"path":"c.ts"}' },
          { id: 'r1', name: 'read', arguments: '{"path":"d.ts"}' }
        ]
      },
      { role: 'tool', toolCallId: 'f1', toolName: 'edit', ok: false, content: 'boom 1' },
      { role: 'tool', toolCallId: 'f2', toolName: 'edit', ok: false, content: 'boom 2' },
      { role: 'tool', toolCallId: 'f3', toolName: 'edit', ok: false, content: 'boom 3' },
      { role: 'tool', toolCallId: 'r1', toolName: 'read', ok: true, content: 'ok' }
    ]
    const receipt = buildRunReceipt({
      runId: 'streaks',
      status: { status: 'error', step: 2, updatedAt: new Date().toISOString() },
      messages,
      events: [],
      contract: ''
    })
    expect(receipt.toolStats.failed).toBe(3)
    expect(receipt.maxConsecutiveToolFailures).toBe(3)

    // No failures → field omitted entirely (additive optional).
    const clean = buildRunReceipt({
      runId: 'clean',
      status: { status: 'done', step: 1, updatedAt: new Date().toISOString() },
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'r2', name: 'read', arguments: '{"path":"a.ts"}' }]
        },
        { role: 'tool', toolCallId: 'r2', toolName: 'read', ok: true, content: 'ok' }
      ],
      events: [],
      contract: ''
    })
    expect(clean).not.toHaveProperty('maxConsecutiveToolFailures')
  })

  it('extracts wroteFiles from CheckpointFileEntry objects', () => {
    expect(
      wroteFilesFromEvents([
        {
          at: 't',
          event: {
            type: 'writes_checkpoint',
            files: [
              { path: 'src\\a.ts', action: 'created', undoable: true },
              { path: 'b.ts', action: 'modified', undoable: true }
            ]
          }
        }
      ])
    ).toEqual(['src/a.ts', 'b.ts'])
  })

  it('filters garbage paths from wroteFiles checkpoint entries', () => {
    expect(
      wroteFilesFromEvents([
        {
          at: 't',
          event: {
            type: 'writes_checkpoint',
            files: [
              { path: 'package.json', action: 'created', undoable: true },
              { path: 'Directory', action: 'created', undoable: true },
              { path: 'src/config,src/llm,src/memory', action: 'created', undoable: true },
              { path: '$env:TEMP/ext.ps1', action: 'created', undoable: true },
              { path: '=', action: 'created', undoable: true },
              { path: 'f1.confidence)', action: 'modified', undoable: true },
              { path: 'src/utils/paths.js', action: 'created', undoable: true }
            ]
          }
        }
      ])
    ).toEqual(['package.json', 'src/utils/paths.js'])
  })

  it('drops .NET bin/Debug checkpoint paths from wroteFiles', () => {
    expect(
      wroteFilesFromEvents([
        {
          at: 't',
          event: {
            type: 'writes_checkpoint',
            files: [
              { path: 'src/App.cs', action: 'modified', undoable: true },
              {
                path:
                  'murmur-youtube-main/windows/src/Murmur.App/bin/Debug/net10.0/Murmur.App.dll',
                action: 'created',
                undoable: false
              },
              { path: 'windows/src/Foo/obj/Debug/Foo.pdb', action: 'created', undoable: false }
            ]
          }
        }
      ])
    ).toEqual(['src/App.cs'])
  })

  it('keeps cumulative metrics but scopes outcome fields to the latest invocation', () => {
    const receipt = buildRunReceipt({
      runId: 'resumed',
      status: {
        status: 'done',
        step: 4,
        updatedAt: new Date().toISOString(),
        invokeId: 2
      },
      messages: [
        { role: 'assistant', content: 'Task complete.' },
        { role: 'user', content: 'continue' },
        { role: 'assistant', content: 'I found a remaining blocker.' }
      ],
      events: [
        {
          at: 'old',
          event: {
            type: 'incomplete',
            runId: 'resumed',
            invokeId: 1,
            reason: 'truncated',
            message: 'old turn'
          }
        },
        {
          at: 'new',
          event: {
            type: 'step_usage',
            runId: 'resumed',
            invokeId: 2,
            step: 4,
            inputTokens: 10,
            outputTokens: 2
          }
        }
      ],
      contract: '',
    })

    expect(receipt.incomplete).toBeUndefined()
    expect(receipt.tokenUsage).toEqual({
      inputTokens: 10,
      billedInputTokens: 10,
      peakInputTokens: 10,
      outputTokens: 2
    })
    expect(receipt.invokeId).toBe(2)
  })

  it('normalizes em/en dashes and mojibake in failureClusters', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        toolCallId: 'e1',
        toolName: 'edit',
        ok: false,
        content: 'aborted — no files'
      },
      {
        role: 'tool',
        toolCallId: 'e2',
        toolName: 'edit',
        ok: false,
        content: 'aborted â€" no files'
      },
      {
        role: 'tool',
        toolCallId: 'e3',
        toolName: 'edit',
        ok: false,
        content: 'aborted – no files'
      }
    ]
    const receipt = buildRunReceipt({
      runId: 'dash',
      status: {
        status: 'error',
        step: 1,
        updatedAt: new Date().toISOString(),
        invokeId: 3
      },
      messages,
      events: [],
      contract: ''
    })
    expect(receipt.invokeId).toBe(3)
    expect(receipt.failureClusters).toEqual([
      { key: 'edit: aborted - no files', count: 3 }
    ])
  })

  it('clusters terminal session-poll failures without unique session_id keys', () => {
    const body = (sessionId: string): string =>
      [
        `session_id: ${sessionId}`,
        'status: done',
        'command: pnpm exec vitest run tests/main/unit/foo.test.ts',
        'cwd: C:/ws',
        'shell: powershell',
        '',
        'stderr:',
        'FAIL',
        'exit_code: 1'
      ].join('\n')
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        toolCallId: 't1',
        toolName: 'terminal',
        ok: false,
        content: body('4ed64741-7158-4627-90b7-c8cec0c281ce')
      },
      {
        role: 'tool',
        toolCallId: 't2',
        toolName: 'terminal',
        ok: false,
        content: body('c9e70b7f-55f8-4f54-8fcd-c3375adb5fc6')
      }
    ]
    const receipt = buildRunReceipt({
      runId: 'term-cluster',
      status: { status: 'done', step: 1, updatedAt: new Date().toISOString() },
      messages,
      events: [],
      contract: ''
    })
    expect(receipt.toolStats.failed).toBe(2)
    expect(receipt.failureClusters).toEqual([
      {
        key: 'terminal: exit 1 · status done · pnpm exec vitest run tests/main/unit/foo.test.ts',
        count: 2
      }
    ])
    expect(receipt.failureClusters[0]?.key).not.toMatch(/session_id/)
    expect(receipt.failureClusters[0]?.key).not.toMatch(
      /4ed64741-7158-4627-90b7-c8cec0c281ce|c9e70b7f-55f8-4f54-8fcd-c3375adb5fc6/
    )
  })

  it('clusters edit diff mismatches without unique line-number keys', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        toolCallId: 'e1',
        toolName: 'edit',
        ok: false,
        content:
          'Diff hunk failed to match near line 150 (context/removal mismatch).\nExpected:\n  "import"'
      },
      {
        role: 'tool',
        toolCallId: 'e2',
        toolName: 'edit',
        ok: false,
        content:
          'Diff hunk failed to match near line 424 (context/removal mismatch).\nExpected:\n  " )"'
      },
      {
        role: 'tool',
        toolCallId: 's1',
        toolName: 'str_replace',
        ok: false,
        content:
          'old_string not found in src/main/agent/loopPolicy.ts. Closest match near line 8:'
      }
    ]
    const receipt = buildRunReceipt({
      runId: 'edit-cluster',
      status: { status: 'done', step: 1, updatedAt: new Date().toISOString() },
      messages,
      events: [],
      contract: ''
    })
    expect(receipt.failureClusters).toEqual([
      { key: 'edit: Diff hunk failed to match (context/removal mismatch)', count: 2 },
      { key: 'str_replace: old_string not found', count: 1 }
    ])
  })

  it('clusters path-escape failures without the scrubbed basename', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        toolCallId: 'r1',
        toolName: 'read',
        ok: false,
        content: 'Path escapes workspace: vyotiq'
      },
      {
        role: 'tool',
        toolCallId: 'r2',
        toolName: 'read',
        ok: false,
        content:
          'Path escapes workspace: requested path is outside the workspace root. Use a workspace-relative path; absolute home, AppData, and other-drive paths are rejected.'
      }
    ]
    const receipt = buildRunReceipt({
      runId: 'escape-cluster',
      status: { status: 'done', step: 1, updatedAt: new Date().toISOString() },
      messages,
      events: [],
      contract: ''
    })
    expect(receipt.failureClusters).toEqual([
      { key: 'read: Path escapes workspace (outside workspace root)', count: 2 }
    ])
  })

  it('treats concrete grep/glob as seen for unread edits', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'g1', name: 'grep', arguments: '{"pattern":"x","include":"seen.ts"}' },
          { id: 'e1', name: 'str_replace', arguments: '{"path":"seen.ts"}' },
          { id: 'e2', name: 'edit', arguments: '{"path":"other.ts"}' }
        ]
      },
      { role: 'tool', toolCallId: 'g1', toolName: 'grep', ok: true, content: 'match' },
      { role: 'tool', toolCallId: 'e1', toolName: 'str_replace', ok: true, content: 'updated' },
      { role: 'tool', toolCallId: 'e2', toolName: 'edit', ok: true, content: 'updated' }
    ]
    const receipt = buildRunReceipt({
      runId: 'r',
      status: { status: 'done', step: 1, updatedAt: new Date().toISOString() },
      messages,
      events: [],
      contract: '',
    })
    expect(receipt.unreadEditPaths).not.toContain('seen.ts')
    expect(receipt.unreadEditPaths).toContain('other.ts')
  })

  it('does not treat Plan-mode denials as unread-before-edit', () => {
    const deny =
      'Plan mode may only edit plan.md or contract.md (run plan artifacts). Call `switch_mode` with mode "agent" to edit product code.'
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'e1',
            name: 'edit',
            arguments: '{"path":".vyotiq/memory/index.md","contents":"x"}'
          }
        ]
      },
      { role: 'tool', toolCallId: 'e1', toolName: 'edit', ok: false, content: deny }
    ]
    const receipt = buildRunReceipt({
      runId: 'plan-unread',
      status: { status: 'done', step: 1, updatedAt: new Date().toISOString() },
      messages,
      events: [],
      contract: ''
    })
    expect(receipt.unreadEditPaths).toEqual([])
  })

  it('omits Cancelled stubs from tool stats, failure clusters, and streaks', () => {
    const messages: ChatMessage[] = [
      { role: 'tool', toolCallId: 'a', toolName: 'edit', ok: false, content: 'boom' },
      { role: 'tool', toolCallId: 'b', toolName: 'terminal', ok: false, content: 'Cancelled' },
      { role: 'tool', toolCallId: 'c', toolName: 'edit', ok: false, content: 'boom' }
    ]
    const receipt = buildRunReceipt({
      runId: 'cancel-cluster',
      status: { status: 'done', step: 1, updatedAt: new Date().toISOString() },
      messages,
      events: [],
      contract: ''
    })
    expect(receipt.toolStats.failed).toBe(2)
    expect(receipt.toolStats.byName.terminal).toBeUndefined()
    expect(receipt.failureClusters).toEqual([{ key: 'edit: boom', count: 2 }])
    expect(receipt.maxConsecutiveToolFailures).toBe(1)
  })

  it('excludes approval / mode gate refusals from tool stats, clusters, and streaks', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        toolCallId: 'g1',
        toolName: 'terminal',
        ok: false,
        content:
          'The user denied permission to run terminal. Do not retry it; ask what to do instead or continue without it.'
      },
      {
        role: 'tool',
        toolCallId: 'g2',
        toolName: 'git_commit',
        ok: false,
        content:
          'Tool approval for git_commit timed out and was auto-denied. Do not retry it; ask what to do instead or continue without it.'
      },
      {
        role: 'tool',
        toolCallId: 'g3',
        toolName: 'edit',
        ok: false,
        content:
          'Tool approval required but no app window is listening. Reopen Vyotiq and retry, or turn off tool approval in Settings → Tools.'
      },
      {
        role: 'tool',
        toolCallId: 'g4',
        toolName: 'terminal',
        ok: false,
        content:
          'Ask mode does not allow tool "terminal". Switch to Agent mode (composer) to run commands.'
      },
      {
        role: 'tool',
        toolCallId: 'g5',
        toolName: 'edit',
        ok: false,
        content:
          'Plan mode may only edit plan.md or contract.md (run plan artifacts). Call `switch_mode` with mode "agent" to edit product code.'
      },
      { role: 'tool', toolCallId: 'x', toolName: 'edit', ok: false, content: 'real failure' }
    ]
    const receipt = buildRunReceipt({
      runId: 'gate-refusals',
      status: { status: 'error', step: 2, updatedAt: new Date().toISOString() },
      messages,
      events: [],
      contract: ''
    })
    // Only the real failure counts — never-executed calls are usage, not failures.
    expect(receipt.toolStats.totalCalls).toBe(1)
    expect(receipt.toolStats.failed).toBe(1)
    expect(receipt.toolStats.ok).toBe(0)
    expect(receipt.toolStats.byName).toEqual({ edit: { ok: 0, failed: 1 } })
    expect(receipt.failureClusters).toEqual([{ key: 'edit: real failure', count: 1 }])
    expect(receipt.maxConsecutiveToolFailures).toBe(1)
  })

  it('skipped run_tests and errored checks do not count as verification', () => {
    const base = { status: 'done' as const, step: 2, updatedAt: new Date().toISOString() }
    // Skip result (ok=true, no runner) must not stamp a verified check.
    const skipped = buildRunReceipt({
      runId: 'skip-check',
      status: base,
      messages: [],
      events: [
        {
          at: '2026-09-03T10:00:00.000Z',
          event: {
            type: 'writes_checkpoint',
            runId: 'skip-check',
            files: [{ path: 'a.ts', action: 'modified', undoable: true }]
          }
        },
        {
          at: '2026-09-03T10:01:00.000Z',
          event: {
            type: 'tool_result',
            runId: 'skip-check',
            toolCallId: 't1',
            name: 'run_tests',
            summary: 'skipped',
            ok: true,
            content:
              'No test runner detected (no package.json test script); tests skipped. Pass an explicit sandboxed `command` to run project tests.'
          }
        }
      ],
      contract: ''
    })
    expect(skipped.verification?.lastCheckAt).toBeUndefined()
    expect(skipped.verification?.verifiedAfterLastMutation).toBe(false)

    // A check that reported errors is a failed verification, not a pass.
    const errored = buildRunReceipt({
      runId: 'errored-check',
      status: base,
      messages: [],
      events: [
        {
          at: '2026-09-03T10:00:00.000Z',
          event: {
            type: 'writes_checkpoint',
            runId: 'errored-check',
            files: [{ path: 'a.ts', action: 'modified', undoable: true }]
          }
        },
        {
          at: '2026-09-03T10:01:00.000Z',
          event: {
            type: 'tool_result',
            runId: 'errored-check',
            toolCallId: 'd1',
            name: 'diagnostics',
            summary: 'typecheck',
            ok: true,
            content: 'src/a.ts(1,1): error TS2304: Cannot find name x'
          }
        }
      ],
      contract: ''
    })
    expect(errored.verification?.verifiedAfterLastMutation).toBe(false)

    // A clean check after the mutation still verifies.
    const clean = buildRunReceipt({
      runId: 'clean-check',
      status: base,
      messages: [],
      events: [
        {
          at: '2026-09-03T10:00:00.000Z',
          event: {
            type: 'writes_checkpoint',
            runId: 'clean-check',
            files: [{ path: 'a.ts', action: 'modified', undoable: true }]
          }
        },
        {
          at: '2026-09-03T10:01:00.000Z',
          event: {
            type: 'tool_result',
            runId: 'clean-check',
            toolCallId: 'd1',
            name: 'diagnostics',
            summary: 'typecheck',
            ok: true,
            content: 'No diagnostics found.'
          }
        }
      ],
      contract: ''
    })
    expect(clean.verification?.verifiedAfterLastMutation).toBe(true)
  })

  it('aggregates run_tests calls and the latest pass/fail summary', () => {
    const receipt = buildRunReceipt({
      runId: 'tests-agg',
      status: { status: 'done', step: 2, updatedAt: new Date().toISOString() },
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'run_tests', arguments: '{}' }]
        },
        {
          role: 'tool',
          toolCallId: 't1',
          toolName: 'run_tests',
          ok: false,
          content: 'command: pnpm test\nexit: 1\nTests: 18 passed, 2 failed (exit 1)\noutput'
        },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't2', name: 'run_tests', arguments: '{}' }]
        },
        {
          role: 'tool',
          toolCallId: 't2',
          toolName: 'run_tests',
          ok: true,
          content: 'command: pnpm test\nTests: 20 passed, 0 failed (exit 0)\noutput'
        }
      ],
      events: [],
      contract: ''
    })
    expect(receipt.tests).toEqual({
      calls: 2,
      ok: 1,
      failed: 1,
      lastPassed: 20,
      lastFailed: 0
    })
    expect(RunReceiptSchema.parse(receipt).tests?.lastPassed).toBe(20)
  })

  it('omits the tests aggregate when run_tests was never called', () => {
    const receipt = buildRunReceipt({
      runId: 'no-tests',
      status: { status: 'done', step: 1, updatedAt: new Date().toISOString() },
      messages: [{ role: 'assistant', content: 'done' }],
      events: [],
      contract: ''
    })
    expect(receipt.tests).toBeUndefined()
  })

  it('computes the verification signal from checks vs mutations', () => {
    const base = { status: 'done' as const, step: 1, updatedAt: new Date().toISOString() }
    // Check AFTER mutation → verified.
    const verified = buildRunReceipt({
      runId: 'v1',
      status: base,
      messages: [],
      events: [
        {
          at: '2026-09-03T10:00:00.000Z',
          event: {
            type: 'writes_checkpoint',
            runId: 'v1',
            files: [{ path: 'a.ts', action: 'modified', undoable: true }]
          }
        },
        {
          at: '2026-09-03T10:01:00.000Z',
          event: {
            type: 'tool_result',
            runId: 'v1',
            toolCallId: 'd1',
            name: 'diagnostics',
            summary: '0 problems',
            ok: true
          }
        }
      ],
      contract: ''
    })
    expect(verified.verification).toEqual({
      lastMutationAt: '2026-09-03T10:00:00.000Z',
      lastCheckAt: '2026-09-03T10:01:00.000Z',
      verifiedAfterLastMutation: true
    })

    // Mutation AFTER check → stale.
    const stale = buildRunReceipt({
      runId: 'v2',
      status: base,
      messages: [],
      events: [
        {
          at: '2026-09-03T10:00:00.000Z',
          event: {
            type: 'tool_result',
            runId: 'v2',
            toolCallId: 'd1',
            name: 'run_tests',
            summary: 'ok',
            ok: true
          }
        },
        {
          at: '2026-09-03T10:02:00.000Z',
          event: {
            type: 'writes_checkpoint',
            runId: 'v2',
            files: [{ path: 'b.ts', action: 'modified', undoable: true }]
          }
        }
      ],
      contract: ''
    })
    expect(stale.verification?.verifiedAfterLastMutation).toBe(false)

    // Neither checks nor mutations → signal omitted.
    const none = buildRunReceipt({
      runId: 'v3',
      status: base,
      messages: [],
      events: [],
      contract: ''
    })
    expect(none.verification).toBeUndefined()
  })

  it('writes receipt.json atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-receipt-'))
    try {
      const receipt = buildRunReceipt({
        runId: 'r',
        status: {
          status: 'cancelled',
          step: 0,
          updatedAt: new Date().toISOString()
        },
        messages: [],
        events: [],
        contract: '',
      })
      writeRunReceipt(dir, receipt)
      const raw = JSON.parse(readFileSync(join(dir, RUN_RECEIPT_FILENAME), 'utf8'))
      expect(raw.runId).toBe('r')
      expect(raw.status).toBe('cancelled')
      expect(raw.version).toBe(RUN_RECEIPT_VERSION)
      expect(raw.compactionCount).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })



  it('keeps latest step inputTokens and sums outputTokens across steps', () => {
    const receipt = buildRunReceipt({
      runId: 'multi-step',
      status: { status: 'done', step: 2, updatedAt: new Date().toISOString() },
      messages: [{ role: 'assistant', content: 'done' }],
      events: [
        {
          at: 't1',
          event: {
            type: 'step_usage',
            runId: 'multi-step',
            step: 1,
            inputTokens: 1000,
            outputTokens: 50
          }
        },
        {
          at: 't2',
          event: {
            type: 'step_usage',
            runId: 'multi-step',
            step: 2,
            inputTokens: 1500,
            outputTokens: 30
          }
        }
      ],
      contract: ''
    })
    // Latest window size vs cumulative billed input across steps.
    expect(receipt.tokenUsage).toEqual({
      inputTokens: 1500,
      billedInputTokens: 2500,
      peakInputTokens: 1500,
      outputTokens: 80
    })
  })

  it('sums billed input across resume even when later events carry lower process-local billed totals', () => {
    const receipt = buildRunReceipt({
      runId: 'resume-bill',
      status: { status: 'done', step: 3, updatedAt: new Date().toISOString() },
      messages: [{ role: 'assistant', content: 'done' }],
      events: [
        {
          at: 't1',
          event: {
            type: 'step_usage',
            runId: 'resume-bill',
            step: 1,
            inputTokens: 1000,
            outputTokens: 10,
            billedInputTokens: 1000
          }
        },
        {
          at: 't2',
          event: {
            type: 'step_usage',
            runId: 'resume-bill',
            step: 2,
            inputTokens: 2000,
            outputTokens: 10,
            billedInputTokens: 3000
          }
        },
        // After resume, emitter restarts process-local billed at this step only.
        {
          at: 't3',
          event: {
            type: 'step_usage',
            runId: 'resume-bill',
            step: 3,
            inputTokens: 500,
            outputTokens: 5,
            billedInputTokens: 500
          }
        }
      ],
      contract: ''
    })
    expect(receipt.tokenUsage).toEqual({
      inputTokens: 500,
      billedInputTokens: 3500,
      peakInputTokens: 2000,
      outputTokens: 25
    })
  })
})
