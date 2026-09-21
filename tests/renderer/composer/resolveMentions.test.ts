/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { resolveComposerMentions } from '@renderer/features/chat/components/composer/resolveMentions'
import { mentionMarker } from '@renderer/features/chat/components/composer/mentionModel'

describe('resolveComposerMentions', () => {
  beforeEach(() => {
    window.vyotiq = {
      workspaceReadText: vi.fn(async ({ path }: { path: string }) => ({
        ok: true as const,
        data: {
          name: path,
          mime: 'text/plain',
          text: `content of ${path}`,
          truncated: false
        }
      })),
      gitStatus: vi.fn(async () => ({
        ok: true as const,
        data: {
          kind: 'ok' as const,
          status: {
          branch: 'main',
          files: [],
          truncated: false,
          fileCount: 0,
          added: 0,
          removed: 0,
          hasRemote: false,
          hasCommits: true
          }
        }
      })),
      gitDiff: vi.fn(async () => ({
        ok: true as const,
        data: { content: 'diff --git a/x' }
      })),
      loadRun: vi.fn(async () => ({
        ok: true as const,
        data: {
          runId: 'r1',
          messages: [{ role: 'user', content: 'earlier goal' }]
        }
      })),
      workspaceDiagnostics: vi.fn(async ({ kind }: { kind?: string }) => ({
        ok: true as const,
        data: {
          ok: true,
          kind: (kind === 'lint' ? 'lint' : 'typecheck') as 'lint' | 'typecheck',
          content:
            kind === 'lint'
              ? 'command: eslint\ndiagnostics: 1\n\nsrc/y.ts:2:1: error: lint-boom'
              : 'command: tsc\ndiagnostics: 1\n\nsrc/x.ts:1:1: error: boom'
        }
      })),
      browserGetState: vi.fn(async () => ({
        ok: true as const,
        data: {
          open: true,
          url: 'https://example.com/app',
          title: 'App',
          navigating: false,
          tabs: []
        }
      })),
      readRunArtifact: vi.fn(async () => ({
        ok: false as const,
        error: 'missing'
      }))
    }
  })

  it('attaches file mentions and strips markers from user text', async () => {
    const draft = `Please review ${mentionMarker({ kind: 'file', path: 'src/a.ts' })}`
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft,
      existingFiles: []
    })
    expect(result.text).toContain('Please review')
    expect(result.text).not.toContain('\uFFF9')
    expect(result.files).toEqual([
      {
        type: 'file',
        name: 'src/a.ts',
        mime: 'text/plain',
        text: 'content of src/a.ts'
      }
    ])
    expect(result.error).toBeNull()
  })

  it('injects branch and browser context blocks', async () => {
    const draft = [
      'go',
      mentionMarker({ kind: 'branch', branch: 'main' }),
      mentionMarker({ kind: 'browser' })
    ].join(' ')
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft,
      existingFiles: []
    })
    expect(result.text).toContain('Referenced branch diff')
    expect(result.text).toContain('diff --git')
    expect(result.text).toContain('Prefer browser_* tools')
    expect(result.text).toContain('https://example.com/app')
    expect(result.text).toContain('Referenced browser')
    expect(result.images).toEqual([])
  })

  it('attaches the latest browser snapshot when @ Browser resolves with a run', async () => {
    const jpeg = 'data:image/jpeg;base64,QQ=='
    ;(window.vyotiq.readRunArtifact as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true as const,
      data: { name: 'browser/snapshot.jpg', exists: true, content: jpeg }
    })
    const draft = mentionMarker({ kind: 'browser' })
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      runId: 'run-1',
      draft,
      existingFiles: []
    })
    expect(result.images).toEqual([jpeg])
    expect(result.text).toContain('Screenshot: attached browser/snapshot.jpg')
    expect(window.vyotiq.readRunArtifact).toHaveBeenCalledWith({
      workspacePath: '/ws',
      runId: 'run-1',
      name: 'browser/snapshot.jpg'
    })
  })

  it('injects past chat excerpt', async () => {
    const draft = mentionMarker({ kind: 'chat', runId: 'r1', title: 'Prior' })
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft,
      existingFiles: []
    })
    expect(result.text).toContain('Referenced past chat')
    expect(result.text).toContain('earlier goal')
  })

  it('rejects file mentions outside the selected workspace', async () => {
    const draft = [
      mentionMarker({ kind: 'file', path: 'src/ok.ts' }),
      // Absolute / escape payloads must not be decoded as file mentions —
      // also guard resolve if they somehow appear.
    ].join(' ')
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft,
      existingFiles: []
    })
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.name).toBe('src/ok.ts')

    // Simulate an unsafe path reaching resolve (bypass decode)
    const unsafe = await resolveComposerMentions({
      workspacePath: '/ws',
      draft: '\uFFF9file:../secret\uFFFA',
      existingFiles: []
    })
    // decode drops unsafe markers → no file attach
    expect(unsafe.files).toHaveLength(0)
    expect(window.vyotiq.workspaceReadText).toHaveBeenCalledTimes(1)
  })

  it('resolves docs, rules, and lints mentions', async () => {
    ;(window.vyotiq.workspaceReadText as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ path }: { path: string }) => ({
        ok: true as const,
        data: {
          name: path,
          mime: 'text/plain',
          text:
            path.includes('rules')
              ? '---\nalwaysApply: false\ndescription: Test\n---\nRule body here'
              : `doc body ${path}`,
          truncated: false
        }
      })
    )

    const draft = [
      mentionMarker({ kind: 'docs', path: 'docs/a.md' }),
      mentionMarker({ kind: 'rule', path: '.cursor/rules/x.mdc' }),
      mentionMarker({ kind: 'lints', diagnosticsKind: 'typecheck' })
    ].join(' ')

    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft,
      existingFiles: []
    })
    expect(result.files.some((f) => f.name === 'docs/a.md')).toBe(true)
    expect(result.text).toContain('Referenced documentation')
    expect(result.text).toContain('Referenced rule: .cursor/rules/x.mdc')
    expect(result.text).toContain('Rule body here')
    expect(result.text).not.toContain('alwaysApply')
    expect(result.text).toContain('Referenced diagnostics (typecheck)')
    expect(result.text).toContain('src/x.ts:1:1')
    expect(result.error).toBeNull()
  })

  it('pointers auto-injected rules instead of re-pasting the body', async () => {
    window.vyotiq.workspaceReadText = vi.fn(async ({ path }: { path: string }) => ({
      ok: true as const,
      data: {
        name: path,
        mime: 'text/plain',
        text: path === 'AGENTS.md' ? '# Agents\nAlways do X.' : `content of ${path}`,
        truncated: false
      }
    }))
    const draft = mentionMarker({ kind: 'rule', path: 'AGENTS.md' })
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft,
      existingFiles: []
    })
    expect(result.text).toContain('Referenced rule: AGENTS.md')
    expect(result.text).toContain('Already included in the system prompt')
    expect(result.text).not.toContain('Always do X')
    expect(result.error).toBeNull()
  })

  it('resolves lint diagnostics mentions', async () => {
    const draft = mentionMarker({ kind: 'lints', diagnosticsKind: 'lint' })
    const result = await resolveComposerMentions({
      workspacePath: '/ws',
      draft,
      existingFiles: []
    })
    expect(window.vyotiq.workspaceDiagnostics).toHaveBeenCalledWith({
      workspacePath: '/ws',
      kind: 'lint'
    })
    expect(result.text).toContain('Referenced diagnostics (lint)')
    expect(result.text).toContain('lint-boom')
    expect(result.error).toBeNull()
  })

  it('discards results when isCurrent becomes false mid-resolve', async () => {
    let current = true
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    window.vyotiq.workspaceReadText = vi.fn(async ({ path }: { path: string }) => {
      await gate
      return {
        ok: true as const,
        data: {
          name: path,
          mime: 'text/plain',
          text: `content of ${path}`,
          truncated: false
        }
      }
    })

    const pending = resolveComposerMentions({
      workspacePath: '/ws-a',
      draft: `Review ${mentionMarker({ kind: 'file', path: 'src/a.ts' })}`,
      existingFiles: [],
      isCurrent: () => current
    })
    current = false
    release()
    const result = await pending
    expect(result.stale).toBe(true)
    expect(result.files).toEqual([])
    expect(result.images).toEqual([])
    expect(result.text).toBe('')
  })
})
