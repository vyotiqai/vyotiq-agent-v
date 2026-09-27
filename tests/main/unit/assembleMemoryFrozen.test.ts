import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  assembleContext,
  buildMemorySection,
  clearSystemPromptCache
} from '@main/agent/context/assemble'
import type { ModelInfo } from '@shared/ipc'

const model: ModelInfo = {
  id: 'test',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsTools: true,
  supportsVision: false,
  contextWindow: 200_000
}

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspaceWithMemory(state: string, index: string): string {
  const ws = mkdtempSync(join(tmpdir(), 'vy-mem-frozen-'))
  dirs.push(ws)
  mkdirSync(join(ws, '.vyotiq', 'memory'), { recursive: true })
  writeFileSync(join(ws, '.vyotiq', 'memory', 'state.md'), state)
  writeFileSync(join(ws, '.vyotiq', 'memory', 'index.md'), index)
  return ws
}

function input(ws: string) {
  return {
    harness: '## Role\nAgent',
    messages: [{ role: 'user' as const, content: 'hi' }],
    workspacePath: ws,
    goal: 'hi',
    model,
    toolsJsonEstimate: 10,
    providerId: 'ollama' as const
  }
}

describe('frozen workspace memory', () => {
  it('renders the same stable bytes from a pre-built section as from disk', async () => {
    const ws = workspaceWithMemory('- fact one\n- fact two', '# Memory index\n- notes/a.md')
    clearSystemPromptCache()
    const fromDisk = await assembleContext(input(ws))
    clearSystemPromptCache()
    const frozen = await assembleContext({ ...input(ws), memorySection: await buildMemorySection(ws) })
    expect(frozen.systemStable).toBe(fromDisk.systemStable)
    expect(frozen.systemStable).toContain('- fact two')
  })

  it('keeps the stable zone unchanged when memory is written mid-invoke', async () => {
    const ws = workspaceWithMemory('- fact one', '# Memory index')
    const memorySection = await buildMemorySection(ws)
    clearSystemPromptCache()
    const before = await assembleContext({ ...input(ws), memorySection })
    writeFileSync(join(ws, '.vyotiq', 'memory', 'state.md'), '- fact one\n- written by memory_write')
    const after = await assembleContext({ ...input(ws), memorySection })
    expect(after.systemStable).toBe(before.systemStable)
    expect(after.systemStable).not.toContain('written by memory_write')
  })

  it('an empty pre-built section means no memory, not "read from disk"', async () => {
    const ws = workspaceWithMemory('- fact one', '# Memory index')
    clearSystemPromptCache()
    const result = await assembleContext({ ...input(ws), memorySection: '' })
    expect(result.systemStable).not.toContain('<memory>')
  })
})
