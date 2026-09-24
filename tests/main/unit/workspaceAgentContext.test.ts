import { describe, it, expect } from 'vitest'
import { mkdir, mkdtemp, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import {
  WorkspaceAgentContextRequestSchema,
  WorkspaceAgentContextResultSchema
} from '@shared/ipc'
import {
  buildWorkspaceAgentContext,
  codeIndexStateFor,
  mapCodeIndexState
} from '@main/agent/context/agentContext'

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentctx-'))
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, content, 'utf8')
  }
  return dir
}

describe('workspace:agentContext', () => {
  it('validates the request and result schemas', () => {
    expect(WorkspaceAgentContextRequestSchema.parse({ workspacePath: 'C:/repo' })).toEqual({
      workspacePath: 'C:/repo'
    })
    expect(() => WorkspaceAgentContextRequestSchema.parse({})).toThrow()

    const valid = {
      workspaceName: 'repo',
      branch: 'main',
      rules: { agentsMd: true, claudeMd: false, cursorrules: false, ruleFileCount: 2 },
      memoryNotes: 3,
      codeIndex: { state: 'ready' }
    }
    expect(WorkspaceAgentContextResultSchema.parse(valid)).toEqual(valid)
    expect(() =>
      WorkspaceAgentContextResultSchema.parse({ ...valid, codeIndex: { state: 'unknown' } })
    ).toThrow()
    expect(() =>
      WorkspaceAgentContextResultSchema.parse({
        ...valid,
        rules: { agentsMd: true, claudeMd: false, cursorrules: false, ruleFileCount: -1 }
      })
    ).toThrow()
  })

  it('reports every rule source the prompt injects, including CLAUDE.md and .cursor/rules', async () => {
    const dir = await makeWorkspace({
      'AGENTS.md': '# rules\n',
      'CLAUDE.md': '# more rules\n',
      '.cursorrules': 'use tabs\n',
      '.vyotiq/rules/a.md': 'rule a\n',
      '.vyotiq/rules/sub/b.md': 'rule b\n',
      '.cursor/rules/c.mdc': 'rule c\n'
    })
    const ctx = await buildWorkspaceAgentContext(dir, { enabled: true, phase: 'ready' })
    expect(ctx.rules.agentsMd).toBe(true)
    expect(ctx.rules.claudeMd).toBe(true)
    expect(ctx.rules.cursorrules).toBe(true)
    // Both rule directories, nested files included — rules.ts injects all three.
    expect(ctx.rules.ruleFileCount).toBe(3)
    await expect(WorkspaceAgentContextResultSchema.parseAsync(ctx)).resolves.toEqual(ctx)
  })

  it('does not count a rule the prompt would skip (alwaysApply: false)', async () => {
    const dir = await makeWorkspace({
      '.vyotiq/rules/always.md': 'always\n',
      '.vyotiq/rules/opt-in.md': '---\nalwaysApply: false\n---\nonly on request\n'
    })
    const ctx = await buildWorkspaceAgentContext(dir, { enabled: true, phase: 'ready' })
    expect(ctx.rules.ruleFileCount).toBe(1)
  })

  it('returns neutral values for an empty workspace', async () => {
    const dir = await makeWorkspace({})
    const ctx = await buildWorkspaceAgentContext(dir, { enabled: false, phase: 'idle' })
    expect(ctx.rules).toEqual({
      agentsMd: false,
      claudeMd: false,
      cursorrules: false,
      ruleFileCount: 0
    })
    expect(ctx.memoryNotes).toBe(0)
    expect(ctx.codeIndex.state).toBe('off')
  })

  it('counts and names the notes, newest first — not the memory index or state', async () => {
    const dir = await makeWorkspace({
      '.vyotiq/memory/index.md': '# Memory index\n',
      '.vyotiq/memory/state.md': 'state\n',
      '.vyotiq/memory/notes/one.md': 'one\n',
      '.vyotiq/memory/notes/two.md': 'two\n'
    })
    const old = new Date('2026-01-01T00:00:00Z')
    await utimes(join(dir, '.vyotiq/memory/notes/one.md'), old, old)
    const ctx = await buildWorkspaceAgentContext(dir, { enabled: true, phase: 'ready' })
    expect(ctx.memoryNotes).toBe(2)
    expect(ctx.memoryNoteNames).toEqual(['two', 'one'])
    await expect(WorkspaceAgentContextResultSchema.parseAsync(ctx)).resolves.toEqual(ctx)
  })

  it('reads the index phase only for the workspace the status names', async () => {
    const dir = await makeWorkspace({})
    const own = await buildWorkspaceAgentContext(dir, { enabled: true, phase: 'syncing', statusWorkspace: dir })
    expect(own.codeIndex.state).toBe('building')
    // Another workspace's sync says nothing about this one, which was never indexed.
    const other = await buildWorkspaceAgentContext(dir, {
      enabled: true,
      phase: 'syncing',
      statusWorkspace: join(dir, 'elsewhere')
    })
    expect(other.codeIndex.state).toBe('off')
    expect(other.codeIndex.files).toBeUndefined()
  })

  it('answers from the workspace\'s own index when the status names another', () => {
    const idle = { enabled: true, phase: 'syncing' as const, statusWorkspace: 'C:/other' }
    expect(codeIndexStateFor('C:/repo', idle, { files: 120, indexedAt: '2026-09-24T09:00:00.000Z' })).toBe('ready')
    expect(codeIndexStateFor('C:/repo', idle, { files: 0, indexedAt: null })).toBe('off')
    expect(codeIndexStateFor('C:/repo', idle, null)).toBe('off')
    expect(codeIndexStateFor('C:/repo', { ...idle, statusWorkspace: 'C:/repo' }, null)).toBe('building')
    expect(codeIndexStateFor('C:/repo', { ...idle, enabled: false, statusWorkspace: 'C:/repo' }, null)).toBe('off')
  })

  it('returns branch null and the basename outside a git repo', async () => {
    const dir = await makeWorkspace({ 'README.md': 'hi\n' })
    const ctx = await buildWorkspaceAgentContext(dir, { enabled: true, phase: 'ready' })
    expect(ctx.branch).toBeNull()
    expect(ctx.workspaceName).toBe(basename(dir))
  })

  it('maps code-index runtime phases to card states', () => {
    expect(mapCodeIndexState('ready', true)).toBe('ready')
    expect(mapCodeIndexState('syncing', true)).toBe('building')
    expect(mapCodeIndexState('error', true)).toBe('degraded')
    expect(mapCodeIndexState('idle', true)).toBe('off')
    for (const phase of ['idle', 'ready', 'syncing', 'error'] as const) {
      expect(mapCodeIndexState(phase, false)).toBe('off')
    }
  })
})
