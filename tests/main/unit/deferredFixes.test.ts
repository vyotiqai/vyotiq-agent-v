import { describe, expect, it } from 'vitest'
import { buildStepToolCatalog } from '@main/agent/context/toolsBudget'
import type { ToolDefinition } from '@main/agent/providers/types'
import { geminiFunctionCallingMode } from '@main/agent/providers/gemini'
import {
  isCurrentInvoke,
  markRunTurnComplete,
  registerRunAbort,
  resetActiveRunsForTests
} from '@main/agent/runRegistry'

describe('full step tool catalog', () => {
  it('keeps the full catalog even when it is huge', () => {
    const tools: ToolDefinition[] = [
      { name: 'read', description: 'r', parameters: {} },
      { name: 'mcp__a__one', description: 'x'.repeat(800), parameters: {} },
      { name: 'mcp__b__two', description: 'y'.repeat(800), parameters: {} }
    ]
    const result = buildStepToolCatalog(tools)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.map((t) => t.name)).toEqual([
      'read',
      'mcp__a__one',
      'mcp__b__two'
    ])
  })
})

describe('geminiFunctionCallingMode', () => {
  it('maps loop toolChoice to Gemini modes', () => {
    expect(geminiFunctionCallingMode('auto')).toBe('AUTO')
    expect(geminiFunctionCallingMode('required')).toBe('ANY')
    expect(geminiFunctionCallingMode('none')).toBe('NONE')
    expect(geminiFunctionCallingMode(undefined)).toBe('AUTO')
  })

  it('puts functionCallingConfig on generateContent bodies', async () => {
    const { buildGeminiBody } = await import('@main/agent/providers/gemini')
    const body = buildGeminiBody({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read', description: 'r', parameters: { type: 'object', properties: {} } }],
      toolChoice: 'required',
      apiKey: 'x',
      signal: new AbortController().signal
    })
    expect(
      (body.toolConfig as { functionCallingConfig: { mode: string } }).functionCallingConfig.mode
    ).toBe('ANY')
  })
})

describe('gemini plain-path thinkingConfig', () => {
  const baseReq = {
    messages: [{ role: 'user' as const, content: 'hi' }],
    tools: [],
    apiKey: 'x',
    signal: new AbortController().signal
  }

  it('sends thinkingBudget 0 when thinking is disabled on a flash-family model', async () => {
    const { buildGeminiBody } = await import('@main/agent/providers/gemini')
    const body = buildGeminiBody({
      ...baseReq,
      model: 'gemini-2.5-flash',
      thinking: { enabled: false }
    })
    const config = (body.generationConfig as { thinkingConfig?: { thinkingBudget?: number } })
      .thinkingConfig
    expect(config?.thinkingBudget).toBe(0)
  })

  // Gemini 3+ thinks at its default when no level is sent: "off" (a spoken turn) asks for low.
  it('sends thinkingLevel low when thinking is off on Gemini 3 and later', async () => {
    const { buildGeminiBody } = await import('@main/agent/providers/gemini')
    const level = (model: string): unknown =>
      (buildGeminiBody({ ...baseReq, model, thinking: { enabled: false } }).generationConfig as
        | { thinkingConfig?: { thinkingLevel?: string } }
        | undefined)?.thinkingConfig?.thinkingLevel
    expect(level('gemini-3-pro-preview')).toBe('low')
    expect(level('gemini-3.8-flash')).toBe('low')
    expect(level('gemini-4-argon')).toBe('low')
    expect(level('gemini-3.5-flash-lite')).toBeUndefined()
    const on = buildGeminiBody({ ...baseReq, model: 'gemini-3.8-flash', thinking: { enabled: true, effort: 'high' } })
    expect(on.generationConfig).toBeUndefined()
  })

  it('omits thinkingConfig for 2.5 Pro (budget 0 is rejected with a 400)', async () => {
    const { buildGeminiBody } = await import('@main/agent/providers/gemini')
    const body = buildGeminiBody({
      ...baseReq,
      model: 'gemini-2.5-pro',
      thinking: { enabled: false }
    })
    expect(
      (body.generationConfig as { thinkingConfig?: unknown } | undefined)?.thinkingConfig
    ).toBeUndefined()
  })

  it('omits thinkingConfig when thinking is enabled (Interactions transport owns it)', async () => {
    const { buildGeminiBody } = await import('@main/agent/providers/gemini')
    const body = buildGeminiBody({
      ...baseReq,
      model: 'gemini-2.5-flash',
      thinking: { enabled: true, effort: 'low' }
    })
    expect(
      (body.generationConfig as { thinkingConfig?: unknown } | undefined)?.thinkingConfig
    ).toBeUndefined()
  })

  it('omits thinkingConfig when thinking is unset', async () => {
    const { buildGeminiBody } = await import('@main/agent/providers/gemini')
    const body = buildGeminiBody({ ...baseReq, model: 'gemini-2.5-flash' })
    expect(
      (body.generationConfig as { thinkingConfig?: unknown } | undefined)?.thinkingConfig
    ).toBeUndefined()
  })
})

describe('isCurrentInvoke', () => {
  it('keeps the same invoke until clearRunAbort (no overlap while unwinding)', () => {
    resetActiveRunsForTests()
    const first = registerRunAbort('run-a', '/tmp/ws')
    expect(isCurrentInvoke('run-a', first.invokeId)).toBe(true)
    markRunTurnComplete('run-a', first.invokeId)
    // turnComplete must not spawn a second invoke — that raced the prior finally.
    const second = registerRunAbort('run-a', '/tmp/ws')
    expect(second.invokeId).toBe(first.invokeId)
    expect(isCurrentInvoke('run-a', first.invokeId)).toBe(true)
    resetActiveRunsForTests()
  })
})
