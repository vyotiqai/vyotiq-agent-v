import { describe, it, expect } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import {
  WorkspaceAgentContextRequestSchema,
  WorkspaceAgentContextResultSchema
} from '@shared/ipc'
import {
  buildWorkspaceAgentContext,
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
      rules: { agentsMd: true, cursorrules: false, vyotiqRulesCount: 2 },
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
        rules: { agentsMd: true, cursorrules: false, vyotiqRulesCount: -1 }
      })
    ).toThrow()
  })

  it('detects AGENTS.md / .cursorrules and counts vyotiq rule files', async () => {
    const dir = await makeWorkspace({
      'AGENTS.md': '# rules\n',
      '.cursorrules': 'use tabs\n',
      '.vyotiq/rules/a.md': 'rule a\n',
      '.vyotiq/rules/sub/b.md': 'rule b\n'
    })
    const ctx = await buildWorkspaceAgentContext(dir, { enabled: true, phase: 'ready' })
    expect(ctx.rules.agentsMd).toBe(true)
    expect(ctx.rules.cursorrules).toBe(true)
    expect(ctx.rules.vyotiqRulesCount).toBe(2)
    await expect(WorkspaceAgentContextResultSchema.parseAsync(ctx)).resolves.toEqual(ctx)
  })

  it('returns neutral values for an empty workspace', async () => {
    const dir = await makeWorkspace({})
    const ctx = await buildWorkspaceAgentContext(dir, { enabled: false, phase: 'idle' })
    expect(ctx.rules).toEqual({ agentsMd: false, cursorrules: false, vyotiqRulesCount: 0 })
    expect(ctx.memoryNotes).toBe(0)
    expect(ctx.codeIndex.state).toBe('off')
  })

  it('counts .md memory files under .vyotiq/memory', async () => {
    const dir = await makeWorkspace({
      '.vyotiq/memory/index.md': '# Memory index\n',
      '.vyotiq/memory/state.md': 'state\n',
      '.vyotiq/memory/notes/one.md': 'one\n'
    })
    const ctx = await buildWorkspaceAgentContext(dir, { enabled: true, phase: 'ready' })
    expect(ctx.memoryNotes).toBe(3)
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
