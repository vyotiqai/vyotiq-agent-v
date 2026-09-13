import type { ComponentType, CSSProperties } from 'react'

export type ProviderBrandData = {
  Component: ComponentType<{
    size?: number | string
    style?: CSSProperties
    className?: string
  }>
  colorPrimary: string
}

type BrandModule = { default: ProviderBrandData['Component'] }
type BrandStyle = { COLOR_PRIMARY: string }

function loadBrand(
  component: () => Promise<BrandModule>,
  style: () => Promise<BrandStyle>
): () => Promise<ProviderBrandData> {
  return async () => {
    const [mod, st] = await Promise.all([component(), style()])
    return { Component: mod.default, colorPrimary: st.COLOR_PRIMARY }
  }
}

const PROVIDER_BRAND_LOADERS = {
  anthropic: loadBrand(
    () => import('@lobehub/icons/es/Anthropic/components/Mono'),
    () => import('@lobehub/icons/es/Anthropic/style')
  ),
  arcee: loadBrand(
    () => import('@lobehub/icons/es/Arcee/components/Mono'),
    () => import('@lobehub/icons/es/Arcee/style')
  ),
  cohere: loadBrand(
    () => import('@lobehub/icons/es/Cohere/components/Mono'),
    () => import('@lobehub/icons/es/Cohere/style')
  ),
  deepseek: loadBrand(
    () => import('@lobehub/icons/es/DeepSeek/components/Mono'),
    () => import('@lobehub/icons/es/DeepSeek/style')
  ),
  gemini: loadBrand(
    () => import('@lobehub/icons/es/Gemini/components/Mono'),
    () => import('@lobehub/icons/es/Gemini/style')
  ),
  google: loadBrand(
    () => import('@lobehub/icons/es/Google/components/Mono'),
    () => import('@lobehub/icons/es/Google/style')
  ),
  groq: loadBrand(
    () => import('@lobehub/icons/es/Groq/components/Mono'),
    () => import('@lobehub/icons/es/Groq/style')
  ),
  meta: loadBrand(
    () => import('@lobehub/icons/es/Meta/components/Mono'),
    () => import('@lobehub/icons/es/Meta/style')
  ),
  microsoft: loadBrand(
    () => import('@lobehub/icons/es/Microsoft/components/Mono'),
    () => import('@lobehub/icons/es/Microsoft/style')
  ),
  mistral: loadBrand(
    () => import('@lobehub/icons/es/Mistral/components/Mono'),
    () => import('@lobehub/icons/es/Mistral/style')
  ),
  nvidia: loadBrand(
    () => import('@lobehub/icons/es/Nvidia/components/Mono'),
    () => import('@lobehub/icons/es/Nvidia/style')
  ),
  ollama: loadBrand(
    () => import('@lobehub/icons/es/Ollama/components/Mono'),
    () => import('@lobehub/icons/es/Ollama/style')
  ),
  opencode: loadBrand(
    () => import('@lobehub/icons/es/OpenCode/components/Mono'),
    () => import('@lobehub/icons/es/OpenCode/style')
  ),
  openai: loadBrand(
    () => import('@lobehub/icons/es/OpenAI/components/Mono'),
    () => import('@lobehub/icons/es/OpenAI/style')
  ),
  openrouter: loadBrand(
    () => import('@lobehub/icons/es/OpenRouter/components/Mono'),
    () => import('@lobehub/icons/es/OpenRouter/style')
  ),
  perplexity: loadBrand(
    () => import('@lobehub/icons/es/Perplexity/components/Mono'),
    () => import('@lobehub/icons/es/Perplexity/style')
  ),
  qwen: loadBrand(
    () => import('@lobehub/icons/es/Qwen/components/Mono'),
    () => import('@lobehub/icons/es/Qwen/style')
  ),
  xai: loadBrand(
    () => import('@lobehub/icons/es/XAI/components/Mono'),
    () => import('@lobehub/icons/es/XAI/style')
  )
} as const

export type ProviderBrandSlug = keyof typeof PROVIDER_BRAND_LOADERS

const cache = new Map<ProviderBrandSlug, ProviderBrandData>()
const inflight = new Map<ProviderBrandSlug, Promise<ProviderBrandData>>()

export function getCachedProviderBrand(slug: ProviderBrandSlug): ProviderBrandData | undefined {
  return cache.get(slug)
}

export function loadProviderBrand(slug: ProviderBrandSlug): Promise<ProviderBrandData> {
  const hit = cache.get(slug)
  if (hit) return Promise.resolve(hit)
  let pending = inflight.get(slug)
  if (!pending) {
    pending = PROVIDER_BRAND_LOADERS[slug]().then((data) => {
      cache.set(slug, data)
      inflight.delete(slug)
      return data
    })
    inflight.set(slug, pending)
  }
  return pending
}

export const PROVIDER_BRAND_ALIASES: Record<string, ProviderBrandSlug> = {
  'meta-llama': 'meta',
  'x-ai': 'xai'
}

export function resolveProviderBrandSlug(key: string): ProviderBrandSlug | undefined {
  const normalized = key.toLowerCase()
  if (normalized in PROVIDER_BRAND_LOADERS) return normalized as ProviderBrandSlug
  return PROVIDER_BRAND_ALIASES[normalized]
}
