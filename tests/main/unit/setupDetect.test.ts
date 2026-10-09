import { describe, expect, it, vi } from 'vitest'
import { detectSetupOptions, envKeyFor, localModelIds } from '@main/app/setupDetect'

/** Set up's offers: keys already in the environment, and model servers running here. */
describe('setup detection', () => {
  it('names providers with a plausible key in the environment, never the key, skipping saved ones', async () => {
    const env = {
      ANTHROPIC_API_KEY: 'sk-ant-0123456789abcdef',
      OPENAI_API_KEY: 'short',
      GOOGLE_API_KEY: 'AIza0123456789abcdefXYZ',
      GROQ_API_KEY: 'gsk_0123456789abcdefgh'
    }
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const found = await detectSetupOptions({ env, fetchImpl: fetchImpl as unknown as typeof fetch, hasKey: (p) => p === 'groq' })
    expect(found.envKeys).toEqual([
      { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
      { provider: 'gemini', envVar: 'GOOGLE_API_KEY' }
    ])
    expect(JSON.stringify(found)).not.toContain('sk-ant')
    expect(found.local).toEqual([])
    expect(envKeyFor('anthropic', env)?.value).toBe('sk-ant-0123456789abcdef')
  })

  it('finds Ollama and LM Studio by their model lists', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('11434')) return new Response(JSON.stringify({ models: [{ name: 'llama3.2:3b' }] }), { status: 200 })
      return new Response(JSON.stringify({ data: [{ id: 'qwen3-8b' }, { id: 'phi-4' }] }), { status: 200 })
    })
    const found = await detectSetupOptions({ env: {}, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(found.local).toEqual([
      { id: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', models: ['llama3.2:3b'] },
      { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', models: ['qwen3-8b', 'phi-4'] }
    ])
    expect(localModelIds({ nothing: true })).toEqual([])
  })
})
