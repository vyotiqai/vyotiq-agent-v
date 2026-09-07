import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assembleContext, clearSystemPromptCache } from '@main/agent/context/assemble'
import { ensureMemoryLayout } from '@main/agent/context/memory'
import { clearWorkspaceSnapshotCache } from '@main/agent/context/workspaceSnapshot'
import type { LlmProvider } from '@main/agent/providers/types'

const mockProvider: LlmProvider = {
  id: 'ollama',
  listModels: async () => [],
  streamChat: async function* () {
    yield { type: 'done' }
  }
}

const model = {
  id: 'test',
  inputModalities: ['text'] as const,
  outputModalities: ['text'] as const,
  supportsTools: true,
  supportsVision: false,
  contextWindow: 100_000
}

describe('assemble memory workspace seam', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs.length = 0
    clearSystemPromptCache()
    clearWorkspaceSnapshotCache()
  })

  const mkWorkspace = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'vyotiq-assemble-mem-'))
    dirs.push(d)
    return d
  }

  const assemble = (workspacePath: string | null, memoryWorkspacePath?: string | null) =>
    assembleContext({
      harness: '## Role\nAgent',
      messages: [{ role: 'user', content: 'go' }],
      workspacePath,
      memoryWorkspacePath,
      goal: 'go',
      model,
      toolsJsonEstimate: 50,
      providerId: 'ollama',
      provider: mockProvider,
      signal: new AbortController().signal
    })

  it('reads memory from memoryWorkspacePath while the workspace snapshot stays on workspacePath', async () => {
    const parent = mkWorkspace()
    ensureMemoryLayout(parent)
    writeFileSync(
      join(parent, '.vyotiq', 'memory', 'index.md'),
      'MEMORY_FROM_PARENT_MARKER\n',
      'utf8'
    )
    writeFileSync(join(parent, '.vyotiq', 'memory', 'state.md'), 'PARENT_STATE_MARKER\n', 'utf8')
    // Sparse worktree checkout: no .vyotiq, but top-level files feed the snapshot.
    const worktree = mkWorkspace()
    writeFileSync(join(worktree, 'WT_TOP_MARKER.md'), 'worktree file\n', 'utf8')

    const result = await assemble(worktree, parent)
    // Memory section is built from the parent workspace.
    expect(result.systemStable).toContain('<memory>')
    expect(result.systemStable).toContain('MEMORY_FROM_PARENT_MARKER')
    expect(result.systemStable).toContain('PARENT_STATE_MARKER')
    // Workspace snapshot is built from the worktree, not the parent.
    expect(result.systemVolatile).toContain('<workspace>')
    expect(result.systemVolatile).toContain('WT_TOP_MARKER')
    expect(result.systemVolatile).not.toContain('MEMORY_FROM_PARENT_MARKER')
    expect(result.systemStable).not.toContain('WT_TOP_MARKER')
  })

  it('defaults memory reads to workspacePath when memoryWorkspacePath is omitted (root runs)', async () => {
    const workspace = mkWorkspace()
    ensureMemoryLayout(workspace)
    writeFileSync(
      join(workspace, '.vyotiq', 'memory', 'index.md'),
      'MEMORY_DEFAULT_SEAM_MARKER\n',
      'utf8'
    )

    const result = await assemble(workspace)
    expect(result.systemStable).toContain('<memory>')
    expect(result.systemStable).toContain('MEMORY_DEFAULT_SEAM_MARKER')
  })

  it('injects no memory section when the workspace has none (identical legacy behavior)', async () => {
    const worktree = mkWorkspace()
    writeFileSync(join(worktree, 'WT_ONLY.md'), 'x\n', 'utf8')

    const result = await assemble(worktree)
    expect(result.system).not.toContain('<memory>')
    expect(existsSync(join(worktree, '.vyotiq'))).toBe(false)
  })
})
