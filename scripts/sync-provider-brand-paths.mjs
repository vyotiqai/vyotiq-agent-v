/**
 * Regenerate providerBrandPaths.ts from @lobehub/icons mono components.
 * Run: pnpm sync:provider-icons
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const outFile = path.join(
  root,
  'src/renderer/src/features/chat/components/composer/providerBrandPaths.ts'
)

/** Product slug -> @lobehub/icons package folder name */
const BRANDS = [
  ['anthropic', 'Anthropic'],
  ['arcee', 'Arcee'],
  ['cohere', 'Cohere'],
  ['deepseek', 'DeepSeek'],
  ['gemini', 'Gemini'],
  ['google', 'Google'],
  ['groq', 'Groq'],
  ['meta', 'Meta'],
  ['microsoft', 'Microsoft'],
  ['mistral', 'Mistral'],
  ['nvidia', 'Nvidia'],
  ['ollama', 'Ollama'],
  ['opencode', 'OpenCode'],
  ['openai', 'OpenAI'],
  ['openrouter', 'OpenRouter'],
  ['perplexity', 'Perplexity'],
  ['qwen', 'Qwen'],
  ['xai', 'XAI']
]

const ALIASES = {
  'meta-llama': 'meta',
  'x-ai': 'xai'
}

const loaderEntries = BRANDS.map(([slug, lobehub]) => {
  return `  ${slug}: loadBrand(
    () => import('@lobehub/icons/es/${lobehub}/components/Mono'),
    () => import('@lobehub/icons/es/${lobehub}/style')
  )`
})

const aliasLines = Object.entries(ALIASES).map(([alias, slug]) => `  '${alias}': '${slug}'`)

const content = `import type { ComponentType, CSSProperties } from 'react'

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
${loaderEntries.join(',\n')}
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
${aliasLines.join(',\n')}
}

export function resolveProviderBrandSlug(key: string): ProviderBrandSlug | undefined {
  const normalized = key.toLowerCase()
  if (normalized in PROVIDER_BRAND_LOADERS) return normalized as ProviderBrandSlug
  return PROVIDER_BRAND_ALIASES[normalized]
}
`

await writeFile(outFile, content, 'utf8')
console.log(
  `[sync-provider-brand-paths] wrote ${path.relative(root, outFile)} (${BRANDS.length} brands, dynamic import)`
)
