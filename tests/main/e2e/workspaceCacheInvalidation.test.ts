/**
 * E2E: existing workspace mutation caches — edit .gitignore via executeTool
 * must invalidate gitignore matchers so glob/search see fresh rules.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-e2e-cache-${process.pid}-${Date.now()}`)

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

vi.mock('@main/agent/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/mcp')>()
  return {
    ...actual,
    syncMcpServers: vi.fn(async () => {}),
    listMcpToolDefinitions: () => []
  }
})

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    provider: 'ollama',
    model: 'qwen2.5',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    theme: 'system',
    telemetryEnabled: false,
    autoModeSwitch: false
  }),
  readLegacyWorkspacePath: () => null
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => null,
  hasStoredSecretBlob: () => false,
  secretStatus: () => ({ encryptionAvailable: true, keys: {} })
}))

import { executeTool } from '@main/agent/tools'
import { toolTodoWrite } from '@main/agent/tools/todo'
import { toolGlob } from '@main/agent/tools/glob'
import { clearGitignoreMatcherCache } from '@main/agent/tools/gitignore'
import {
  invalidateGitStatusCache,
  resetGitStatusCacheForTests
} from '@main/git/gitStatusCache'
import { clearWorkspaceSnapshotCache } from '@main/agent/context/workspaceSnapshot'

describe('e2e workspace mutation caches', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-e2e-cache-ws-'))
    mkdirSync(join(workspace, 'hidden'), { recursive: true })
    writeFileSync(join(workspace, 'visible.ts'), 'export const visible = 1\n', 'utf8')
    writeFileSync(join(workspace, 'hidden', 'secret.ts'), 'export const secret = 1\n', 'utf8')
    writeFileSync(join(workspace, '.gitignore'), '', 'utf8')
    toolTodoWrite(workspace, [{ id: '1', content: 'Update .gitignore ignore rules', status: 'in_progress' }])
    clearGitignoreMatcherCache()
    resetGitStatusCacheForTests()
    clearWorkspaceSnapshotCache()
  })

  afterEach(() => {
    clearGitignoreMatcherCache()
    resetGitStatusCacheForTests()
    clearWorkspaceSnapshotCache()
    rmSync(workspace, { recursive: true, force: true })
  })

  it('edit .gitignore via executeTool refreshes ignore rules for glob', async () => {
    const signal = new AbortController().signal
    const ctx = { skipWriteCheckpoint: true, agentMode: 'agent' as const, runDir: workspace }

    const before = await toolGlob(workspace, '**/*.ts')
    expect(before).toContain('visible.ts')
    expect(before).toContain('hidden/secret.ts')

    const edited = await executeTool(
      'edit',
      JSON.stringify({ path: '.gitignore', contents: 'hidden/\n' }),
      workspace,
      signal,
      ctx
    )
    expect(edited.ok).toBe(true)

    const after = await toolGlob(workspace, '**/*.ts')
    expect(after).toContain('visible.ts')
    expect(after).not.toContain('secret.ts')
  })

  it('invalidate helpers clear git status + snapshot + gitignore together', async () => {
    // Warm gitignore matcher
    await toolGlob(workspace, '**/*.ts')
    writeFileSync(join(workspace, '.gitignore'), 'hidden/\n', 'utf8')

    // Without tool path: stale until explicit clear (proves cache existed)
    expect(await toolGlob(workspace, '**/*.ts')).toContain('secret.ts')

    invalidateGitStatusCache(workspace)
    clearWorkspaceSnapshotCache(workspace)
    clearGitignoreMatcherCache(workspace)

    expect(await toolGlob(workspace, '**/*.ts')).not.toContain('secret.ts')
  })

  it('an unrelated edit keeps the gitignore matchers it did not invalidate', async () => {
    const signal = new AbortController().signal
    const ctx = { skipWriteCheckpoint: true, agentMode: 'agent' as const, runDir: workspace }

    // Warm the matcher with a real rule, through the same path a tool uses.
    const edited = await executeTool(
      'edit',
      JSON.stringify({ path: '.gitignore', contents: 'hidden/\n' }),
      workspace,
      signal,
      ctx
    )
    expect(edited.ok).toBe(true)
    expect(await toolGlob(workspace, '**/*.ts')).not.toContain('secret.ts')

    // Change the rules behind the tools' back, then mutate something else.
    // Rebuilding every matcher costs the next walk real time, so an edit that
    // cannot have changed the rules must leave the cache alone.
    writeFileSync(join(workspace, '.gitignore'), '', 'utf8')
    const unrelated = await executeTool(
      'edit',
      JSON.stringify({ path: 'visible.ts', contents: 'export const visible = 2\n' }),
      workspace,
      signal,
      ctx
    )
    expect(unrelated.ok).toBe(true)
    expect(await toolGlob(workspace, '**/*.ts')).not.toContain('secret.ts')

    // A write that touches .gitignore still refreshes them.
    const touched = await executeTool(
      'edit',
      JSON.stringify({ path: '.gitignore', contents: '\n' }),
      workspace,
      signal,
      ctx
    )
    expect(touched.ok).toBe(true)
    expect(await toolGlob(workspace, '**/*.ts')).toContain('secret.ts')
  })
})
