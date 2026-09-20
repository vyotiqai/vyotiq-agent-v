/**
 * Renders the third-party marks the site displays into public/brand/.
 *
 * Kept separate from bake-brand.mjs because the sources differ: bake-brand
 * copies Vyotiq's own kit and the marketplace icons out of the repo, while
 * this reads icon packages out of the ROOT node_modules. It must therefore run
 * after bake-brand, which rmSync's public/brand on every build.
 *
 * Nothing is added to landing/package.json: the packages are already root
 * dependencies of the application, resolved the same way capture-shots.mjs
 * reaches @playwright/test. Trademarks remain the property of their owners;
 * only the path data is openly licensed. See NOTICE.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const landing = join(here, '..')
const repo = join(landing, '..')
const require = createRequire(join(repo, 'package.json'))

const providerOut = join(landing, 'public/brand/providers')
const platformOut = join(landing, 'public/brand/platforms')

const appFile = join(landing, 'src/data/app.json')
if (!existsSync(appFile)) {
  console.error('[bake-logos] src/data/app.json missing — bake-app-data.mjs must run first')
  process.exit(1)
}
const app = JSON.parse(readFileSync(appFile, 'utf8'))

/* ------------------------------------------------------------- contrast --- */

/*
 * The app only tints a provider mark with its own brand colour when that
 * colour stays legible; see providerBrandColor.ts. Deciding it here, against
 * the real surface tokens, means the component never has to guess.
 */
const SURFACES = ['#ffffff', '#f7fafc', '#eef5f9', '#141414', '#1a1e20', '#202528']

function luminance(hex) {
  const n = hex.replace('#', '')
  const full = n.length === 3 ? [...n].map((c) => c + c).join('') : n
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

/** A mark may keep its brand colour only if it clears 3:1 on every surface. */
const tintSafe = (hex) => SURFACES.every((s) => contrast(hex, s) >= 3)

/* ------------------------------------------------------- provider marks --- */

/*
 * Every provider the application offers, mapped to its @lobehub/icons brand
 * directory. "custom" has no brand: the app draws a Phosphor plug for it
 * (ProviderLogo.tsx), so the site draws the same glyph.
 */
const LOBEHUB = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  ollama: 'Ollama',
  deepseek: 'DeepSeek',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  xai: 'XAI',
  mistral: 'Mistral',
  opencode: 'OpenCode'
}
const PHOSPHOR = { custom: 'plugs-connected' }

const svg = (viewBox, body, title, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="currentColor"${extra}>` +
  `<title>${title}</title>${body}</svg>\n`

function lobehubMark(brand, label) {
  let file
  try {
    file = require.resolve(`@lobehub/icons/es/${brand}/components/Mono.js`)
  } catch {
    console.error(`[bake-logos] @lobehub/icons has no Mono component for ${brand}`)
    process.exit(1)
  }
  const src = readFileSync(file, 'utf8')

  const viewBox = src.match(/viewBox:\s*"([^"]+)"/)?.[1]
  const paths = [...src.matchAll(/d:\s*"([^"]+)"/g)].map((m) => m[1])
  if (!viewBox || paths.length !== 1) {
    // An upgrade that splits the mark into groups or gradients must break the
    // build rather than ship a half-drawn logo.
    console.error(
      `[bake-logos] ${brand}: expected one path and a viewBox, found ${paths.length} path(s)` +
        `${viewBox ? '' : ' and no viewBox'} — the icon package changed shape`
    )
    process.exit(1)
  }
  const fillRule = src.match(/fillRule:\s*"([^"]+)"/)?.[1]

  const styleFile = require.resolve(`@lobehub/icons/es/${brand}/style.js`)
  const colorPrimary = readFileSync(styleFile, 'utf8').match(/COLOR_PRIMARY\s*=\s*'([^']+)'/)?.[1]
  if (!colorPrimary) {
    console.error(`[bake-logos] ${brand}: no COLOR_PRIMARY in style.js`)
    process.exit(1)
  }

  return {
    svg: svg(viewBox, `<path d="${paths[0]}"/>`, label, fillRule ? ` fill-rule="${fillRule}"` : ''),
    colorPrimary,
    source: '@lobehub/icons',
    license: 'MIT'
  }
}

function phosphorMark(name, label) {
  const file = require.resolve(`@phosphor-icons/core/assets/regular/${name}.svg`)
  const raw = readFileSync(file, 'utf8')
  const viewBox = raw.match(/viewBox="([^"]+)"/)?.[1]
  const body = raw.match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1]?.trim()
  if (!viewBox || !body) {
    console.error(`[bake-logos] ${name}: could not read the Phosphor glyph`)
    process.exit(1)
  }
  return {
    svg: svg(viewBox, body, label),
    colorPrimary: null,
    source: '@phosphor-icons/core',
    license: 'MIT'
  }
}

mkdirSync(providerOut, { recursive: true })

const manifest = { providers: [], platforms: [] }

for (const { id, label } of app.providers.list) {
  const mark = LOBEHUB[id]
    ? lobehubMark(LOBEHUB[id], label)
    : PHOSPHOR[id]
      ? phosphorMark(PHOSPHOR[id], label)
      : null
  if (!mark) {
    // A provider added to the app without a mark here would otherwise render a
    // hole in the logo wall.
    console.error(`[bake-logos] no mark mapped for provider "${id}" (${label})`)
    process.exit(1)
  }
  writeFileSync(join(providerOut, `${id}.svg`), mark.svg, 'utf8')
  manifest.providers.push({
    id,
    label,
    file: `/brand/providers/${id}.svg`,
    colorPrimary: mark.colorPrimary,
    tintSafe: mark.colorPrimary ? tintSafe(mark.colorPrimary) : false,
    source: mark.source,
    license: mark.license
  })
}

/* ------------------------------------------------------- platform marks --- */

/*
 * Simple Icons no longer ships a Windows mark, so all three come from Font
 * Awesome's free brand set — the same fallback sync-marketplace-brand-icons.mjs
 * already takes for Slack.
 */
const brands = require('@fortawesome/free-brands-svg-icons')
const PLATFORMS = [
  { id: 'windows', icon: 'faWindows', label: 'Windows' },
  { id: 'macos', icon: 'faApple', label: 'macOS' },
  { id: 'linux', icon: 'faLinux', label: 'Linux' }
]

mkdirSync(platformOut, { recursive: true })

for (const { id, icon, label } of PLATFORMS) {
  const def = brands[icon]
  if (!def?.icon) {
    console.error(`[bake-logos] @fortawesome/free-brands-svg-icons has no ${icon}`)
    process.exit(1)
  }
  const [width, height, , , path] = def.icon
  if (typeof path !== 'string') {
    console.error(`[bake-logos] ${icon} is drawn from multiple paths — the package changed shape`)
    process.exit(1)
  }
  writeFileSync(
    join(platformOut, `${id}.svg`),
    svg(`0 0 ${width} ${height}`, `<path d="${path}"/>`, label),
    'utf8'
  )
  manifest.platforms.push({
    id,
    label,
    file: `/brand/platforms/${id}.svg`,
    source: '@fortawesome/free-brands-svg-icons',
    license: 'CC-BY-4.0'
  })
}

writeFileSync(
  join(landing, 'src/data/logos.json'),
  JSON.stringify(manifest, null, 2) + '\n',
  'utf8'
)

const tinted = manifest.providers.filter((p) => p.tintSafe).length
console.log(
  `[bake-logos] ${manifest.providers.length} provider marks (${tinted} tint-safe) · ` +
    `${manifest.platforms.length} platform marks`
)
