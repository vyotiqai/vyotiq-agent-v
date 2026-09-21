/**
 * Whole-prompt context accounting, driven through the real loop.
 *
 * Anthropic-shaped providers report `inputTokens` as the *uncached* slice only
 * and split the rest into `cachedInputTokens` / `cacheCreationInputTokens`
 * (providers/anthropic.ts sets `inputTokensIncludesCache: false`). The loop used
 * to take that raw number as the context size, so a cache-warm step looked
 * nearly empty to both the meter and the auto-compact trigger. Recorded on run
 * e23fcf6b step 1: `inputTokens: 6` alongside `cacheCreationInputTokens: 15900`.
 *
 * Billing is the opposite — `estimateStepCost` prices each slice at its own rate
 * — so `step_usage` must keep reporting the provider's raw figure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { StreamChunk } from '@main/agent/providers/types'

const userData = join(tmpdir(), `vyotiq-cache-ctx-${process.pid}-${Date.now()}`)

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
  return { ...actual, syncMcpServers: async () => {}, listMcpToolDefinitions: () => [] }
})

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    theme: 'system',
    telemetryEnabled: false,
    autoModeSwitch: false
  }),
  readLegacyWorkspacePath: () => null
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => 'k',
  hasStoredSecretBlob: () => false,
  secretStatus: () => ({ encryptionAvailable: true, keys: {} })
}))

vi.mock('@main/agent/harness', () => ({ loadHarness: () => 'harness' }))

const { streamChat } = vi.hoisted(() => ({ streamChat: vi.fn() }))

vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({ id: 'anthropic', listModels: async () => [], streamChat }),
  listProviderModels: async () => ({
    models: [
      {
        id: 'claude-sonnet-4',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false,
        contextWindow: 200_000
      }
    ]
  })
}))

vi.mock('@main/agent/tools', () => ({ executeTool: vi.fn() }))

import { runAgent } from '@main/agent/loop'
import { resetActiveRunsForTests } from '@main/agent/runRegistry'
import type { AgentEvent } from '@shared/ipc'

/** Recorded Anthropic shape: 1,200 uncached + 48,000 cache read + 6,400 cache write. */
const UNCACHED = 1_200
const CACHE_READ = 48_000
const CACHE_WRITE = 6_400
const WHOLE_PROMPT = UNCACHED + CACHE_READ + CACHE_WRITE

describe('context accounting with a cache-splitting provider', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-cache-ctx-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    resetActiveRunsForTests()
    streamChat.mockReset()
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('reports the whole prompt to the meter and the raw slices to billing', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'done' }
      yield {
        type: 'done',
        stopReason: 'stop',
        usage: {
          inputTokens: UNCACHED,
          inputTokensIncludesCache: false,
          outputTokens: 40,
          cachedInputTokens: CACHE_READ,
          cacheCreationInputTokens: CACHE_WRITE
        }
      }
    })

    const events: AgentEvent[] = []
    for await (const ev of runAgent({
      runId: 'cache-ctx',
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    const providerUsage = events.filter(
      (ev): ev is Extract<AgentEvent, { type: 'context_usage' }> =>
        ev.type === 'context_usage' && ev.source === 'provider'
    )
    expect(providerUsage.length).toBeGreaterThan(0)
    for (const ev of providerUsage) {
      expect(ev.inputTokens).toBe(WHOLE_PROMPT)
    }

    // Billing keeps the provider's own split; adding the cache slices here would
    // price cache reads and writes at the full input rate.
    const stepUsage = events.filter(
      (ev): ev is Extract<AgentEvent, { type: 'step_usage' }> => ev.type === 'step_usage'
    )
    expect(stepUsage.length).toBeGreaterThan(0)
    expect(stepUsage[0]?.inputTokens).toBe(UNCACHED)
    expect(stepUsage[0]?.cachedInputTokens).toBe(CACHE_READ)
    expect(stepUsage[0]?.cacheCreationInputTokens).toBe(CACHE_WRITE)
  })

  it('does not inflate a provider that already reports the whole prompt', async () => {
    streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'done' }
      yield {
        type: 'done',
        stopReason: 'stop',
        usage: {
          inputTokens: WHOLE_PROMPT,
          inputTokensIncludesCache: true,
          outputTokens: 40,
          cachedInputTokens: CACHE_READ
        }
      }
    })

    const events: AgentEvent[] = []
    for await (const ev of runAgent({
      runId: 'cache-ctx-inclusive',
      messages: [{ role: 'user', content: 'hello' }],
      workspacePath: workspace
    })) {
      events.push(ev)
    }

    const providerUsage = events.filter(
      (ev): ev is Extract<AgentEvent, { type: 'context_usage' }> =>
        ev.type === 'context_usage' && ev.source === 'provider'
    )
    expect(providerUsage.length).toBeGreaterThan(0)
    for (const ev of providerUsage) {
      expect(ev.inputTokens).toBe(WHOLE_PROMPT)
    }
  })
})
