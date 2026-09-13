import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getCachedModels,
  modelCacheKey,
  normalizeModelCacheBaseUrl,
  resetModelCacheForTests,
  setCachedModels,
  setModelCacheDiskPathForTests
} from '@main/agent/providers/modelCache'
import type { ModelInfo } from '@shared/ipc'

const sample: ModelInfo[] = [
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', provider: 'deepseek' }
]

describe('modelCache disk', () => {
  let dir: string

  afterEach(() => {
    resetModelCacheForTests()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('reloads catalog from disk after a process-style reset', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-model-cache-'))
    const disk = join(dir, 'model-catalog-cache.json')
    setModelCacheDiskPathForTests(disk)

    const key = modelCacheKey('deepseek', undefined, 'sk-test')
    setCachedModels(key, sample)
    expect(JSON.parse(readFileSync(disk, 'utf8')).entries[key].models).toEqual(sample)

    // Simulate new process: clear memory, keep disk path.
    setModelCacheDiskPathForTests(disk)
    expect(getCachedModels(key)).toEqual(sample)
  })

  it('does not refresh unrelated keys diskSavedAt when another catalog is written', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-model-cache-'))
    const disk = join(dir, 'model-catalog-cache.json')
    setModelCacheDiskPathForTests(disk)

    const deepseek = modelCacheKey('deepseek', undefined, 'sk-a')
    const openai = modelCacheKey('openai', undefined, 'sk-b')
    setCachedModels(deepseek, sample)

    const firstSavedAt = JSON.parse(readFileSync(disk, 'utf8')).entries[deepseek].savedAt as number
    // Force an older stamp so a refresh would be observable.
    const raw = JSON.parse(readFileSync(disk, 'utf8')) as {
      version: 3
      entries: Record<string, { models: ModelInfo[]; savedAt: number }>
    }
    raw.entries[deepseek]!.savedAt = firstSavedAt - 60_000
    writeFileSync(disk, JSON.stringify(raw))
    // Reload memory from the stamped disk file.
    setModelCacheDiskPathForTests(disk)
    expect(getCachedModels(deepseek)).toEqual(sample)

    setCachedModels(openai, [
      { id: 'gpt-test', name: 'gpt-test', provider: 'openai' }
    ])

    const after = JSON.parse(readFileSync(disk, 'utf8')) as typeof raw
    expect(after.entries[deepseek]!.savedAt).toBe(firstSavedAt - 60_000)
    expect(after.entries[openai]!.savedAt).toBeGreaterThan(firstSavedAt - 60_000)
  })

  it('normalizes Ollama /v1 and native host to the same cache key', () => {
    const keyA = modelCacheKey('ollama', 'https://ollama.com', 'sk-test')
    const keyB = modelCacheKey('ollama', 'https://ollama.com/v1', 'sk-test')
    expect(keyA).toBe(keyB)
    expect(normalizeModelCacheBaseUrl('ollama', 'https://ollama.com/v1/')).toBe('https://ollama.com')
  })

  it('migrates legacy Ollama /v1 disk keys on load', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-model-cache-'))
    const disk = join(dir, 'model-catalog-cache.json')
    const legacyKey = 'ollama|https://ollama.com/v1|abc123'
    const canonicalKey = 'ollama|https://ollama.com|abc123'
    writeFileSync(
      disk,
      JSON.stringify({
        version: 3,
        entries: {
          [legacyKey]: { models: sample, savedAt: Date.now() }
        }
      })
    )
    setModelCacheDiskPathForTests(disk)
    expect(getCachedModels(canonicalKey)).toEqual(sample)
    const onDisk = JSON.parse(readFileSync(disk, 'utf8')) as {
      entries: Record<string, { models: ModelInfo[] }>
    }
    expect(Object.keys(onDisk.entries)).toEqual([canonicalKey])
  })

  it('compacts duplicate Ollama /v1 and native disk keys on boot', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-model-cache-'))
    const disk = join(dir, 'model-catalog-cache.json')
    const legacyKey = 'ollama|https://ollama.com/v1|abc123'
    const canonicalKey = 'ollama|https://ollama.com|abc123'
    const legacyModels: ModelInfo[] = [
      { id: 'legacy-only', name: 'legacy-only', provider: 'ollama' }
    ]
    const canonicalModels: ModelInfo[] = [
      { id: 'canonical', name: 'canonical', provider: 'ollama' }
    ]
    const now = Date.now()
    writeFileSync(
      disk,
      JSON.stringify({
        version: 3,
        entries: {
          [legacyKey]: { models: legacyModels, savedAt: now - 2_000 },
          [canonicalKey]: { models: canonicalModels, savedAt: now - 1_000 }
        }
      })
    )
    setModelCacheDiskPathForTests(disk)
    expect(getCachedModels(canonicalKey)).toEqual(canonicalModels)
    const onDisk = JSON.parse(readFileSync(disk, 'utf8')) as {
      entries: Record<string, { models: ModelInfo[]; savedAt: number }>
    }
    expect(Object.keys(onDisk.entries)).toEqual([canonicalKey])
    expect(onDisk.entries[canonicalKey]!.models).toEqual(canonicalModels)
    expect(onDisk.entries[canonicalKey]!.savedAt).toBe(now - 1_000)
  })

  it('drops expired disk entries during boot compaction', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-model-cache-'))
    const disk = join(dir, 'model-catalog-cache.json')
    const freshKey = modelCacheKey('openai', undefined, 'sk-fresh')
    const staleKey = modelCacheKey('deepseek', undefined, 'sk-stale')
    const now = Date.now()
    writeFileSync(
      disk,
      JSON.stringify({
        version: 3,
        entries: {
          [freshKey]: { models: sample, savedAt: now },
          [staleKey]: {
            models: [{ id: 'old', name: 'old', provider: 'deepseek' }],
            savedAt: now - 8 * 24 * 60 * 60 * 1000
          }
        }
      })
    )
    setModelCacheDiskPathForTests(disk)
    expect(getCachedModels(freshKey)).toEqual(sample)
    expect(getCachedModels(staleKey)).toBeNull()
    const onDisk = JSON.parse(readFileSync(disk, 'utf8')) as {
      entries: Record<string, unknown>
    }
    expect(Object.keys(onDisk.entries)).toEqual([freshKey])
  })

  it('ignores v1 disk catalogs that coerced Ollama missing thinking to false', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-model-cache-'))
    const disk = join(dir, 'model-catalog-cache.json')
    const key = modelCacheKey('ollama', 'https://ollama.com', 'sk-test')
    writeFileSync(
      disk,
      JSON.stringify({
        version: 1,
        entries: {
          [key]: {
            models: [
              {
                id: 'glm-5.2',
                inputModalities: ['text'],
                outputModalities: ['text'],
                supportsTools: true,
                supportsVision: false,
                supportsThinking: false,
                contextWindow: 128_000
              }
            ],
            savedAt: Date.now()
          }
        }
      })
    )
    setModelCacheDiskPathForTests(disk)
    expect(getCachedModels(key)).toBeNull()
  })

  it('ignores v2 disk catalogs that hardcoded opencode supportsThinking to false', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-model-cache-'))
    const disk = join(dir, 'model-catalog-cache.json')
    const key = modelCacheKey('opencode', undefined, 'sk-test')
    writeFileSync(
      disk,
      JSON.stringify({
        version: 2,
        entries: {
          [key]: {
            models: [
              {
                id: 'longcat-2.0',
                inputModalities: ['text'],
                outputModalities: ['text'],
                supportsTools: true,
                supportsVision: false,
                supportsThinking: false,
                contextWindow: 128_000
              }
            ],
            savedAt: Date.now()
          }
        }
      })
    )
    setModelCacheDiskPathForTests(disk)
    expect(getCachedModels(key)).toBeNull()
  })
})
