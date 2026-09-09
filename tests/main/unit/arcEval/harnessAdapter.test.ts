import { describe, expect, it, vi, beforeEach } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'
import type { ArcTask } from '@main/agent/arcEval/types'
import {
  arcGridResponseFormat,
  buildArcPrompt,
  extractFirstGrid,
  renderArcGrid,
  replyExcerpt,
  solveTask,
  solveTaskZeroShot
} from '@main/agent/arcEval/harnessAdapter'
import { scorePrediction } from '@main/agent/arcEval/arcScorer'

/**
 * Stub seam: the adapter talks to the completion client layer exactly like the
 * shipped one-shot completions do — `getProvider(id).streamChat` — so the test
 * mocks `@main/agent/providers` (same pattern as tests/main/unit/agentLoopSteps.test.ts)
 * plus the settings/secrets modules the adapter resolves config from.
 */
const state = vi.hoisted(() => ({
  streamChat: vi.fn(),
  settings: {} as Record<string, unknown>
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: () => state.settings,
  readLegacyWorkspacePath: () => null
}))

vi.mock('@main/settings/secrets', () => ({
  getSecret: () => null,
  hasStoredSecretBlob: () => false,
  secretStatus: () => ({ encryptionAvailable: true, keys: {} })
}))

vi.mock('@main/agent/providers', () => ({
  getProvider: () => ({
    id: 'ollama',
    listModels: async () => [],
    streamChat: state.streamChat
  })
}))

function replyWith(text: string, errorChunk = false): void {
  state.streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
    if (errorChunk) {
      yield { type: 'error', error: text }
      yield { type: 'done', stopReason: 'error' }
      return
    }
    yield { type: 'text', text }
    yield { type: 'done', stopReason: 'stop' }
  })
}

function lastRequest(): ProviderChatRequest {
  const calls = state.streamChat.mock.calls as unknown as [ProviderChatRequest][]
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0]
}

const SAMPLE_TASK: ArcTask = {
  id: 'sample',
  train: [
    {
      input: [
        [0, 1],
        [2, 3]
      ],
      output: [
        [1, 0],
        [3, 2]
      ]
    }
  ],
  test: [
    {
      input: [
        [4, 5],
        [6, 7]
      ],
      output: [
        [5, 4],
        [7, 6]
      ]
    }
  ]
}

function loadTrainingTask(): ArcTask {
  const dir = join(process.cwd(), 'test-results', 'arc-agi', 'training')
  const file = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()[0]
  if (!file) throw new Error('no training task files')
  const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
    train: ArcTask['train']
    test: ArcTask['test']
  }
  return { id: file.replace(/\.json$/, ''), train: raw.train, test: raw.test }
}

const datasetDir = join(process.cwd(), 'test-results', 'arc-agi', 'training')
const datasetAvailable =
  existsSync(datasetDir) &&
  readdirSync(datasetDir).some((f) => f.endsWith('.json'))
const ddescribe = datasetAvailable ? describe : describe.skip

describe('extractFirstGrid', () => {
  it('parses a bare JSON grid', () => {
    expect(extractFirstGrid('[[1,2],[3,4]]')).toEqual([
      [1, 2],
      [3, 4]
    ])
  })

  it('parses a grid inside code fences', () => {
    expect(extractFirstGrid('```json\n[[0,0],[9,9]]\n```')).toEqual([
      [0, 0],
      [9, 9]
    ])
  })

  it('parses the first grid embedded in prose', () => {
    expect(
      extractFirstGrid('Sure! The answer is:\nOutput: [[5]]\nHope that helps.')
    ).toEqual([[5]])
  })

  it('returns null for garbage instead of throwing', () => {
    expect(extractFirstGrid('I cannot solve this puzzle, sorry.')).toBeNull()
    expect(extractFirstGrid('')).toBeNull()
  })

  it('rejects ragged rows and out-of-range values', () => {
    expect(extractFirstGrid('[[1,2],[3]]')).toBeNull()
    expect(extractFirstGrid('[[1,10],[3,4]]')).toBeNull()
    expect(extractFirstGrid('[["1","2"],["3","4"]]')).toBeNull()
    expect(extractFirstGrid('[]')).toBeNull()
  })
})

describe('solveTaskZeroShot', () => {
  beforeEach(() => {
    state.streamChat.mockReset()
    state.settings = {
      provider: 'ollama',
      model: 'qwen2.5',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      theme: 'system',
      telemetryEnabled: false
    }
  })

  it('returns the parsed prediction for a valid grid reply', async () => {
    replyWith('[[5,4],[7,6]]')
    const candidate = await solveTaskZeroShot(SAMPLE_TASK)
    expect(candidate.index).toBe(0)
    expect(candidate.error).toBeUndefined()
    expect(typeof candidate.durationMs).toBe('number')
    expect(candidate.prediction).toEqual(SAMPLE_TASK.test[0].output)
    const req = lastRequest()
    expect(req.tools).toEqual([])
    expect(req.messages).toHaveLength(1)
    expect(req.model).toBe('qwen2.5')
    // The prompt carries the train pairs and the test input compactly.
    expect(req.messages[0].content).toContain('0 1\n2 3')
    expect(req.messages[0].content).toContain('4 5\n6 7')
  })

  it('returns a null prediction without throwing for a garbage reply', async () => {
    replyWith('Beep boop, no grids here.')
    const candidate = await solveTaskZeroShot(SAMPLE_TASK)
    expect(candidate.prediction).toBeNull()
    expect(candidate.error).toBeTruthy()
    expect(typeof candidate.durationMs).toBe('number')
  })

  it('surfaces a provider error chunk as an error candidate', async () => {
    replyWith('HTTP 500 upstream failure', true)
    const candidate = await solveTaskZeroShot(SAMPLE_TASK)
    expect(candidate.prediction).toBeNull()
    expect(candidate.error).toContain('HTTP 500')
  })

  it('returns an error candidate when no chat model is configured', async () => {
    state.settings = {}
    const candidate = await solveTaskZeroShot(SAMPLE_TASK)
    expect(candidate.prediction).toBeNull()
    expect(candidate.error).toMatch(/no chat model configured/i)
    expect(state.streamChat).not.toHaveBeenCalled()
  })

  it('returns an error candidate when the provider requires an unsaved key', async () => {
    state.settings = { provider: 'openai', model: 'gpt-4o' }
    const candidate = await solveTaskZeroShot(SAMPLE_TASK)
    expect(candidate.prediction).toBeNull()
    expect(candidate.error).toMatch(/api key/i)
    expect(state.streamChat).not.toHaveBeenCalled()
  })

  it('honors the candidate index option', async () => {
    replyWith('[[5,4],[7,6]]')
    const candidate = await solveTaskZeroShot(SAMPLE_TASK, { index: 3 })
    expect(candidate.index).toBe(3)
  })
})

describe('solveTask harness loop', () => {
  beforeEach(() => {
    state.streamChat.mockReset()
    state.settings = {
      provider: 'ollama',
      model: 'qwen2.5',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      theme: 'system',
      telemetryEnabled: false
    }
  })

  it('solves on the first round without repair round-trips', async () => {
    replyWith('[[5,4],[7,6]]')
    const candidate = await solveTask(SAMPLE_TASK)
    expect(candidate.prediction).toEqual(SAMPLE_TASK.test[0].output)
    expect(state.streamChat).toHaveBeenCalledTimes(1)
  })

  it('repairs an invalid first reply via a multi-turn round-trip', async () => {
    let call = 0
    state.streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      yield { type: 'text', text: call === 1 ? 'Sorry, I am confused.' : '[[5,4],[7,6]]' }
      yield { type: 'done', stopReason: 'stop' }
    })
    const candidate = await solveTask(SAMPLE_TASK)
    expect(candidate.prediction).toEqual(SAMPLE_TASK.test[0].output)
    expect(state.streamChat).toHaveBeenCalledTimes(2)
    const repaired = lastRequest()
    expect(repaired.messages).toHaveLength(3)
    expect(repaired.messages[1].role).toBe('assistant')
    expect(repaired.messages[2].role).toBe('user')
    expect(repaired.messages[2].content).toMatch(/only the output grid/i)
  })

  it('returns an error candidate after exhausting repair rounds', async () => {
    replyWith('still not a grid')
    const candidate = await solveTask(SAMPLE_TASK, { repairRounds: 1 })
    expect(candidate.prediction).toBeNull()
    expect(candidate.error).toMatch(/no valid grid/i)
    expect(state.streamChat).toHaveBeenCalledTimes(2)
  })
})

describe('responseFormat opt-in', () => {
  beforeEach(() => {
    state.streamChat.mockReset()
    state.settings = {
      provider: 'ollama',
      model: 'qwen2.5',
      ollamaBaseUrl: 'http://127.0.0.1:11434'
    }
  })

  it('omits responseFormat from the provider request when not opted in', async () => {
    replyWith('[[5,4],[7,6]]')
    await solveTask(SAMPLE_TASK)
    expect(lastRequest().responseFormat).toBeUndefined()
  })

  it('attaches the grid schema and key instruction when opted in', async () => {
    replyWith('{"grid": [[5,4],[7,6]]}')
    const candidate = await solveTask(SAMPLE_TASK, { responseFormat: arcGridResponseFormat() })
    expect(candidate.prediction).toEqual(SAMPLE_TASK.test[0].output)
    const request = lastRequest()
    expect(request.responseFormat?.type).toBe('json_schema')
    expect(request.responseFormat?.name).toBe('arc_grid')
    expect(request.responseFormat?.strict).toBe(true)
    expect(request.system).toContain('"grid"')
  })

  it('parses the wrapped {"grid": ...} reply with the shared extractor', () => {
    expect(extractFirstGrid('{"grid": [[5,4],[7,6]]}')).toEqual([[5, 4], [7, 6]])
  })
})

describe('failure diagnostics', () => {
  beforeEach(() => {
    state.streamChat.mockReset()
    state.settings = {
      provider: 'ollama',
      model: 'qwen2.5',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      theme: 'system',
      telemetryEnabled: false
    }
  })

  it('JSON-escapes and caps the reply excerpt at 200 chars', () => {
    expect(replyExcerpt('a'.repeat(300))).toBe(JSON.stringify('a'.repeat(200)))
    expect(replyExcerpt('line1\n"quoted"')).toBe('"line1\\n\\"quoted\\""')
    expect(replyExcerpt('')).toBe('""')
  })

  it('includes the raw-reply excerpt in the no-valid-grid error', async () => {
    replyWith('Sure! The answer is:\nOutput: [[1,2],[3]] oops')
    const candidate = await solveTaskZeroShot(SAMPLE_TASK)
    expect(candidate.prediction).toBeNull()
    expect(candidate.error).toContain('round 1 reply was not a valid grid:')
    expect(candidate.error).toContain('"Sure! The answer is:\\nOutput: [[1,2],[3]] oops"')
  })

  it('diagnoses an empty reply with stop reason, reasoning size, and token budget', async () => {
    state.streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'thinking_delta', text: 'pondering '.repeat(10) }
      yield {
        type: 'done',
        stopReason: 'length',
        usage: { outputTokens: 4096 }
      }
    })
    const candidate = await solveTaskZeroShot(SAMPLE_TASK, { maxOutputTokens: 4096 })
    expect(candidate.prediction).toBeNull()
    expect(candidate.error).toMatch(
      /round 1 reply was empty \(stopReason: length, 100 reasoning chars, 4096 output tokens, maxOutputTokens 4096\)/
    )
  })

  it('keeps the prior round diagnosis when a later round fails on a provider error', async () => {
    let call = 0
    state.streamChat.mockImplementation(async function* (): AsyncGenerator<StreamChunk> {
      call += 1
      if (call === 1) {
        yield { type: 'done', stopReason: 'length' }
      } else {
        yield { type: 'error', error: 'upstream exploded' }
        yield { type: 'done', stopReason: 'error' }
      }
    })
    const candidate = await solveTask(SAMPLE_TASK)
    expect(candidate.error).toContain('Provider completion failed (round 2): Error: upstream exploded')
    expect(candidate.error).toMatch(/after round 1 reply was empty \(stopReason: length/)
  })
})

describe('thinking configuration', () => {
  beforeEach(() => {
    state.streamChat.mockReset()
    state.settings = {
      provider: 'ollama',
      model: 'qwen2.5',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      theme: 'system',
      telemetryEnabled: false
    }
  })

  it('defaults to thinking disabled', async () => {
    replyWith('[[5,4],[7,6]]')
    await solveTaskZeroShot(SAMPLE_TASK)
    expect(lastRequest().thinking).toEqual({ enabled: false })
  })

  it('sends an explicit reasoning effort with omitted display when requested', async () => {
    replyWith('[[5,4],[7,6]]')
    await solveTaskZeroShot(SAMPLE_TASK, { reasoningEffort: 'low' })
    expect(lastRequest().thinking).toEqual({ enabled: true, effort: 'low', display: 'omitted' })
  })
})

ddescribe('real ARC dataset task (test-results/arc-agi/training)', () => {
  beforeEach(() => {
    state.streamChat.mockReset()
    state.settings = {
      provider: 'ollama',
      model: 'qwen2.5',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      theme: 'system',
      telemetryEnabled: false
    }
  })

  it('drives a fetched training task end-to-end through the stubbed completion layer', () => {
    const task = loadTrainingTask()
    const expected = task.test[0].output
    replyWith(JSON.stringify(expected))

    return solveTask(task).then((candidate) => {
      // Prompt renders the real test input row-per-line.
      expect(lastRequest().messages[0].content).toContain(renderArcGrid(task.test[0].input))
      expect(scorePrediction(expected, candidate.prediction)).toBe(true)
    })
  })
})
