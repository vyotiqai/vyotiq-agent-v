import { describe, expect, it } from 'vitest'
import {
  formatProviderHttpError,
  isOpenRouterNoEndpointsError,
  parseOpenRouterAffordableOutputTokens,
  parseRejectedBodyField,
  shouldRetryOmitIncludeUsage,
  shouldRetryOpenRouterCompatBody,
  shouldRetrySanitizeToolSchema,
  stripRejectedBodyField
} from '@main/agent/providers/httpErrors'

const OPENROUTER_402 = JSON.stringify({
  error: {
    message:
      'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 54013. To increase, visit https://openrouter.ai/settings/credits and add more credits',
    code: 402
  }
})

const OPENROUTER_NO_ENDPOINTS = JSON.stringify({
  error: {
    message:
      'No endpoints available matching your guardrail restrictions and data policy. Configure: https://openrouter.ai/settings/privacy',
    code: 404
  }
})

describe('formatProviderHttpError', () => {
  it('formats OpenRouter 402 with affordable token hint', () => {
    const msg = formatProviderHttpError(402, OPENROUTER_402, 'openrouter')
    expect(msg).toMatch(/OpenRouter credits are insufficient/i)
    expect(msg).toMatch(/54,013/)
    expect(msg).toMatch(/openrouter\.ai\/settings\/credits/)
    expect(msg).not.toMatch(/HTTP 402/)
  })

  it('enriches OpenRouter no-endpoints / data-policy 404', () => {
    const msg = formatProviderHttpError(404, OPENROUTER_NO_ENDPOINTS, 'openrouter')
    expect(msg).toMatch(/privacy\/guardrail/i)
    expect(msg).toMatch(/openrouter\.ai\/settings\/privacy/)
    expect(msg).toMatch(/another model/i)
    expect(msg).not.toMatch(/HTTP 404/)
  })

  it('extracts provider JSON message for generic errors', () => {
    const body = JSON.stringify({ error: { message: 'Invalid model id' } })
    expect(formatProviderHttpError(400, body, 'openrouter')).toBe('Invalid model id')
  })

  it('unwraps OpenRouter nested metadata.raw under Provider returned error', () => {
    const body = JSON.stringify({
      error: {
        message: 'Provider returned error',
        code: 400,
        metadata: {
          raw: JSON.stringify({
            error: {
              message: 'The encrypted content for item rs_abc could not be verified.',
              type: 'invalid_request_error'
            }
          })
        }
      }
    })
    expect(formatProviderHttpError(400, body, 'openrouter')).toMatch(/encrypted content/i)
  })

  it('scrubs API key-shaped secrets from provider messages', () => {
    const body = JSON.stringify({
      error: { message: 'Invalid key sk-abcdefghijklmnopqrstuvwxyz012345' }
    })
    const msg = formatProviderHttpError(400, body, 'openai')
    expect(msg).toContain('[redacted]')
    expect(msg).not.toMatch(/sk-abcdefghijklmnopqrstuvwxyz/)
  })

  it('scrubs combined wk-…ws-… tokens echoed without a Bearer prefix', () => {
    const body = JSON.stringify({
      error: { message: 'invalid token wk-Ab12Cd34.ws-Xy56Zv78 for workspace' }
    })
    const msg = formatProviderHttpError(401, body, 'custom')
    expect(msg).toContain('[redacted]')
    expect(msg).not.toContain('wk-Ab12Cd34.ws-Xy56Zv78')
  })

  it('scrubs Google/Groq/xAI key shapes and escaped api_key separators', () => {
    const msg = formatProviderHttpError(
      400,
      JSON.stringify({
        error: {
          message:
            'bad keys AIzaSyA1234567890abcdefghijklmnop gsk_abcdefghijklmnopqrstuvwxyz012345 xai-abcdefghijklmnopqrstuvwxyz01 api_key\\":\\"abcdef123456'
        }
      }),
      'openai'
    )
    expect(msg).toContain('[redacted]')
    expect(msg).not.toContain('AIzaSyA1234567890abcdefghijklmnop')
    expect(msg).not.toContain('gsk_abcdefghijklmnopqrstuvwxyz012345')
    expect(msg).not.toContain('xai-abcdefghijklmnopqrstuvwxyz01')
    expect(msg).not.toContain('abcdef123456')
  })

  it('redacts Bearer tokens containing URL-safe punctuation', () => {
    const msg = formatProviderHttpError(
      401,
      JSON.stringify({ error: { message: 'Bearer abc~def/ghi+123= rejected' } }),
      'custom'
    )
    expect(msg).toContain('[redacted]')
    expect(msg).not.toContain('abc~def/ghi+123=')
  })

  it('extracts bare string error bodies for generic OpenAI-compat hosts', () => {
    const msg = formatProviderHttpError(404, '{"error":"unknown inference model"}', 'custom')
    expect(msg).toBe('unknown inference model')
  })

  it('maps auth failures to a settings hint', () => {
    expect(formatProviderHttpError(401, '', 'openai')).toMatch(/API key/i)
  })
})

describe('parseOpenRouterAffordableOutputTokens', () => {
  it('parses affordable output tokens from 402 body', () => {
    expect(parseOpenRouterAffordableOutputTokens(OPENROUTER_402)).toBe(54013)
  })
})

describe('shouldRetryOpenRouterCompatBody', () => {
  it('retries all OpenRouter HTTP 400s', () => {
    expect(shouldRetryOpenRouterCompatBody(400, '{"error":{"message":"bad request"}}')).toBe(true)
  })

  it('retries 404 only for no-endpoints / data-policy messages', () => {
    expect(shouldRetryOpenRouterCompatBody(404, OPENROUTER_NO_ENDPOINTS)).toBe(true)
    expect(
      shouldRetryOpenRouterCompatBody(
        404,
        JSON.stringify({ error: { message: 'Model not found' } })
      )
    ).toBe(false)
  })

  it('does not retry unrelated statuses', () => {
    expect(shouldRetryOpenRouterCompatBody(429, OPENROUTER_NO_ENDPOINTS)).toBe(false)
    expect(shouldRetryOpenRouterCompatBody(500, OPENROUTER_NO_ENDPOINTS)).toBe(false)
  })
})

describe('isOpenRouterNoEndpointsError', () => {
  it('detects guardrail / data-policy wording on 404', () => {
    expect(isOpenRouterNoEndpointsError(404, OPENROUTER_NO_ENDPOINTS)).toBe(true)
  })

  it('rejects unrelated 404 bodies', () => {
    expect(
      isOpenRouterNoEndpointsError(404, JSON.stringify({ error: { message: 'Not found' } }))
    ).toBe(false)
  })
})

describe('shouldRetryOmitIncludeUsage', () => {
  it('retries 400/422 when body mentions stream_options or include_usage', () => {
    expect(
      shouldRetryOmitIncludeUsage(
        400,
        JSON.stringify({ error: { message: 'Extra inputs are not permitted: stream_options' } })
      )
    ).toBe(true)
    expect(
      shouldRetryOmitIncludeUsage(
        422,
        JSON.stringify({ message: 'Unknown parameter: include_usage' })
      )
    ).toBe(true)
  })

  it('does not retry unrelated errors', () => {
    expect(
      shouldRetryOmitIncludeUsage(400, JSON.stringify({ error: { message: 'invalid model' } }))
    ).toBe(false)
    expect(
      shouldRetryOmitIncludeUsage(500, 'stream_options include_usage')
    ).toBe(false)
  })
})

describe('parseRejectedBodyField', () => {
  it('names the optional field on Console Go / Go strict-decode rejections', () => {
    const body = JSON.stringify({
      error: {
        message: 'invalid request body: json: unknown field "include_reasoning"',
        type: 'invalid_request_error'
      }
    })
    expect(parseRejectedBodyField(400, body)).toBe('include_reasoning')
  })

  it('handles Python-style unknown parameter / extra inputs wording', () => {
    expect(
      parseRejectedBodyField(
        422,
        JSON.stringify({ error: { message: 'Unknown parameter: service_tier' } })
      )
    ).toBe('service_tier')
    expect(
      parseRejectedBodyField(
        400,
        '{"detail":[{"msg":"Extra inputs are not permitted: prompt_cache_key"}]}'
      )
    ).toBe('prompt_cache_key')
  })

  it('never names required or capability-bearing fields', () => {
    expect(
      parseRejectedBodyField(400, '{"error":{"message":"json: unknown field \\"tools\\""}}')
    ).toBeUndefined()
    expect(
      parseRejectedBodyField(400, '{"error":{"message":"json: unknown field \\"messages\\""}}')
    ).toBeUndefined()
    expect(
      parseRejectedBodyField(400, '{"error":{"message":"json: unknown field \\"model\\""}}')
    ).toBeUndefined()
  })

  it('only fires on 400/422 bodies that name a strippable field', () => {
    expect(
      parseRejectedBodyField(
        500,
        JSON.stringify({ error: { message: 'json: unknown field "include_reasoning"' } })
      )
    ).toBeUndefined()
    expect(
      parseRejectedBodyField(400, JSON.stringify({ error: { message: 'invalid model' } }))
    ).toBeUndefined()
    expect(parseRejectedBodyField(429, 'unknown field "include_reasoning"')).toBeUndefined()
  })

  it('tolerates escaped quotes from unparsed error wrappers', () => {
    expect(parseRejectedBodyField(400, 'json: unknown field \\"include_reasoning\\"')).toBe(
      'include_reasoning'
    )
    expect(
      parseRejectedBodyField(422, 'Unknown parameter: \\"service_tier\\"')
    ).toBe('service_tier')
  })

  it('trims sentence punctuation from unquoted field names', () => {
    expect(parseRejectedBodyField(422, 'Unknown parameter: service_tier.')).toBe('service_tier')
    expect(
      parseRejectedBodyField(400, 'Extra inputs are not permitted: stream_options.')
    ).toBe('stream_options')
  })

  it('never strips semantic-contract fields (structured output, caps, sampling)', () => {
    for (const field of ['response_format', 'max_tokens', 'temperature', 'stop']) {
      expect(
        parseRejectedBodyField(
          400,
          JSON.stringify({ error: { message: `json: unknown field "${field}"` } })
        )
      ).toBeUndefined()
    }
  })
})

describe('stripRejectedBodyField', () => {
  it('strips the named field from the body root, messages, and content parts', () => {
    const body: Record<string, unknown> = {
      model: 'm',
      reasoning_content: 'top',
      messages: [
        {
          role: 'assistant',
          reasoning_content: 'replayed',
          content: [
            { type: 'text', text: 'hi', prompt_cache_breakpoint: { mode: 'explicit' } },
            { type: 'text', text: 'there' }
          ]
        }
      ],
      input: [
        {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'x', prompt_cache_breakpoint: { mode: 'explicit' } }]
        }
      ]
    }

    stripRejectedBodyField(body, 'reasoning_content')
    stripRejectedBodyField(body, 'prompt_cache_breakpoint')

    expect(body.reasoning_content).toBeUndefined()
    const message = (body.messages as Array<Record<string, unknown>>)[0]!
    expect(message.reasoning_content).toBeUndefined()
    const parts = message.content as Array<Record<string, unknown>>
    expect(parts.every((p) => p.prompt_cache_breakpoint === undefined)).toBe(true)
    expect(parts.map((p) => p.text)).toEqual(['hi', 'there'])
    const inputParts = (body.input as Array<Record<string, unknown>>)[0]!.content as Array<
      Record<string, unknown>
    >
    expect(inputParts[0]!.prompt_cache_breakpoint).toBeUndefined()
  })
})

describe('shouldRetrySanitizeToolSchema', () => {
  it('matches unsupported tool-schema rejections on 400/422', () => {
    expect(
      shouldRetrySanitizeToolSchema(
        400,
        JSON.stringify({
          error: { message: 'unsupported_tool_schema: The tool schema is not supported (unsupported_keyword)' }
        })
      )
    ).toBe(true)
    expect(
      shouldRetrySanitizeToolSchema(422, JSON.stringify({ message: 'unsupported_keyword' }))
    ).toBe(true)
  })

  it('does not match unrelated errors or statuses', () => {
    expect(shouldRetrySanitizeToolSchema(400, '{"error":{"message":"invalid model"}}')).toBe(false)
    expect(shouldRetrySanitizeToolSchema(500, 'unsupported_keyword')).toBe(false)
  })
})
