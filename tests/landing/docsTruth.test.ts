import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { BUILTIN_TOOL_NAMES } from '@main/agent/schemas/tools'
import { BUILTIN_COMMANDS } from '@main/agent/slashCommands/builtins'
import {
  isProviderConfigured,
  listConfiguredProviders,
  PROVIDER_DEFAULTS
} from '@shared/providers'
import {
  DEFAULT_SETTINGS,
  emptySecretStatus,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_CHARS,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES
} from '@shared/ipc'
import {
  DICTATION_ENGINE_OPTIONS,
  SECTION_LABELS
} from '@renderer/features/settings/constants'
import { MAX_FILES } from '@renderer/features/chat/components/composer/useComposerFiles'
import { MAX_IMAGES } from '@renderer/features/chat/components/composer/useComposerImages'
import { MAX_AUDIO_FILES } from '@renderer/features/chat/components/composer/useComposerAudio'

const REPO = process.cwd()
const ROOT = join(REPO, 'landing', 'src', 'content', 'docs')
const DOCS_INDEX = join(REPO, 'landing', 'src', 'pages', 'docs', 'index.astro')
const LANDING_SOURCE = join(REPO, 'landing', 'src')
const HOMEPAGE_COMPONENTS = [
  'pages/index.astro',
  'components/Hero.astro',
  'components/ReleaseInstallers.astro',
  'components/FeatureGrid.astro',
  'components/ProviderMarks.astro',
  'components/SiteHeader.astro',
  'components/SiteFooter.astro'
] as const

const DOC_SECTIONS = [
  'start',
  'agent',
  'customize',
  'tools',
  'concepts',
  'reference',
  'troubleshooting'
] as const

const SECTION_COUNTS = {
  start: 2,
  agent: 9,
  customize: 8,
  tools: 9,
  concepts: 4,
  reference: 5,
  troubleshooting: 6
} as const

const REQUIRED_WORKFLOWS = [
  'start/install.md',
  'start/quickstart.md',
  'agent/modes.md',
  'agent/prompting-attachments.md',
  'agent/workspaces-sessions.md',
  'agent/background-runs.md',
  'agent/instances.md',
  'agent/goals.md',
  'customize/providers.md',
  'customize/mcp.md',
  'customize/skills.md',
  'customize/rules.md',
  'customize/packages.md',
  'tools/files-editor.md',
  'tools/browser.md',
  'tools/terminal.md',
  'tools/pull-requests.md',
  'tools/voice-dictation.md',
  'tools/notifications.md',
  'concepts/privacy-data.md',
  'reference/attachments.md',
  'reference/storage.md',
  'troubleshooting/runs-network-recovery.md'
] as const

function readDoc(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

function collectMarkdown(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${name.name}` : name.name
    if (name.isDirectory()) {
      out.push(...collectMarkdown(join(dir, name.name), rel))
    } else if (name.name.endsWith('.md')) {
      out.push(rel.replace(/\\/g, '/'))
    }
  }
  return out
}

function frontmatter(text: string): string {
  return text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
}

function scalar(text: string, key: string): string {
  const value = frontmatter(text).match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? ''
  return value.replace(/^['"]|['"]$/g, '')
}

function list(text: string, key: string): string[] {
  const block = frontmatter(text).match(new RegExp(`^${key}:\\s*\\r?\\n((?:  - .+\\r?\\n?)+)`, 'm'))?.[1]
  if (!block) return []
  return block
    .split(/\r?\n/)
    .map((line) => line.match(/^ {2}- (.+)$/)?.[1]?.trim() ?? '')
    .filter(Boolean)
}

function docsId(rel: string): string {
  return rel.replace(/\.md$/, '')
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16)
  ]
}

function relativeLuminance(hex: string): number {
  const channels = hexToRgb(hex).map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}

function contrastRatio(a: string, b: string): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b))
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b))
  return (lighter + 0.05) / (darker + 0.05)
}

function themeTokens(css: string, selector: RegExp): Record<string, string> {
  const block = css.match(selector)?.[1] ?? ''
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [match[1]!, match[2]!])
  )
}

describe('landing docs architecture and truth', () => {
  const files = collectMarkdown(ROOT).sort()
  const ids = new Set(files.map(docsId))

  it('ships docs index, section landings, and article routes with unique section ordering', () => {
    expect(existsSync(DOCS_INDEX)).toBe(true)
    expect(files).toHaveLength(43)
    const sectionRoutes = DOC_SECTIONS.map((section) => `/docs/${section}`)
    const canonicalRoutes = ['/docs', ...sectionRoutes, ...files.map((file) => `/docs/${docsId(file)}`)]
    expect(canonicalRoutes).toHaveLength(51)
    expect(new Set(canonicalRoutes).size).toBe(51)
    expect(canonicalRoutes).toContain('/docs')
    expect(canonicalRoutes).toContain('/docs/start/quickstart')
    for (const [section, count] of Object.entries(SECTION_COUNTS)) {
      const sectionFiles = files.filter((file) => file.startsWith(`${section}/`))
      expect(sectionFiles).toHaveLength(count)
      const orders = sectionFiles.map((file) => Number(scalar(readDoc(file), 'order')))
      expect(new Set(orders).size, `${section} duplicate order`).toBe(orders.length)
      expect([...orders].sort((a, b) => a - b), `${section} contiguous order`).toEqual(
        Array.from({ length: count }, (_, index) => index + 1)
      )
    }
    for (const page of REQUIRED_WORKFLOWS) expect(files).toContain(page)
  })

  it('requires unique production metadata and source ownership on every page', () => {
    const titles = new Set<string>()
    const descriptions = new Set<string>()
    for (const file of files) {
      const text = readDoc(file)
      const title = scalar(text, 'title')
      const description = scalar(text, 'description')
      expect(title, `${file} title`).not.toBe('')
      expect(description, `${file} description`).not.toBe('')
      expect(titles.has(title), `duplicate title ${title}`).toBe(false)
      expect(descriptions.has(description), `duplicate description ${description}`).toBe(false)
      titles.add(title)
      descriptions.add(description)
      expect(Object.keys(SECTION_COUNTS), `${file} section`).toContain(scalar(text, 'section'))
      expect(['quickstart', 'guide', 'concept', 'reference', 'troubleshooting']).toContain(
        scalar(text, 'type')
      )
      expect(scalar(text, 'audience'), `${file} audience`).not.toBe('')
      expect(text, `${file} placeholder`).not.toMatch(/\bTODO\s*:|\bTBD\b|\bComing soon\b/i)
      expect((text.match(/^## /gm) ?? []).length, `${file} content depth`).toBeGreaterThanOrEqual(2)
    }
  })

  it('keeps every declared product source and related page resolvable', () => {
    const missing: string[] = []
    for (const file of files) {
      const text = readDoc(file)
      for (const source of list(text, 'sources')) {
        if (!existsSync(join(REPO, source))) missing.push(`${file}: source ${source}`)
      }
      for (const related of list(text, 'related')) {
        if (!ids.has(related)) missing.push(`${file}: related ${related}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('keeps internal documentation links valid', () => {
    for (const file of files) {
      const text = readDoc(file)
      for (const match of text.matchAll(/\]\(\/docs(?:\/([^#)\s]+))?(?:#[^)\s]+)?\)/g)) {
        if (!match[1]) continue
        expect(ids.has(match[1]), `${file} broken /docs/${match[1]}`).toBe(true)
      }
    }
  })

  it('indexes real titles, summaries, and markdown content with wired controls', () => {
    const library = readFileSync(join(REPO, 'landing', 'src', 'lib', 'docs.ts'), 'utf8')
    const layout = readFileSync(join(REPO, 'landing', 'src', 'layouts', 'DocsLayout.astro'), 'utf8')
    expect(library).toContain('title: entry.data.title')
    expect(library).toContain('description: entry.data.description')
    expect(library).toContain('searchableMarkdown(entry.body ?? \'\')')
    expect(layout).toContain('data-docs-search-open')
    expect(layout).toContain('data-docs-search-input')
    expect(layout).toContain('event.key.toLowerCase()')
    expect(layout).toContain('data-docs-copy')
    expect(layout).toContain('aria-current')
    expect(layout).toContain('rel="prev"')
    expect(layout).toContain('rel="next"')
  })

  it('marks Docs as the current site section without claiming every article is the index', () => {
    const header = readFileSync(join(LANDING_SOURCE, 'components', 'SiteHeader.astro'), 'utf8')
    const footer = readFileSync(join(LANDING_SOURCE, 'components', 'SiteFooter.astro'), 'utf8')
    expect(header).toContain(
      "const onDocsIndex = Astro.url.pathname === '/docs' || Astro.url.pathname === '/docs/'"
    )
    expect(footer).toContain(
      "const onDocsIndex = Astro.url.pathname === '/docs' || Astro.url.pathname === '/docs/'"
    )
    expect(header).toContain("aria-current={onDocsIndex ? 'page' : onDocs ? 'true' : undefined}")
    expect(footer).toContain("ariaCurrent: onDocsIndex ? 'page' : onDocs ? 'true' : undefined")
    expect(header).not.toContain("aria-current={onDocs ? 'page' : undefined}")
    expect(footer).not.toContain("aria-current={onDocs ? 'page' : undefined}")
  })

  it('lists all 60 built-ins including Skill', () => {
    const tools = readDoc('reference/tools.md')
    expect(BUILTIN_TOOL_NAMES).toHaveLength(60)
    for (const name of BUILTIN_TOOL_NAMES) {
      expect(tools, `missing tool ${name}`).toContain(`\`${name}\``)
    }
    expect(tools).toContain('`Skill`')
    expect(tools).not.toMatch(/\b43 tools\b/i)
  })

  it('lists every built-in slash command and the exact marketplace description', () => {
    const slash = readDoc('customize/slash-commands.md')
    expect(BUILTIN_COMMANDS).toHaveLength(15)
    for (const command of BUILTIN_COMMANDS) {
      expect(slash, `missing /${command.trigger}`).toContain(`/${command.trigger}`)
    }
    const marketplace = BUILTIN_COMMANDS.find((command) => command.trigger === 'marketplace')
    expect(marketplace).toBeDefined()
    expect(marketplace!.description).toMatch(/packages/)
    expect(marketplace!.description).not.toMatch(/plugin/i)
    expect(slash).toContain(marketplace!.description)
    expect(slash).not.toMatch(/\bplugins?\b/i)
  })

  it('documents the initial active selection without inventing a Default label', () => {
    const providers = readDoc('customize/providers.md')
    const quickstart = readDoc('start/quickstart.md')
    const features = readFileSync(
      join(LANDING_SOURCE, 'components', 'FeatureGrid.astro'),
      'utf8'
    )
    const secrets = emptySecretStatus()
    expect(PROVIDER_DEFAULTS).toHaveLength(11)
    for (const entry of PROVIDER_DEFAULTS) {
      expect(providers, `missing provider ${entry.id}`).toContain(`\`${entry.id}\``)
    }
    expect(DEFAULT_SETTINGS.provider).toBe('ollama')
    expect(DEFAULT_SETTINGS.model).toBe('qwen2.5')
    expect(
      isProviderConfigured('ollama', secrets, {
        ollamaBaseUrl: DEFAULT_SETTINGS.ollamaBaseUrl
      })
    ).toBe(true)
    expect(
      listConfiguredProviders(secrets, {
        ollamaBaseUrl: DEFAULT_SETTINGS.ollamaBaseUrl,
        customOpenAiBaseUrl: DEFAULT_SETTINGS.customOpenAiBaseUrl,
        alwaysInclude: [DEFAULT_SETTINGS.provider]
      })
    ).toContain('ollama')
    for (const text of [providers, quickstart]) {
      expect(text).toContain('`qwen2.5`')
      expect(text).toContain('Ollama')
    }
    expect(providers).toContain('**Active provider** shows local Ollama')
    expect(features).toContain('Fresh settings start on local Ollama with <code>qwen2.5</code>')
    expect(features).toContain('nine cloud providers')
    expect(features).toContain('custom OpenAI-compatible host')
    expect(features).not.toMatch(/default provider/i)
    expect(providers).not.toMatch(/default provider/i)
    for (const file of files) {
      expect(readDoc(file), `${file} unsupported empty-provider claim`).not.toMatch(
        /no default provider|no provider is selected/i
      )
    }
  })

  it('ships the eight-section homepage in the approved order with exact product labels', () => {
    const hero = readFileSync(join(LANDING_SOURCE, 'components', 'Hero.astro'), 'utf8')
    const features = readFileSync(
      join(LANDING_SOURCE, 'components', 'FeatureGrid.astro'),
      'utf8'
    )
    const page = readFileSync(join(LANDING_SOURCE, 'pages', 'index.astro'), 'utf8')
    expect(page).toContain('<Hero />')
    expect(page).toContain('<FeatureGrid />')

    expect(hero).toContain('id="overview"')
    expect(features).toContain('id="capabilities"')
    const sectionTitles = [
      'Six panels, one task, zero app-switching.',
      'You decide how much the agent may do.',
      'Long work stays resumable.',
      'Bring your own model.',
      'Extend on purpose, not by default.',
      'Local by default. Explicit about the network.',
      'Docs for every step.'
    ]
    let cursor = -1
    for (const title of sectionTitles) {
      const next = features.indexOf(title)
      expect(next, `${title} missing or out of order`).toBeGreaterThan(cursor)
      cursor = next
    }
    for (const label of ['Files', 'Browser', 'Terminal', 'Changes', 'Pull Request', 'Plan']) {
      expect(features, `missing panel ${label}`).toContain(`name: '${label}'`)
    }
    for (const mode of ['Ask', 'Plan', 'Agent']) {
      expect(features, `missing mode ${mode}`).toContain(`name: '${mode}'`)
    }
  })

  it('uses canonical brand assets, clean typography, and a concise hero', () => {
    const hero = readFileSync(join(LANDING_SOURCE, 'components', 'Hero.astro'), 'utf8')
    const providers = readFileSync(
      join(LANDING_SOURCE, 'components', 'ProviderMarks.astro'),
      'utf8'
    )
    const brand = readFileSync(join(LANDING_SOURCE, 'components', 'BrandLockup.astro'), 'utf8')
    const css = readFileSync(join(LANDING_SOURCE, 'styles', 'global.css'), 'utf8')
    const sync = readFileSync(join(REPO, 'scripts', 'sync-landing-brand.mjs'), 'utf8')
    const appProviderLogo = readFileSync(
      join(
        REPO,
        'src',
        'renderer',
        'src',
        'features',
        'chat',
        'components',
        'composer',
        'ProviderLogo.tsx'
      ),
      'utf8'
    )

    expect(hero.match(/<h1\b/g)).toHaveLength(1)
    expect(hero.match(/<p\b/g)).toHaveLength(1)
    expect(hero.match(/<a\b/g) ?? []).toHaveLength(0)
    expect(hero).toContain('<ReleaseInstallers />')
    expect(hero).toContain('<ul class="hero-meta"')
    expect(hero).toContain('{SITE_PRODUCT}')
    expect(hero).not.toContain('{SITE_BRAND} {SITE_PRODUCT}')
    expect(hero).not.toMatch(/<strong>|Desktop|Electron/)
    expect(css).toContain('--font-sans: "Schibsted Grotesk Variable", "Schibsted Grotesk", system-ui, sans-serif')
    expect(css).toContain('--font-mono: "IBM Plex Mono", ui-monospace, "Cascadia Mono", monospace')
    expect(css).not.toMatch(/Plus Jakarta|Unbounded|@font-face/)
    expect(sync).toContain("resources', 'branding', 'precision-mono")
    expect(sync).toContain("node_modules', '@lobehub', 'icons', 'es")
    expect(sync).not.toMatch(/destFonts|Unbounded-variable/)
    expect(brand).toContain('/brand/mark-black.svg')
    expect(brand).toContain('/brand/wordmark-black.svg')
    expect(brand).toContain('width="73"')
    expect(brand).toContain('height="13"')
    expect(brand).toContain('gap-2.5')
    expect(sync).toContain("'vyotiq-social-card.png', 'og.png'")
    for (const provider of [
      'openai',
      'anthropic',
      'gemini',
      'ollama',
      'deepseek',
      'groq',
      'openrouter',
      'xai',
      'mistral',
      'opencode'
    ]) {
      expect(providers).toContain('PROVIDERS.map')
      expect(existsSync(join(LANDING_SOURCE, 'assets', 'providers', `${provider}.svg`))).toBe(true)
    }
    expect(providers).toContain('Custom host')
    expect(appProviderLogo).toContain('PlugsConnectedIcon')
  })

  it('names Agent V as the product beside the Vyotiq company mark', () => {
    const site = readFileSync(join(LANDING_SOURCE, 'lib', 'site.ts'), 'utf8')
    const layout = readFileSync(join(LANDING_SOURCE, 'layouts', 'BaseLayout.astro'), 'utf8')
    const docsLayout = readFileSync(join(LANDING_SOURCE, 'layouts', 'DocsLayout.astro'), 'utf8')
    const llms = readFileSync(join(LANDING_SOURCE, 'pages', 'llms.txt.ts'), 'utf8')
    const header = readFileSync(join(LANDING_SOURCE, 'components', 'SiteHeader.astro'), 'utf8')
    const footer = readFileSync(join(LANDING_SOURCE, 'components', 'SiteFooter.astro'), 'utf8')
    const hero = readFileSync(join(LANDING_SOURCE, 'components', 'Hero.astro'), 'utf8')
    const emptyChat = readFileSync(
      join(
        REPO,
        'src',
        'renderer',
        'src',
        'features',
        'chat',
        'components',
        'ChatTranscriptStage.tsx'
      ),
      'utf8'
    )
    const about = readFileSync(
      join(REPO, 'src', 'renderer', 'src', 'features', 'settings', 'sections', 'AboutSection.tsx'),
      'utf8'
    )
    const builder = readFileSync(join(REPO, 'electron-builder.yml'), 'utf8')
    const appInfo = readFileSync(join(REPO, 'src', 'main', 'ipc', 'register.ts'), 'utf8')
    const pkg = readFileSync(join(REPO, 'package.json'), 'utf8')
    const readme = readFileSync(join(REPO, 'README.md'), 'utf8')
    const landingReadme = readFileSync(join(REPO, 'landing', 'README.md'), 'utf8')
    const install = readDoc('start/install.md')
    const what = readDoc('concepts/what-it-is.md')
    const marketplace = readDoc('customize/marketplace.md')

    expect(site).toContain("export const SITE_BRAND = 'Vyotiq'")
    expect(site).toContain("export const SITE_PRODUCT = 'Agent V'")
    expect(site).toContain("'Agent V brings")
    expect(layout).toContain('`${SITE_PRODUCT} — ${SITE_TAGLINE}`')
    expect(layout).toContain('const siteName = SITE_PRODUCT')
    expect(layout).toContain('includeProductSchema')
    expect(layout).toContain("Astro.url.pathname === '/'")
    expect(docsLayout).toContain('`${title} — ${SITE_PRODUCT}`')
    expect(docsLayout).not.toContain('lastVerified')
    expect(docsLayout).not.toMatch(/Vyotiq \{lastVerified\}/)
    expect(llms).toContain('const product = SITE_PRODUCT')
    expect(llms).toContain('# ${product} documentation')

    expect(header).toContain('<BrandLockup />')
    expect(header).toContain('aria-label={`${SITE_PRODUCT} home`}')
    expect(footer).toContain('© {year} {SITE_BRAND}')
    expect(footer).toContain('{SITE_PRODUCT} is a coding workspace for real repositories')
    expect(hero).toContain('<ul class="hero-meta"')

    expect(emptyChat).not.toContain('VyotiqLockup')
    expect(emptyChat).not.toContain('data-empty-brand')
    expect(about).toContain('<VyotiqLockup markSize={36} />')
    expect(about).toContain('Agent V. A product of Vyotiq.com.')

    expect(builder).toMatch(/^productName: Vyotiq$/m)
    expect(appInfo).toContain("name: 'Vyotiq'")
    expect(pkg).toContain('"description": "Agent V — coding workspace for real repositories"')

    expect(readme).toMatch(/^# Agent V/m)
    expect(readme).toContain('**60** tools')
    expect(readme).not.toMatch(/\b43 tools\b/i)
    expect(readme).not.toMatch(/docs\/architecture\.md/)
    expect(readme).toContain('**MCPs**')
    expect(readme).toContain('**Skills**')
    expect(readme).toContain('**Rules**')
    expect(readme).toContain('**Packages**')
    expect(landingReadme).toMatch(/^# Agent V site/m)
    expect(scalar(what, 'title')).toBe('What Agent V is')
    expect(what).toMatch(/^Agent V is a coding workspace/m)
    for (const label of ['**MCPs**', '**Skills**', '**Rules**', '**Packages**']) {
      expect(marketplace).toContain(label)
    }
    expect(install).toContain('https://github.com/vyotiqai/vyotiq-agent-v-releases/releases/latest')
    expect(install).toContain('download buttons for each installer')
    expect(install).toContain('`pnpm pack:win`')
    expect(install).toContain('`pnpm pack:mac`')
    expect(install).toContain('`pnpm pack:linux`')
    expect(install).not.toMatch(/the Vyotiq download page/i)
    expect(install).not.toMatch(/\b43 tools\b/i)
    const docsIndex = readFileSync(DOCS_INDEX, 'utf8')
    expect(docsIndex).toContain('docsHref(entry.id)')
    expect(docsIndex).not.toContain('docs-start-grid')
    expect(docsIndex).not.toMatch(/Install Vyotiq/)
    const features = readFileSync(join(LANDING_SOURCE, 'components', 'FeatureGrid.astro'), 'utf8')
    expect(features).toContain('keep the state needed to return')
    expect(features).not.toMatch(/\bVyotiq keeps\b/)
    for (const text of [
      landingReadme,
      site,
      hero,
      layout,
      llms,
      what,
      install,
      docsIndex,
      pkg,
      about,
      emptyChat
    ]) {
      expect(text).not.toMatch(/\bopen[- ]source\b/i)
      expect(text).not.toMatch(/\$\s*0\b/)
      expect(text).not.toMatch(/\bdefault provider\b/i)
      expect(text).not.toMatch(/Vyotiq Agent V/)
    }
    // The repo is open source (GPL-3.0): the README states it, the marketing
    // surfaces above still don't lead with it.
    expect(readme).toMatch(/\bopen[- ]source\b/i)
    expect(readme).toContain('GPL-3.0')
    expect(layout).not.toContain('`${SITE_BRAND} ${SITE_PRODUCT}')
    expect(docsLayout).not.toContain('`${title} — ${SITE_BRAND} ${SITE_PRODUCT}`')
    expect(llms).not.toContain('`${SITE_BRAND} ${SITE_PRODUCT}`')
    expect(header).not.toContain('`${SITE_BRAND} ${SITE_PRODUCT} home`')
    expect(hero).not.toContain('{SITE_BRAND} {SITE_PRODUCT}')
  })

  it('does not use company-only Vyotiq as the inner-docs product actor', () => {
    const packagedNamePages = new Set(['start/install.md', 'reference/storage.md'])

    function leftoverCompanyMark(body: string): string[] {
      const stripped = body
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]*`/g, ' ')
        .replace(/\.vyotiq\b/gi, ' ')
      return [...stripped.matchAll(/\bVyotiq\b/g)].map((match) => match[0])
    }

    for (const file of files) {
      const source = readDoc(file)
      expect(source, file).not.toMatch(/Vyotiq Agent V/)
      const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
      const leftover = leftoverCompanyMark(body)
      if (packagedNamePages.has(file)) {
        expect(body, file).toMatch(/Agent V/)
        expect(leftover.length, file).toBeGreaterThan(0)
        continue
      }
      expect(leftover, file).toEqual([])
    }
  })

  it('does not use the runtime as user-facing product identity', () => {
    const productCopy = [
      readFileSync(join(REPO, 'README.md'), 'utf8').split('## Develop it')[0]!,
      readFileSync(join(REPO, 'package.json'), 'utf8'),
      readFileSync(join(LANDING_SOURCE, 'lib', 'site.ts'), 'utf8'),
      readFileSync(join(LANDING_SOURCE, 'components', 'Hero.astro'), 'utf8'),
      readFileSync(join(LANDING_SOURCE, 'pages', 'llms.txt.ts'), 'utf8'),
      readDoc('concepts/what-it-is.md')
    ].join('\n')
    expect(productCopy).not.toMatch(
      /\b(?:lean\s+)?Electron\s+desktop|\bdesktop\s+(?:coding\s+)?(?:agent|app|application|workspace)\b/i
    )

    const technicalDocs = files
      .map((file) => readDoc(file))
      .filter((text) => /\bElectron\b/.test(text))
    expect(technicalDocs.length).toBeGreaterThan(0)
    for (const text of technicalDocs) {
      expect(text).not.toMatch(/\bElectron\s+desktop|\bdesktop\s+Electron\b/i)
    }
  })

  it('keeps homepage claims qualified and removes obsolete release surfaces', () => {
    const source = HOMEPAGE_COMPONENTS.map((rel) =>
      readFileSync(join(LANDING_SOURCE, rel), 'utf8')
    ).join('\n')
    for (const [label, pattern] of [
      // "Open source" only passes when qualified with the actual license
      // (the footer's "Open source (GPL-3.0)" chrome) — a bare claim stays banned.
      ['open source', /\bopen[- ]source\b(?!\s*\((?:GPL|Apache|MIT))/i],
      ['free pricing', /(?:\$\s*0|\bfree\b)/i],
      ['no telemetry', /\bno telemetry\b/i],
      ['no cloud', /\bno cloud\b/i],
      ['everything local', /\beverything stays local\b/i],
      ['default provider', /\bdefault provider\b/i],
      ['universal undo', /\b(?:undo|reverse) (?:everything|all)\b/i],
      ['universal compatibility', /\b(?:all|every|universal(?:ly)?) OpenAI-compatible\b/i],
      ['fake launch state', /\b(?:available now|launch(?:ed)?|coming soon|waitlist)\b/i],
      ['fake social proof', /\b(?:trusted by|developers love|customers)\b/i]
    ] as const) {
      expect(source, `unsupported homepage claim: ${label}`).not.toMatch(pattern)
    }

    expect(source).toContain('subject to approvals')
    expect(source).toContain('They are not Git commits')
    expect(source).toContain('cannot reverse')
    expect(source).toContain('estimate')
    expect(source).toContain('rotating logs')
    expect(source).toContain('opt-in')
    expect(source).toContain('operating-system secure storage')
    expect(source).toContain('optional domain allowlist')
    expect(source).toContain('.vyotiq/memory/')
    expect(source).toContain('separate from memory')
    // The releases repo is public: per-platform asset links are served to
    // visitors, so the download area ships direct installer buttons plus a
    // releases-page link. Asset URLs are still baked, not hand-edited.
    expect(source).toContain('GitHub Releases')
    expect(source).toContain('data-release-platform')
    expect(source).toContain('Download for Windows')
    expect(source).toContain('Download for macOS')
    expect(source).toContain('Download for Linux')
    expect(source).not.toMatch(/api\.github\.com/)

    for (const rel of [
      'components/DownloadSection.astro',
      'components/ProductFrame.astro',
      'lib/downloads.ts',
      'lib/release-assets.ts',
      'lib/platform.ts'
    ]) {
      expect(existsSync(join(LANDING_SOURCE, rel)), `${rel} should be removed`).toBe(false)
    }
    expect(existsSync(join(LANDING_SOURCE, 'components', 'ReleaseInstallers.astro'))).toBe(true)
    expect(existsSync(join(LANDING_SOURCE, 'lib', 'githubRelease.ts'))).toBe(true)
    expect(existsSync(join(REPO, 'landing', 'scripts', 'bake-github-release.mjs'))).toBe(true)
    expect(existsSync(join(LANDING_SOURCE, 'lib', 'github-release.json'))).toBe(true)
    const snapshot = JSON.parse(
      readFileSync(join(LANDING_SOURCE, 'lib', 'github-release.json'), 'utf8')
    ) as { assets?: Record<string, { url?: string }> }
    // The releases repo is public: baked asset URLs back the per-platform
    // buttons and must be GitHub download links on https.
    expect(snapshot.assets?.win?.url).toMatch(
      /^https:\/\/github\.com\/vyotiqai\/vyotiq-agent-v-releases\/releases\/download\//
    )
    expect(snapshot.assets?.linux?.url).toMatch(
      /^https:\/\/github\.com\/vyotiqai\/vyotiq-agent-v-releases\/releases\/download\//
    )
    expect(snapshot.assets?.macArm64?.url).toMatch(
      /^https:\/\/github\.com\/vyotiqai\/vyotiq-agent-v-releases\/releases\/download\//
    )
    expect(snapshot.assets?.macX64?.url).toMatch(
      /^https:\/\/github\.com\/vyotiqai\/vyotiq-agent-v-releases\/releases\/download\//
    )
    expect(readFileSync(join(REPO, '.gitignore'), 'utf8')).not.toContain(
      'landing/src/lib/github-release.json'
    )
    const bake = readFileSync(join(REPO, 'landing', 'scripts', 'bake-github-release.mjs'), 'utf8')
    expect(bake).toContain('preferExistingSnapshot')
    expect(bake).toContain('keeping previously baked')
    expect(readFileSync(join(REPO, 'electron-builder.yml'), 'utf8')).toContain('releaseType: release')
    expect(existsSync(join(REPO, 'scripts', 'capture-landing-product.mjs'))).toBe(false)
    expect(readFileSync(join(REPO, 'package.json'), 'utf8')).not.toContain('capture:landing')
    expect(readFileSync(join(REPO, 'package.json'), 'utf8')).not.toContain('PUBLIC_GITHUB_')
  })

  it('meets text and boundary contrast thresholds in both themes', () => {
    const css = readFileSync(join(LANDING_SOURCE, 'styles', 'global.css'), 'utf8')
    const light = themeTokens(css, /:root,\s*\[data-theme="light"\]\s*\{([^}]+)\}/)
    const dark = themeTokens(css, /\[data-theme="dark"\]\s*\{([^}]+)\}/)
    for (const [name, tokens] of Object.entries({ light, dark })) {
      expect(contrastRatio(tokens.muted!, tokens.bg!), `${name} muted on background`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(tokens.muted!, tokens.surface!), `${name} muted on surface`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(tokens.border!, tokens.bg!), `${name} border on background`).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(tokens.border!, tokens.surface!), `${name} border on surface`).toBeGreaterThanOrEqual(3)
    }
  })

  it('lists every Settings section title', () => {
    const settings = readDoc('reference/settings.md')
    const titles = Object.values(SECTION_LABELS).map((section) => section.title)
    expect(titles).toHaveLength(10)
    for (const title of titles) expect(settings, `missing ${title}`).toContain(`## ${title}`)
  })

  it('renders structured markdown instead of Word-flattened text blocks', () => {
    for (const file of files) {
      const body = readDoc(file)
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
        .replace(/```[\s\S]*?```/g, '')
      expect(body, file).not.toMatch(/^\s*---\s*$/m)
      expect(body.match(/^`[^`\n]*\s[^`\n]*`$/gm) ?? [], file).toEqual([])
    }
    const landingReadme = readFileSync(join(REPO, 'landing', 'README.md'), 'utf8')
    expect(landingReadme.replace(/^# .*\n/, '')).not.toMatch(/^\s*---\s*$/m)
    expect(readDoc('agent/modes.md')).toContain('| Need | Mode | Boundary |')
    expect(readDoc('reference/settings.md')).toMatch(/^\| Control \| Options and notes \|/m)
  })

  it('uses shorter sidebar labels and quickstart step chrome', () => {
    const library = readFileSync(join(REPO, 'landing', 'src', 'lib', 'docs.ts'), 'utf8')
    const layout = readFileSync(join(REPO, 'landing', 'src', 'layouts', 'DocsLayout.astro'), 'utf8')
    const css = readFileSync(join(REPO, 'landing', 'src', 'styles', 'global.css'), 'utf8')
    const header = readFileSync(join(LANDING_SOURCE, 'components', 'SiteHeader.astro'), 'utf8')
    const quickstart = readDoc('start/quickstart.md')

    expect(library).toContain('export function docsNavTitle')
    expect(library).toContain("'start/quickstart': 'Quickstart'")
    expect(library).toContain('export function docsSectionHref')
    expect(library).toContain('export function docsEditHref')
    expect(layout).toContain('docsNavTitle(entry.id, entry.data.title)')
    expect(layout).toContain("quickstartPage && 'docs-quickstart'")
    expect(layout).toContain('docsEditHref(currentId)')
    expect(layout).toContain('docs-heading-anchor')
    expect(layout).toContain('terms.length > 0 && match.score >= 0')
    expect(layout).toContain("status.textContent = 'Type to search documentation.'")
    expect(header).toContain('data-theme-icon="system"')
    expect(header).toContain('data-theme-menu')
    expect(css).toContain('.doc-prose.docs-quickstart > h2:not(:first-of-type)::before')
    expect(css).toContain('.docs-heading-anchor')
    expect(css).toContain('.docs-edit-links')
    expect(quickstart).toContain('## Open a workspace')
    expect(quickstart).not.toMatch(/^## 1\./m)
    expect(existsSync(join(REPO, 'landing', 'src', 'pages', 'docs', '[section]', 'index.astro'))).toBe(
      true
    )
    const sectionIndex = readFileSync(
      join(REPO, 'landing', 'src', 'pages', 'docs', '[section]', 'index.astro'),
      'utf8'
    )
    expect(sectionIndex).toContain('currentSection={section}')
    expect(sectionIndex).not.toMatch(/\bdocsNavTitle\b/)
    expect(library).toContain("return `/docs/${section}`")
    expect(library).toContain('${id}.md')
    expect(library).toContain('Docs feedback:')
    expect(layout).toContain('docs-nav-scroll')
    expect(layout).toContain("new Set(['Esc', 'Enter', 'Tab'])")
    expect(css).toContain('.docs-nav-scroll')
    const background = readDoc('agent/background-runs.md')
    expect(background).toContain('/docs/reference/settings#tools')
    expect(background).toContain('Connection lost')
    expect(background).toContain('Temporarily paused')
    expect(background).not.toContain('network_interrupted')
    expect(background).not.toContain('circuit_open')
    expect(background).toContain('**Stop**')
    expect(background).toContain('`Continue`')
  })

  it('preserves dictation engines and attachment limits from product constants', () => {
    const voice = readDoc('tools/voice-dictation.md')
    const attachments = readDoc('reference/attachments.md')
    for (const engine of DICTATION_ENGINE_OPTIONS) expect(voice).toContain(engine.label)
    expect(attachments).toContain(`| Extracted file | ${MAX_FILES} |`)
    expect(attachments).toContain(`| Image | ${MAX_IMAGES} |`)
    expect(attachments).toContain(`| Audio | ${MAX_AUDIO_FILES} |`)
    expect(attachments).toContain(`${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`)
    expect(attachments).toContain(`${MAX_IMAGE_BYTES / (1024 * 1024)} MB`)
    expect(attachments).toContain(`${MAX_AUDIO_BYTES / (1024 * 1024)} MB`)
    expect(attachments).toContain(MAX_ATTACHMENT_CHARS.toLocaleString('en-US'))
  })

  it('keeps approval dialog labels distinct from Settings labels', () => {
    const quickstart = readDoc('start/quickstart.md')
    for (const label of [
      '**Mutating tools**',
      '**All tools**',
      '**Not now**',
      '**Ask for edits and commands**',
      '**Ask for every tool**'
    ]) {
      expect(quickstart).toContain(label)
    }
  })

  it('keeps compound OpenAI tokens intact and marks first-run controls', () => {
    const quickstart = readDoc('start/quickstart.md')
    const settings = readDoc('reference/settings.md')
    const install = readDoc('start/install.md')
    expect(quickstart).not.toContain('**OpenAI**-compatible')
    expect(quickstart).toContain('OpenAI-compatible')
    expect(quickstart).toContain('```')
    expect(quickstart).toContain(
      '[Run, network, and recovery issues](/docs/troubleshooting/runs-network-recovery)'
    )
    expect(quickstart).toContain('`http://127.0.0.1:11434`')
    expect(quickstart).toContain('`Add workspace`')
    expect(quickstart).toContain('[mode picker](/docs/agent/modes)')
    expect(quickstart).toContain('Open [Changes](/docs/tools/changes-git)')
    expect(settings).not.toContain('**Local** rotating logs')
    expect(settings).toContain('Local rotating logs')
    expect(install).not.toContain('**Local** Ollama')
  })

  it('uses exact Marketplace Manage labels and Packages terminology', () => {
    const marketplace = readDoc('customize/marketplace.md')
    const what = readDoc('concepts/what-it-is.md')
    const packages = readDoc('customize/packages.md')
    for (const label of ['**MCPs**', '**Skills**', '**Rules**', '**Packages**']) {
      expect(marketplace).toContain(label)
    }
    const features = readFileSync(
      join(REPO, 'landing', 'src', 'components', 'FeatureGrid.astro'),
      'utf8'
    )
    const view = readFileSync(
      join(REPO, 'src', 'renderer', 'src', 'features', 'marketplace', 'MarketplaceView.tsx'),
      'utf8'
    )
    const home = readFileSync(
      join(REPO, 'src', 'renderer', 'src', 'features', 'marketplace', 'MarketplaceHome.tsx'),
      'utf8'
    )
    const labels = readFileSync(
      join(REPO, 'src', 'renderer', 'src', 'features', 'marketplace', 'marketplaceLabels.ts'),
      'utf8'
    )
    const installed = readFileSync(
      join(
        REPO,
        'src',
        'renderer',
        'src',
        'features',
        'marketplace',
        'MarketplaceInstalledList.tsx'
      ),
      'utf8'
    )
    expect(features).toMatch(/packages/i)
    expect(features).not.toMatch(/plugin/i)
    expect(view).toContain('MCP servers, skills, and packages for the agent.')
    expect(home).toContain('Search packages, skills, MCPs…')
    expect(home).toContain('<option value="plugin">Packages</option>')
    expect(home).not.toMatch(/>Plugins</)
    expect(labels).toContain("return 'Package'")
    expect(labels).not.toMatch(/return 'Plugin'/)
    expect(installed).toContain('MCP servers, skills, or packages.')
    expect(installed).toContain('Package MCP servers')
    expect(installed).not.toMatch(/or plugins/)
    for (const text of [marketplace, what, packages]) {
      expect(text).not.toMatch(/\bplugins?\b/i)
    }
  })

  it('documents bundled GitHub vs Gmail connect, native overlap, Agent mode, and MCP tools protection', () => {
    const mcp = readDoc('customize/mcp.md')
    const marketplace = readDoc('customize/marketplace.md')
    const troubleshooting = readDoc('troubleshooting/marketplace-mcp.md')
    const redirect = '`http://127.0.0.1:19847/oauth/callback`'
    for (const [file, text] of [
      ['customize/mcp.md', mcp],
      ['customize/marketplace.md', marketplace],
      ['troubleshooting/marketplace-mcp.md', troubleshooting]
    ] as const) {
      expect(text, `${file} Add GitHub`).toContain('Add GitHub')
      expect(text, `${file} Add Gmail`).toContain('Add Gmail')
      expect(text, `${file} Agent mode`).toMatch(/Agent mode/)
      expect(text, `${file} MCP tools protection`).toContain('MCP tools protection')
    }
    // The Google OAuth redirect URI lives canonically on the MCP page; the
    // marketplace overview and troubleshooting pages point at that setup.
    expect(mcp, 'customize/mcp.md redirect').toContain(redirect)
    expect(troubleshooting, 'troubleshooting/marketplace-mcp.md redirect').toContain(redirect)
    expect(marketplace, 'customize/marketplace.md canonical setup link').toContain(
      '/docs/customize/mcp'
    )
    expect(mcp).toContain('Native GitHub')
    expect(mcp).toContain('GitHub MCP')
    expect(mcp).toContain('gmailmcp')
    expect(mcp).toMatch(/defaults on/)
    expect(marketplace).toContain('Discover')
    expect(troubleshooting).toContain('already in use')
  })

  it('ships production static files and open-source footer chrome with terms', () => {
    const robots = readFileSync(join(REPO, 'landing', 'public', 'robots.txt'), 'utf8')
    expect(robots).toContain('Allow: /')
    expect(robots).toContain('Sitemap: https://vyotiq.com/sitemap-index.xml')

    const security = readFileSync(
      join(REPO, 'landing', 'public', '.well-known', 'security.txt'),
      'utf8'
    )
    const policy = readFileSync(join(REPO, 'SECURITY.md'), 'utf8')
    expect(policy).toContain('security@vyotiq.com')
    expect(policy).toContain('github.com/vyotiqai/vyotiq-agent-v/security/advisories/new')
    expect(security).toContain(
      'Contact: https://github.com/vyotiqai/vyotiq-agent-v/security/advisories/new'
    )
    expect(security).toContain('Contact: mailto:security@vyotiq.com')
    expect(security).toContain('Canonical: https://vyotiq.com/.well-known/security.txt')
    expect(security).toContain(
      'Policy: https://github.com/vyotiqai/vyotiq-agent-v/blob/main/SECURITY.md'
    )
    const expires = Date.parse(security.match(/^Expires:\s*(\S+)/m)?.[1] ?? '')
    expect(expires).toBeGreaterThan(Date.now())
    expect(expires).toBeLessThanOrEqual(Date.now() + 366 * 24 * 60 * 60 * 1000)

    const headers = readFileSync(join(REPO, 'landing', 'public', '_headers'), 'utf8')
    expect(headers).toContain('X-Content-Type-Options: nosniff')
    expect(headers).toContain('Referrer-Policy: strict-origin-when-cross-origin')
    expect(headers).toContain('X-Frame-Options: DENY')
    expect(headers).toContain('Permissions-Policy: camera=(), microphone=(), geolocation=()')
    expect(headers).not.toMatch(/Content-Security-Policy/i)

    const footer = readFileSync(join(LANDING_SOURCE, 'components', 'SiteFooter.astro'), 'utf8')
    expect(footer).toContain("href: '/docs/concepts/privacy-data'")
    expect(footer).toContain('href="/privacy"')
    expect(footer).toContain('href="/terms"')
    expect(footer).toContain("href: '/changelog'")
    // The repo is open source: the footer links to it.
    expect(footer).toContain("href: 'https://github.com/vyotiqai/vyotiq-agent-v'")
    expect(footer).toContain('GPL-3.0')
    expect(existsSync(join(LANDING_SOURCE, 'pages', 'privacy.astro'))).toBe(true)
    expect(existsSync(join(LANDING_SOURCE, 'pages', 'terms.astro'))).toBe(true)
    expect(existsSync(join(LANDING_SOURCE, 'pages', 'changelog.astro'))).toBe(true)
    expect(existsSync(join(LANDING_SOURCE, 'components', 'CookieBanner.astro'))).toBe(false)

    const layout = readFileSync(join(LANDING_SOURCE, 'layouts', 'BaseLayout.astro'), 'utf8')
    expect(layout).toContain('landingAnalytics')
    expect(layout).not.toMatch(/plausible\.io|googletagmanager|gtag\(/)
    expect(layout).toContain('name="referrer"')
    expect(layout).toContain('strict-origin-when-cross-origin')
    expect(layout).toContain('og:locale')
    expect(layout).toContain('twitter:image:alt')
    expect(layout).toContain('/brand/mark-black.svg')
    expect(layout).toContain('rel="apple-touch-icon" href="/brand/favicon.png"')
    expect(layout).not.toContain('rel="icon" href="/brand/favicon.png"')

    const envExample = readFileSync(join(REPO, 'landing', '.env.example'), 'utf8')
    expect(envExample).toContain('PUBLIC_SITE_URL=https://vyotiq.com')
    expect(envExample).toContain('PUBLIC_ANALYTICS_SRC')
    expect(envExample).toContain('PUBLIC_ANALYTICS_DOMAIN')
    expect(envExample).not.toMatch(/^PUBLIC_ANALYTICS_SRC=/m)

    const landingReadme = readFileSync(join(REPO, 'landing', 'README.md'), 'utf8')
    expect(landingReadme).toContain('bake:landing-release')
    expect(landingReadme).toContain('PUBLIC_ANALYTICS_SRC')
    expect(landingReadme).not.toContain('PUBLIC_GITHUB_')

    const notFound = readFileSync(join(LANDING_SOURCE, 'pages', '404.astro'), 'utf8')
    expect(notFound).toContain('robots="noindex, nofollow"')
  })

  it('wires landing check and Ubuntu-only browser audit', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const landingPkg = JSON.parse(
      readFileSync(join(REPO, 'landing', 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }
    const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(landingPkg.scripts.check).toBe('astro check')
    expect(pkg.scripts['bake:landing-release']).toBe('node landing/scripts/bake-github-release.mjs')
    expect(pkg.scripts['landing:build']).toContain('bake:landing-release')
    expect(pkg.scripts['landing:dev']).toContain('bake:landing-release')
    expect(pkg.scripts['landing:check']).toBe('pnpm --filter @vyotiq/landing check')
    expect(pkg.scripts['landing:audit']).toBe('node tests/landing/runDocsAudit.mjs')
    expect(existsSync(join(REPO, 'tests', 'landing', 'runDocsAudit.mjs'))).toBe(true)
    expect(ci).toContain('pnpm landing:check')
    expect(ci).toContain('pnpm landing:audit')
    expect(ci).toMatch(/Check landing site\r?\n\s+if: runner\.os == 'Linux'/)
    expect(ci).toMatch(/Audit landing site\r?\n\s+if: runner\.os == 'Linux'/)
  })
})
