import { describe, expect, it } from 'vitest'
import { toOpenAiMessages, buildOpenAiCompatBody } from '@main/agent/providers/openai'
import { toResponsesInput } from '@main/agent/providers/openaiResponses'
import { buildGeminiBody } from '@main/agent/providers/gemini'
import { toInteractionsInput } from '@main/agent/providers/geminiInteractions'
import {
  resolveSystemZones,
  supportsExplicitPromptCache,
  volatileSessionMessage
} from '@main/agent/providers/systemZones'
import type { ProviderChatRequest } from '@main/agent/providers/types'

describe('resolveSystemZones', () => {
  it('prefers stable/volatile split over combined system', () => {
    expect(
      resolveSystemZones({
        system: 'STABLE\n\nVOLATILE',
        systemStable: 'STABLE',
        systemVolatile: 'VOLATILE'
      })
    ).toEqual({ stable: 'STABLE', volatile: 'VOLATILE' })
  })

  it('falls back to combined system when split is absent', () => {
    expect(resolveSystemZones({ system: 'ALL IN ONE' })).toEqual({ stable: 'ALL IN ONE' })
  })
})

describe('OpenAI-compat trailing volatile', () => {
  const history = [
    { role: 'user' as const, content: 'do the thing' },
    { role: 'assistant' as const, content: 'working' },
    { role: 'tool' as const, toolCallId: 'c1', toolName: 'read', content: 'file body' }
  ]

  it('puts stable first and volatile after history', () => {
    const msgs = toOpenAiMessages(history, 'ignored-combined', {
      systemStable: 'HARNESS',
      systemVolatile: '<session>\nDate (UTC): now'
    })
    expect(msgs[0]).toEqual({ role: 'system', content: 'HARNESS' })
    expect(msgs[msgs.length - 1]).toEqual(
      volatileSessionMessage('<session>\nDate (UTC): now')
    )
    expect(msgs.slice(1, -1).map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
  })

  it('marks explicit cache breakpoint on stable system for GPT-5.6', () => {
    const body = buildOpenAiCompatBody(
      {
        model: 'gpt-5.6',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        system: 'ignored',
        systemStable: 'STABLE PREFIX',
        systemVolatile: 'CLOCK',
        promptCacheKey: 'run-1',
        signal: new AbortController().signal
      },
      { defaultBaseUrl: 'https://api.openai.com/v1', enablePromptCache: true }
    )
    expect(body.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' })
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({
      role: 'system',
      content: [
        {
          type: 'text',
          text: 'STABLE PREFIX',
          prompt_cache_breakpoint: { mode: 'explicit' }
        }
      ]
    })
    // Second breakpoint on last history message so volatile stays outside the cached prefix.
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'hi',
          prompt_cache_breakpoint: { mode: 'explicit' }
        }
      ]
    })
    expect(messages[messages.length - 1]).toEqual(volatileSessionMessage('CLOCK'))
  })

  it('does not enable explicit mode without a breakpoint-capable model', () => {
    expect(supportsExplicitPromptCache('gpt-4o')).toBe(false)
    expect(supportsExplicitPromptCache('gpt-5.6')).toBe(true)
    expect(supportsExplicitPromptCache('gpt-5.7-preview')).toBe(true)
    const body = buildOpenAiCompatBody(
      {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        systemStable: 'STABLE',
        systemVolatile: 'VOL',
        promptCacheKey: 'run-1',
        signal: new AbortController().signal
      },
      { defaultBaseUrl: 'https://api.openai.com/v1', enablePromptCache: true }
    )
    expect(body.prompt_cache_options).toBeUndefined()
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'system', content: 'STABLE' })
  })
})

describe('Responses / Gemini trailing volatile', () => {
  it('Responses: stable developer + history breakpoint + trailing user volatile', () => {
    const input = toResponsesInput(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'ok' },
        { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'body' }
      ],
      'ignored',
      undefined,
      {
        explicitPromptCache: true,
        systemStable: 'DEV STABLE',
        systemVolatile: 'SNAP'
      }
    )
    expect(input[0]).toEqual({
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: 'DEV STABLE',
          prompt_cache_breakpoint: { mode: 'explicit' }
        }
      ]
    })
    // Walks back past function_call_output; marks assistant text instead.
    expect(input[2]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'input_text',
          text: 'ok',
          prompt_cache_breakpoint: { mode: 'explicit' }
        }
      ]
    })
    expect(input[input.length - 1]).toEqual({
      role: 'user',
      content: volatileSessionMessage('SNAP').content
    })
  })

  it('Responses: stable developer + trailing user volatile', () => {
    const input = toResponsesInput(
      [{ role: 'user', content: 'hi' }],
      'ignored',
      undefined,
      {
        explicitPromptCache: true,
        systemStable: 'DEV STABLE',
        systemVolatile: 'SNAP'
      }
    )
    expect(input[0]).toEqual({
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: 'DEV STABLE',
          prompt_cache_breakpoint: { mode: 'explicit' }
        }
      ]
    })
    expect(input[1]).toEqual({
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'hi',
          prompt_cache_breakpoint: { mode: 'explicit' }
        }
      ]
    })
    expect(input[input.length - 1]).toEqual({
      role: 'user',
      content: volatileSessionMessage('SNAP').content
    })
  })

  it('Gemini generateContent: stable systemInstruction, volatile in contents tail', () => {
    // streamChat generateContent path builds the wire body via buildGeminiBody(req).
    const req: ProviderChatRequest = {
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      system: 'ignored',
      systemStable: 'GEM STABLE',
      systemVolatile: 'GEM VOL',
      signal: new AbortController().signal
    }
    const body = buildGeminiBody(req)
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'GEM STABLE' }] })
    const contents = body.contents as Array<{ role: string; parts: Array<{ text: string }> }>
    // Volatile merges into the trailing user entry: history ends on a user turn,
    // and two consecutive user contents entries are invalid for the Gemini API.
    expect(contents).toHaveLength(1)
    expect(contents[0]).toEqual({
      role: 'user',
      parts: [{ text: 'hi' }, { text: volatileSessionMessage('GEM VOL').content }]
    })
    // Combined system must not leak into systemInstruction when zones are set.
    expect(JSON.stringify(body.systemInstruction)).not.toContain('GEM VOL')
  })

  it('Gemini Interactions: stable first text, volatile last', () => {
    const parts = toInteractionsInput(
      [{ role: 'user', content: 'hi' }],
      'ignored',
      false,
      { systemStable: 'I STABLE', systemVolatile: 'I VOL' }
    ) as Array<{ type: string; text?: string }>
    expect(parts[0]).toEqual({ type: 'text', text: 'I STABLE' })
    expect(parts[parts.length - 1]).toEqual({
      type: 'text',
      text: volatileSessionMessage('I VOL').content
    })
  })
})
