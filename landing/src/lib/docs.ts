import { getCollection, type CollectionEntry } from 'astro:content'
import { DOC_SECTIONS, type DocSection } from './sections'

export { DOC_SECTIONS, type DocSection }

export const DOC_SECTION_LABEL: Record<DocSection, string> = {
  start: 'Start here',
  agent: 'Working with the agent',
  customize: 'Customize',
  tools: 'Tools and panels',
  concepts: 'Concepts and security',
  reference: 'Reference',
  troubleshooting: 'Troubleshooting'
}

export const DOC_SECTION_INTRO: Record<DocSection, string> = {
  start: 'Install Agent V, connect a model, and finish a first useful run.',
  agent: 'Modes, sessions, plans, todos, goals, and checkpoints: how a run is kept on track.',
  customize: 'Providers, models, MCP servers, skills, rules, and packages.',
  tools: 'The files editor, terminal, browser, Git surfaces, indexing, memory, and voice.',
  concepts: 'What Agent V is, how runs and state work, and where privacy and security apply.',
  reference: 'Settings, shortcuts, tools, attachments, and storage paths at a glance.',
  troubleshooting:
    'Recover from failed runs, provider issues, Marketplace and MCP problems, and Git or indexing errors.'
}

export const DOCS_REPO = 'https://github.com/vyotiqai/vyotiq-agent-v'

export function docsHref(id: string): string {
  return `/docs/${id}`
}

export function docsSectionHref(section: DocSection): string {
  return `/docs/${section}`
}

export function docsEditHref(id: string): string {
  return `${DOCS_REPO}/edit/main/landing/src/content/docs/${id}.md`
}

export function docsFeedbackHref(title: string): string {
  const params = new URLSearchParams({
    labels: 'documentation',
    title: `Docs feedback: ${title}`
  })
  return `${DOCS_REPO}/issues/new?${params}`
}

/** Shorter sidebar labels — full titles stay on the page, index, and search. */
export function docsNavTitle(id: string, title: string): string {
  const labels: Record<string, string> = {
    'start/install': 'Install',
    'start/quickstart': 'Quickstart',
    'agent/background-runs': 'Background runs',
    'agent/checkpoints': 'Checkpoints',
    'agent/context-compaction': 'Compaction',
    'agent/instances': 'Instances',
    'agent/modes': 'Modes',
    'agent/plans-todos-questions': 'Plans & todos',
    'agent/prompting-attachments': 'Prompts & files',
    'agent/workspaces-sessions': 'Workspaces',
    'agent/goals': 'Goals',
    'customize/marketplace': 'Marketplace',
    'customize/mcp': 'MCP',
    'customize/models': 'Models',
    'customize/packages': 'Packages',
    'customize/providers': 'Providers',
    'customize/rules': 'Rules',
    'customize/skills': 'Skills',
    'customize/slash-commands': 'Slash commands',
    'tools/browser': 'Browser',
    'tools/changes-git': 'Changes & Git',
    'tools/files-editor': 'Files editor',
    'tools/indexing': 'Indexing',
    'tools/memory': 'Memory',
    'tools/notifications': 'Notifications',
    'tools/pull-requests': 'Pull requests',
    'tools/terminal': 'Terminal',
    'tools/voice-dictation': 'Voice',
    'concepts/privacy-data': 'Privacy',
    'concepts/runs-sessions-state': 'Runs & state',
    'concepts/security': 'Security',
    'concepts/what-it-is': 'What it is',
    'reference/attachments': 'Attachments',
    'reference/settings': 'Settings',
    'reference/shortcuts': 'Shortcuts',
    'reference/storage': 'Storage',
    'reference/tools': 'Tools',
    'troubleshooting/browser-terminal': 'Browser & terminal',
    'troubleshooting/git-pull-requests': 'Git & PRs',
    'troubleshooting/indexing-dictation': 'Indexing & voice',
    'troubleshooting/marketplace-mcp': 'Marketplace & MCP',
    'troubleshooting/providers-models': 'Providers & models',
    'troubleshooting/runs-network-recovery': 'Runs & recovery'
  }
  return labels[id] ?? title
}

/** Strip quickstart step prefixes from TOC labels. */
export function docsTocLabel(text: string): string {
  return text.replace(/^\d+\.\s+/, '')
}

export type DocsNavGroup = {
  section: DocSection
  label: string
  entries: CollectionEntry<'docs'>[]
}

export async function orderedDocs(): Promise<CollectionEntry<'docs'>[]> {
  const entries = await getCollection('docs')
  return [...entries].sort((a, b) => {
    if (a.data.section !== b.data.section) {
      return DOC_SECTIONS.indexOf(a.data.section) - DOC_SECTIONS.indexOf(b.data.section)
    }
    if (a.data.order !== b.data.order) return a.data.order - b.data.order
    return a.data.title.localeCompare(b.data.title)
  })
}

export async function groupedDocs(): Promise<DocsNavGroup[]> {
  const sorted = await orderedDocs()
  return DOC_SECTIONS.map((section) => ({
    section,
    label: DOC_SECTION_LABEL[section],
    entries: sorted.filter((entry) => entry.data.section === section)
  })).filter((group) => group.entries.length > 0)
}

/** Cap per-paragraph search snippets so the payload stays small. */
const PROSE_SNIPPET_MAX = 200

function searchableMarkdown(body: string): string {
  return body
    .replace(/^---[\s\S]*?---/, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .map((line) => {
      const heading = /^#{1,6}\s+\S/.exec(line)
      // Headings stay complete — they carry the strongest search signal.
      if (heading) {
        return line
          .replace(/^#{1,6}\s+/, '')
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
          .replace(/[`*_>|~-]/g, ' ')
      }
      // Body prose is indexed as a short snippet per paragraph.
      const text = line
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
        .replace(/[`*_>|~-]/g, ' ')
        .trim()
      if (!text) return ''
      return text.length > PROSE_SNIPPET_MAX
        ? `${text.slice(0, PROSE_SNIPPET_MAX).trimEnd()}…`
        : text
    })
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export type DocsSearchEntry = {
  id: string
  title: string
  description: string
  section: string
  href: string
  text: string
}

export async function docsSearchEntries(): Promise<DocsSearchEntry[]> {
  const entries = await orderedDocs()
  return entries.map((entry) => ({
    id: entry.id,
    title: entry.data.title,
    description: entry.data.description,
    section: DOC_SECTION_LABEL[entry.data.section],
    href: docsHref(entry.id),
    text: searchableMarkdown(entry.body ?? '')
  }))
}

export async function docsPageContext(currentId: string): Promise<{
  sectionLabel: string
  sectionHref: string
  previous: CollectionEntry<'docs'> | null
  next: CollectionEntry<'docs'> | null
  related: CollectionEntry<'docs'>[]
}> {
  const entries = await orderedDocs()
  const currentIndex = entries.findIndex((entry) => entry.id === currentId)
  const current = currentIndex >= 0 ? entries[currentIndex] : null
  if (!current) {
    return { sectionLabel: 'Docs', sectionHref: '/docs', previous: null, next: null, related: [] }
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  return {
    sectionLabel: DOC_SECTION_LABEL[current.data.section],
    sectionHref: docsSectionHref(current.data.section),
    previous: currentIndex > 0 ? entries[currentIndex - 1]! : null,
    next: currentIndex < entries.length - 1 ? entries[currentIndex + 1]! : null,
    related: current.data.related.flatMap((id) => {
      const entry = byId.get(id)
      return entry ? [entry] : []
    })
  }
}
