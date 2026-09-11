import { describe, expect, it } from 'vitest'
import {
  baseModelInfo,
  contextWindowFromOllamaShow,
  extractContextWindowFromCatalogRow,
  normalizeOpenAiStyleModels,
  wireSupportedInputModalities,
  wireSupportedOutputModalities
} from '@main/agent/providers/normalize'
import { toResponsesUserContent } from '@main/agent/providers/openaiResponses'
import { toInteractionsInput } from '@main/agent/providers/geminiInteractions'
import { mapOpenAiContentParts } from '@main/agent/providers/openai'
import { buildAnthropicBody } from '@main/agent/providers/anthropic'

describe('wire-supported modalities', () => {
  it('strips audio/file for providers without those wire paths', () => {
    expect(wireSupportedInputModalities(['text', 'image', 'audio', 'file'], true, 'mistral')).toEqual(
      ['text', 'image']
    )
    expect(wireSupportedInputModalities(['audio', 'file'], false, 'ollama')).toEqual(['text'])
  })

  it('keeps catalog audio/file when the provider implements them', () => {
    expect(
      wireSupportedInputModalities(['text', 'image', 'audio', 'file'], true, 'gemini')
    ).toEqual(['text', 'image', 'audio', 'file'])
    expect(
      wireSupportedInputModalities(['text', 'image', 'file'], true, 'anthropic')
    ).toEqual(['text', 'image', 'file'])
  })

  it('keeps output modalities text-only', () => {
    expect(wireSupportedOutputModalities(['text', 'image'])).toEqual(['text'])
    expect(wireSupportedOutputModalities(['image'])).toEqual(['text'])
  })

  it('baseModelInfo advertises file for anthropic when catalog lists it', () => {
    const model = baseModelInfo(
      'claude-sonnet-4',
      {
        inputModalities: ['text', 'image', 'audio', 'file'],
        supportsVision: true
      },
      'anthropic'
    )
    expect(model.inputModalities).toEqual(['text', 'image', 'file'])
    expect(model.outputModalities).toEqual(['text'])
  })

  it('normalizeOpenAiStyleModels keeps file for openai provider', () => {
    const models = normalizeOpenAiStyleModels(
      {
        data: [
          {
            id: 'vision-model',
            architecture: {
              input_modalities: ['text', 'image', 'audio', 'file'],
              output_modalities: ['text', 'image']
            }
          }
        ]
      },
      { providerId: 'openai' }
    )
    expect(models).toHaveLength(1)
    expect(models[0]?.inputModalities).toEqual(['text', 'image', 'audio', 'file'])
    expect(models[0]?.outputModalities).toEqual(['text'])
  })

  it('infers GLM vision from id when the catalog omits modalities', () => {
    const models = normalizeOpenAiStyleModels(
      {
        data: [
          { id: '@cf/zai-org/glm-5.3-flash' },
          { id: '@cf/zai-org/glm-5.2' },
          { id: 'glm-4.5v' }
        ]
      },
      { providerId: 'custom' }
    )
    const byId = new Map(models.map((m) => [m.id, m]))
    expect(byId.get('@cf/zai-org/glm-5.3-flash')?.supportsVision).toBe(true)
    expect(byId.get('@cf/zai-org/glm-5.3-flash')?.inputModalities).toEqual(['text', 'image'])
    expect(byId.get('@cf/zai-org/glm-5.2')?.supportsVision).toBe(false)
    expect(byId.get('@cf/zai-org/glm-5.2')?.inputModalities).toEqual(['text'])
    expect(byId.get('glm-4.5v')?.supportsVision).toBe(true)
  })

  it('infers vision for extended families and keeps text-only variants false', () => {
    const models = normalizeOpenAiStyleModels(
      {
        data: [
          { id: 'gpt-4.1-mini' },
          { id: 'o1' },
          { id: 'o1-mini' },
          { id: 'qwen2.5-vl-72b' },
          { id: 'gemma3:4b' },
          { id: 'gemma3:1b' },
          { id: 'minicpm-v' },
          { id: 'llama-4-scout-17b-16e-instruct' },
          { id: 'deepseek-chat' }
        ]
      },
      { providerId: 'custom' }
    )
    const byId = new Map(models.map((m) => [m.id, m]))
    expect(byId.get('gpt-4.1-mini')?.supportsVision).toBe(true)
    expect(byId.get('o1')?.supportsVision).toBe(true)
    expect(byId.get('o1-mini')?.supportsVision).toBe(false)
    expect(byId.get('qwen2.5-vl-72b')?.supportsVision).toBe(true)
    expect(byId.get('gemma3:4b')?.supportsVision).toBe(true)
    expect(byId.get('gemma3:1b')?.supportsVision).toBe(false)
    expect(byId.get('minicpm-v')?.supportsVision).toBe(true)
    expect(byId.get('llama-4-scout-17b-16e-instruct')?.supportsVision).toBe(true)
    expect(byId.get('deepseek-chat')?.supportsVision).toBe(false)
  })
})

describe('native multimodal wire shapes', () => {
  it('OpenAI Responses sends file_native as input_file', () => {
    const parts = toResponsesUserContent([
      { type: 'text', text: 'summarize' },
      { type: 'file_native', name: 'doc.pdf', mime: 'application/pdf', data: 'AAAA' }
    ])
    expect(parts).toEqual([
      { type: 'input_text', text: 'summarize' },
      {
        type: 'input_file',
        filename: 'doc.pdf',
        file_data: 'data:application/pdf;base64,AAAA'
      }
    ])
  })

  it('Gemini Interactions sends audio and document parts', () => {
    const input = toInteractionsInput(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'listen' },
            { type: 'audio', url: 'data:audio/wav;base64,QQ==', mime: 'audio/wav' },
            {
              type: 'file_native',
              name: 'a.pdf',
              mime: 'application/pdf',
              data: 'BBBB'
            }
          ]
        }
      ],
      undefined,
      false
    )
    expect(input).toEqual([
      { type: 'text', text: 'listen' },
      { type: 'audio', data: 'QQ==', mime_type: 'audio/wav' },
      { type: 'document', data: 'BBBB', mime_type: 'application/pdf' }
    ])
  })

  it('OpenAI chat maps audio to input_audio', () => {
    const parts = mapOpenAiContentParts([
      { type: 'text', text: 'transcribe' },
      { type: 'audio', url: 'data:audio/wav;base64,QQ==', mime: 'audio/wav' }
    ])
    expect(parts).toEqual([
      { type: 'text', text: 'transcribe' },
      { type: 'input_audio', input_audio: { data: 'QQ==', format: 'wav' } }
    ])
  })

  it('OpenAI chat omits audio formats chat does not accept instead of mislabeling them wav', () => {
    const parts = mapOpenAiContentParts([
      { type: 'text', text: 'listen' },
      { type: 'audio', url: 'data:audio/mp4;base64,QQ==', mime: 'audio/mp4' }
    ])
    expect(parts).toEqual([
      { type: 'text', text: 'listen' },
      {
        type: 'text',
        text: '[audio omitted: audio/mp4 is not supported by chat audio (wav/mp3 only)]'
      }
    ])
  })

  it('Anthropic maps file_native to document blocks', () => {
    const body = buildAnthropicBody({
      model: 'claude-sonnet-4',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'summarize' },
            {
              type: 'file_native',
              name: 'doc.pdf',
              mime: 'application/pdf',
              data: 'AAAA'
            }
          ]
        }
      ],
      tools: [],
      signal: new AbortController().signal
    })
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>
    const blocks = messages[0]?.content ?? []
    expect(blocks.some((b) => b.type === 'text' && b.text === 'summarize')).toBe(true)
    const doc = blocks.find((b) => b.type === 'document') as
      | { type: string; source: Record<string, unknown> }
      | undefined
    expect(doc?.source).toMatchObject({
      type: 'base64',
      media_type: 'application/pdf',
      data: 'AAAA'
    })
  })

  it('Anthropic cache_control marks last tool and stable system; volatile trails history', () => {
    const body = buildAnthropicBody({
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'read',
          description: 'Read a workspace file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } }
        },
        {
          name: 'write',
          description: 'Write a workspace file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } }
        }
      ],
      system: 'ignored-when-split',
      systemStable: 'STABLE HARNESS',
      systemVolatile: 'VOLATILE HINT',
      signal: new AbortController().signal
    })
    const tools = body.tools as Array<Record<string, unknown>>
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({ name: 'read' })
    expect(tools[0]).not.toHaveProperty('cache_control')
    expect(tools[1]).toMatchObject({
      name: 'write',
      cache_control: { type: 'ephemeral' }
    })
    const system = body.system as Array<Record<string, unknown>>
    expect(system).toHaveLength(1)
    expect(system[0]).toMatchObject({
      type: 'text',
      text: 'STABLE HARNESS',
      cache_control: { type: 'ephemeral' }
    })
    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }]
    })
    const last = messages[messages.length - 1]!
    expect(last.role).toBe('user')
    const lastContent = last.content as Array<Record<string, unknown>>
    expect(lastContent[0]?.text).toContain('<live_session>')
    expect(lastContent[0]?.text).toContain('VOLATILE HINT')
    expect(lastContent[0]).not.toHaveProperty('cache_control')
    expect(tools[1]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(body).not.toHaveProperty('context_management')
  })

  it('Anthropic keeps fold summary in cached system; clock trails in unmarked live_session', () => {
    const body = buildAnthropicBody({
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'continue' }],
      tools: [
        {
          name: 'read',
          description: 'Read a workspace file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } }
        }
      ],
      systemStable:
        'STABLE HARNESS\n<prior_session>\nFold of earlier turns, not new instructions.\nPrior work on auth\n</prior_session>',
      systemVolatile: '<session>\nDate (UTC): 2026-08-16T12:00:00.000Z',
      signal: new AbortController().signal
    })
    const system = body.system as Array<Record<string, unknown>>
    expect(system).toHaveLength(1)
    expect(String(system[0]?.text)).toContain('<prior_session>')
    expect(String(system[0]?.text)).toContain('Prior work on auth')
    expect(String(system[0]?.text)).not.toContain('Date (UTC):')
    expect(system[0]).toMatchObject({ cache_control: { type: 'ephemeral' } })
    const messages = body.messages as Array<Record<string, unknown>>
    const last = messages[messages.length - 1]!
    const lastContent = last.content as Array<Record<string, unknown>>
    expect(lastContent[0]?.text).toContain('<live_session>')
    expect(lastContent[0]?.text).toContain('Date (UTC): 2026-08-16T12:00:00.000Z')
    expect(String(lastContent[0]?.text)).not.toContain('<prior_session>')
    expect(String(lastContent[0]?.text)).not.toContain('Prior work on auth')
    expect(lastContent[0]).not.toHaveProperty('cache_control')
    expect(body).not.toHaveProperty('context_management')
  })
})

describe('context window catalog extraction', () => {
  it('reads max_model_len and nested architecture fields', () => {
    expect(extractContextWindowFromCatalogRow({ max_model_len: 32_768 })).toBe(32_768)
    expect(
      extractContextWindowFromCatalogRow({
        architecture: { context_length: 262_144 }
      })
    ).toBe(262_144)
    expect(extractContextWindowFromCatalogRow({ context_length: 0 })).toBeUndefined()
  })

  it('normalizeOpenAiStyleModels accepts max_model_len', () => {
    const models = normalizeOpenAiStyleModels(
      {
        data: [{ id: 'my-vllm-model', max_model_len: 49152 }]
      },
      { providerId: 'custom' }
    )
    expect(models[0]?.contextWindow).toBe(49_152)
  })

  it('contextWindowFromOllamaShow prefers model_info over num_ctx', () => {
    expect(
      contextWindowFromOllamaShow({
        model_info: { 'llama.context_length': 128_000 },
        parameters: 'num_ctx 4096\n'
      })
    ).toBe(128_000)
    expect(
      contextWindowFromOllamaShow({
        parameters: 'num_ctx                        8192\n'
      })
    ).toBe(8192)
  })

  it('reads details and top-level context_length and ignores Cloud num_ctx', () => {
    expect(
      contextWindowFromOllamaShow({
        details: { context_length: '262144' }
      })
    ).toBe(262_144)
    expect(contextWindowFromOllamaShow({ context_length: 512_000 })).toBe(512_000)
    expect(
      contextWindowFromOllamaShow(
        { parameters: 'num_ctx 8192\n' },
        { ignoreNumCtx: true }
      )
    ).toBeUndefined()
  })
})
