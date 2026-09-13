import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'

const userData = join(tmpdir(), `vyotiq-skills-refresh-${process.pid}-${Date.now()}`)

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
    telemetryEnabled: false
  }),
  readLegacyWorkspacePath: () => null
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => null,
  hasStoredSecretBlob: () => false,
  secretStatus: () => ({ encryptionAvailable: true, keys: {} })
}))

vi.mock('@main/agent/harness', () => ({
  loadHarness: () => 'harness'
}))

const { streamChat, executeTool, assembleCalls } = vi.hoisted(() => ({
  streamChat: vi.fn(),
  executeTool: vi.fn(),
  assembleCalls: [] as Array<{ skillsSection: string; pluginRulesSection: string }>
}))

vi.mock('@main/agent/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/context')>()
  return {
    ...actual,
    assembleContext: async (input: {
      messages: unknown[]
      skillsSection?: string
      pluginRulesSection?: string
    }) => {
      assembleCalls.push({
        skillsSection: input.skillsSection ?? '',
        pluginRulesSection: input.pluginRulesSection ?? ''
      })
      return {
        messages: input.messages,
        system: 'system',
        estimatedTokens: 100,
        layers: { system: 10, history: 50, tools: 20, buffer: 20 },
        overflow: false,
        anthropicNative: undefined,
        compaction: null
      }
    },
    ensureMemoryLayout: () => undefined
  }
})

vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({
    id: 'ollama',
    listModels: async () => [],
    streamChat
  }),
  listProviderModels: async () => ({
    models: [
      {
        id: 'qwen2.5',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false
      }
    ]
  })
}))

vi.mock('@main/agent/tools', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args)
}))

import { runAgent } from '@main/agent/loop'
import { resetActiveRunsForTests } from '@main/agent/runRegistry'
import {
  clearLocalSkillsCache,
  setPersonalSkillsRootForTests
} from '@main/agent/skills/local'

function writeProjectSkill(workspace: string, name: string, description: string): void {
  const dir = join(workspace, '.vyotiq', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---
name: ${name}
description: ${description}
metadata:
  version: "1.0.0"
---

# ${name}

Follow the ${name} workflow for this workspace.
`
  )
}

describe('runAgent mid-invoke skill catalog refresh', () => {
  let workspace: string
  let personal: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-skills-refresh-ws-${process.pid}-${Date.now()}`)
    personal = join(tmpdir(), `vyotiq-skills-refresh-home-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(personal, { recursive: true })
    mkdirSync(join(userData, 'marketplace', 'packages'), { recursive: true })
    setPersonalSkillsRootForTests(personal)
    clearLocalSkillsCache()
    assembleCalls.length = 0
    resetActiveRunsForTests()
    streamChat.mockReset()
    executeTool.mockReset()
  })

  afterEach(() => {
    setPersonalSkillsRootForTests(null)
    clearLocalSkillsCache()
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
    if (existsSync(personal)) rmSync(personal, { recursive: true, force: true })
  })

  it('rebuilds available_skills on a later step after a mid-run install', async () => {
    let call = 0
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', name: 'read', arguments: '{"path":"src/auth/login.ts"}' }
        }
        yield { type: 'done', stopReason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'Auth login review is done.' }
      yield { type: 'done', stopReason: 'end_turn' }
    })
    executeTool.mockImplementation(async () => {
      writeProjectSkill(
        workspace,
        'mid-run-review',
        'Review the auth login path after a mid-run Marketplace-style install.'
      )
      return {
        ok: true,
        summary: 'src/auth/login.ts',
        content: 'export function login(): Session { return createSession() }\n'
      }
    })

    for await (const _ev of runAgent({
      runId: 'skills-refresh-mid-invoke',
      messages: [{ role: 'user', content: 'Review src/auth/login.ts' }],
      workspacePath: workspace
    })) {
      // Drain the run.
    }

    expect(assembleCalls.length).toBeGreaterThanOrEqual(2)
    expect(assembleCalls[0]?.skillsSection ?? '').not.toContain('mid-run-review')
    const later = assembleCalls.slice(1).some((entry) =>
      entry.skillsSection.includes('mid-run-review')
    )
    expect(later).toBe(true)
    const laterEntry = assembleCalls.slice(1).find((entry) =>
      entry.skillsSection.includes('mid-run-review')
    )
    expect(laterEntry?.skillsSection).toContain(
      'Review the auth login path after a mid-run Marketplace-style install.'
    )
    expect(laterEntry?.skillsSection).not.toContain('Follow the mid-run-review workflow')
  })
})
