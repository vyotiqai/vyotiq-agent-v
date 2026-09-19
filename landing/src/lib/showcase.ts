import app from '../data/app.json'

/**
 * The approved showcase — the one file that decides what the website may claim.
 *
 * Nothing about the product reaches a page except through this file. The prose
 * claims live here rather than in the .astro pages, so reviewing what the site
 * says is reading one list instead of grepping eight templates.
 *
 * Two kinds of thing are governed:
 *
 *  1. CLAIMS — hand-written capability copy. Each one carries an id you can
 *     quote in review, the page and section it appears in, and an `approved`
 *     flag. Setting a claim to false pulls it off the site without deleting the
 *     wording, so an unapproved claim is still there to reconsider later. A
 *     section whose claims are all unapproved disappears entirely, heading,
 *     anchor and jump-nav entry together.
 *
 *  2. The allowlists — every tool, provider and marketplace package the site is
 *     permitted to name. These are generated into src/data/app.json from the
 *     application's own source on every build, so without a gate a capability
 *     added to the app would appear on the website by name with nobody having
 *     read it. assertApproved() below turns that into a build failure.
 *
 * Adding a capability to the app therefore breaks `pnpm site:build` until it is
 * approved here. That is deliberate: it is the only moment at which somebody is
 * guaranteed to look. The reverse — an entry here that the app no longer ships
 * — is harmless and does not fail, because the pages render from the baked data
 * and simply never reach it.
 */

const toolTotal = app.tools.names.length
const ext = app.extensions

/* ------------------------------------------------------------- the claims - */

export type SectionId =
  | 'principles'
  | 'modes'
  | 'runs'
  | 'parallelism'
  | 'environment'
  | 'persistence'
  | 'teammates'
  | 'extensibility'

export type Claim = {
  /** Stable handle. Quoted in review and in build errors; never rendered. */
  id: string
  /** false hides it from the site without discarding the copy. */
  approved: boolean
  /** The section it belongs to; the section decides which pages show it. */
  section: SectionId
  title: string
  body: string
}

export const CLAIMS: Claim[] = [
  /* -- homepage ----------------------------------------------------------- */
  /* Superseded: this was the homepage's one-paragraph summary of parallelism
     and checkpoints, written when the homepage carried no sections of its own.
     The homepage now shows Runs and Parallelism in full, so approving this
     again would state the same thing twice a screen apart. */
  {
    id: 'H1',
    approved: false,
    section: 'parallelism',
    title: 'Parallel work on real branches',
    body: 'Fan a task out to child instances. Each one gets its own git worktree and branch, so they never collide, and you merge the result back when it is ready. Every file write is checkpointed with a content hash, so you can rewind to any earlier point in the run.'
  },

  /* -- /features · principles --------------------------------------------- */
  {
    id: 'A1',
    approved: true,
    section: 'principles',
    title: 'It works on your checkout',
    body: `Not a chat window you paste snippets into. Agent V opens the repository you point it at and works there, with ${toolTotal} built-in tools covering the file tree, a real terminal, git, GitHub, a browser and a language server.`
  },
  {
    id: 'A2',
    approved: true,
    section: 'principles',
    title: 'Your models, your keys',
    body: `${app.providers.total} providers, configured with your own API keys. Requests go straight from your machine to the provider. There is no Vyotiq service in the middle, and nothing is metered or resold.`
  },
  {
    id: 'A3',
    approved: true,
    section: 'principles',
    title: 'Local by default',
    body: 'Code, chats, run history and memory stay on disk. Keys are held in the OS keychain. Crash reporting is off unless you turn it on. Point it at Ollama and nothing leaves the machine at all.'
  },

  /* -- /features · modes --------------------------------------------------- */
  {
    id: 'M1',
    approved: true,
    section: 'modes',
    title: 'Ask',
    body: 'Read-only. The agent can search and read the repository and answer questions, but cannot edit files, run the terminal or touch git. Use it to understand code you did not write.'
  },
  {
    id: 'M2',
    approved: true,
    section: 'modes',
    title: 'Plan',
    body: 'Investigates, then writes a plan you approve before anything changes. The plan is a real artefact in the run, not a throwaway message.'
  },
  {
    id: 'M3',
    approved: true,
    section: 'modes',
    title: 'Agent',
    body: 'Full catalog. Edits files, runs commands, commits, opens pull requests. Per-tool approval decides what it may do without asking first.'
  },

  /* -- /features · runs ---------------------------------------------------- */
  {
    id: 'R1',
    approved: true,
    section: 'runs',
    title: 'Checkpoints on every write',
    body: 'Each file the agent writes is checkpointed with a SHA-256 of its contents. If something drifts underneath the run, the conflict is detected rather than silently overwritten.'
  },
  {
    id: 'R2',
    approved: true,
    section: 'runs',
    title: 'Rewind and fork',
    body: 'Go back to any earlier point in a run and resume from there, keeping or discarding individual writes. Or fork the run and take a different approach without losing the original.'
  },
  {
    id: 'R3',
    approved: true,
    section: 'runs',
    title: 'Goals and loops',
    body: 'Give the agent a goal it works toward across multiple turns. Interrupted runs resume automatically after a restart instead of being abandoned mid-task.'
  },
  {
    id: 'R4',
    approved: true,
    section: 'runs',
    title: 'Context compaction',
    body: 'Long runs compact their own history rather than hitting a wall, with a live context meter so you can see how much headroom is left.'
  },

  /* -- /features · parallelism --------------------------------------------- */
  {
    id: 'P1',
    approved: true,
    section: 'parallelism',
    title: 'Isolated by construction',
    body: 'A child instance gets its own git worktree and branch. Two children editing the same file cannot corrupt each other, because they are not in the same working tree.'
  },
  {
    id: 'P2',
    approved: true,
    section: 'parallelism',
    title: 'Spawn, await, pull, merge',
    body: 'Five tools drive the lifecycle: spawn, await, pull, merge and cancel. The parent decides when a child’s work comes back and merges the branch when it is ready.'
  },

  /* -- /features · your environment ---------------------------------------- */
  {
    id: 'E1',
    approved: true,
    section: 'environment',
    title: 'A real terminal',
    body: 'A PTY-backed shell in the workspace, shared between you and the agent. Configure which shell it uses.'
  },
  {
    id: 'E2',
    approved: true,
    section: 'environment',
    title: 'Git and GitHub',
    body: 'Status, diff, stage, commit with a generated message, branches, blame and conflict resolution. Pull requests and issues go through the GitHub CLI you are already signed into.'
  },
  {
    id: 'E3',
    approved: true,
    section: 'environment',
    title: 'A built-in browser',
    body: 'The agent can navigate, click, fill forms and read pages back. You can watch it, take control at any time, and restrict it to an allowlist of domains.'
  },
  {
    id: 'E4',
    approved: true,
    section: 'environment',
    title: 'Notebooks, PDFs and documents',
    body: 'Jupyter notebook cell editing, plus text extraction from PDFs and Word documents so they can be part of the context.'
  },
  {
    id: 'I1',
    approved: true,
    section: 'environment',
    title: 'Keyword search that ranks',
    body: 'A per-workspace SQLite index with a trigram index and BM25 ranking. camelCase identifiers work as typed, and it is gitignore-aware.'
  },
  {
    id: 'I2',
    approved: true,
    section: 'environment',
    title: 'Semantic search, computed locally',
    body: 'Dense embeddings with a MiniLM model that runs on your machine. Useful when you know the concept but not the wording. Your code is never sent anywhere to be embedded.'
  },
  {
    id: 'I3',
    approved: true,
    section: 'environment',
    title: 'Language server queries',
    body: 'Definitions, references and diagnostics through a real LSP rather than guessing from text matches.'
  },

  /* -- /features · persistence --------------------------------------------- */
  {
    id: 'S1',
    approved: true,
    section: 'persistence',
    title: 'Workspace memory',
    body: 'Notes kept under .vyotiq/memory/ in the repository and re-read on later runs, so context you established once does not have to be re-explained.'
  },
  /* Superseded by the teammates section, which says all of this in parts. */
  {
    id: 'S2',
    approved: false,
    section: 'persistence',
    title: 'Teammates',
    body: 'Persistent agent identities with their own private memory, a pinned model and their own delegated tasks. They survive restarts and pick interrupted work back up.'
  },

  /* -- teammates ----------------------------------------------------------
     Every claim below is grounded in docs/teammates.md, which states it
     reflects implemented behaviour rather than intent. Note what is NOT
     claimed: nothing here says a teammate works while the application is
     closed. Per that document's own limitations, a locally scheduled task
     cannot start with the app fully shut, and away-mode cloud execution is
     not shipped. */
  {
    id: 'T1',
    approved: true,
    section: 'teammates',
    title: 'An identity, not a session',
    body: 'A teammate has its own persona, tone and an optional pinned model, and it outlives any one conversation. Runs record which teammate they belonged to, so a restart picks the identity back up rather than starting over as a stranger.'
  },
  {
    id: 'T2',
    approved: true,
    section: 'teammates',
    title: 'Memory of its own',
    body: 'Each teammate keeps a private memory tree per workspace, under .vyotiq/agents/. Two teammates in the same repository never read each other’s notes, and neither one writes into the shared workspace brain.'
  },
  {
    id: 'S3',
    approved: true,
    section: 'teammates',
    title: 'Work you hand over',
    body: 'Assign a teammate a task now or schedule it for later. The queue is written to disk before it is acknowledged, so it survives a restart, and every task keeps the link back to its own transcript.'
  },
  {
    id: 'T3',
    approved: true,
    section: 'teammates',
    title: 'One run at a time, and honest about it',
    body: 'A teammate is single-threaded by design, so a delegated task and a chat can never interleave writes to one memory. A task cut short by a restart is reported as failed and waits for you to retry it, rather than quietly running a second time.'
  },

  /* -- /features · extensibility ------------------------------------------- */
  {
    id: 'X1',
    approved: true,
    section: 'extensibility',
    title: 'MCP client',
    body: 'Connect Model Context Protocol servers over stdio or HTTP, including OAuth flows. List their tools, resources and prompts, and pin the ones you want into the catalog.'
  },
  {
    id: 'X2',
    approved: true,
    section: 'extensibility',
    title: 'Skills',
    body: 'Reusable instructions the agent can load into a run, invoked as slash commands. Write your own or install bundled ones.'
  },
  {
    id: 'X3',
    approved: true,
    section: 'extensibility',
    title: 'Rules',
    body: 'Per-workspace standing instructions under .vyotiq/rules/ that apply to every run in that repository.'
  },
  {
    id: 'H2',
    approved: true,
    section: 'extensibility',
    title: `${ext.total} packages in the box`,
    body: `${ext.counts.mcp} MCP servers, ${ext.counts.skill} skills and ${ext.counts.plugin} plugin rule sets, bundled in the marketplace and installed per workspace. No separate registry account, and no network fetch to browse them.`
  }
]

/* ---------------------------------------------------------- the sections - */

export type Page = 'home' | 'features'

/**
 * Section copy, in the order each page renders it.
 *
 * `pages` decides where a section appears, and `display` how it appears there.
 * The three that describe how a run behaves — runs, parallelism, persistence —
 * are showcased on the homepage as full-width cards and repeated on /features
 * as compact rows, because a page called "Everything Agent V can do" cannot
 * leave them out.
 */
const SECTION_META: {
  id: SectionId
  eyebrow: string
  title: string
  /**
   * Standfirst under the section heading. These summarise the section's own
   * approved claims and must not assert anything the claims below do not.
   */
  body?: string
  /** Render names in a fixed lead column instead of stacked. */
  lead?: boolean
  pages: Page[]
  /**
   * Treatment per page. 'rows' is the reading treatment — a heading column
   * beside a list. 'cards' gives the section the full width and sets each claim
   * on its own surface. Anything unlisted falls back to 'rows'.
   */
  display?: Partial<Record<Page, 'rows' | 'cards'>>
}[] = [
  { id: 'principles', eyebrow: 'Principles', title: 'What Agent V is', pages: ['features'] },
  {
    id: 'modes',
    eyebrow: 'Modes',
    title: 'Three levels of autonomy',
    body: 'Each mode exposes a different slice of the tool catalog. Switch between them mid-run without losing the conversation.',
    lead: true,
    pages: ['features']
  },
  {
    id: 'runs',
    eyebrow: 'Runs',
    title: 'Long work, not single answers',
    body: 'A run can span hours, survive a restart, and be wound back to any point along the way.',
    pages: ['home', 'features'],
    display: { home: 'cards' }
  },
  {
    id: 'parallelism',
    eyebrow: 'Parallelism',
    title: 'Child instances on real git worktrees',
    body: 'Work that would queue up on a single checkout runs side by side instead.',
    pages: ['home', 'features'],
    display: { home: 'cards' }
  },
  {
    id: 'environment',
    eyebrow: 'Your environment',
    title: 'Your tools, and an index of your code',
    pages: ['features']
  },
  {
    id: 'teammates',
    eyebrow: 'Teammates',
    title: 'Agents with a name, a memory and a queue',
    body: 'Instances are the hands. A teammate is the who — it persists across sessions, keeps its own memory, and takes work you hand it.',
    pages: ['home', 'features'],
    display: { home: 'cards' }
  },
  {
    id: 'persistence',
    eyebrow: 'Persistence',
    title: 'It remembers between sessions',
    body: 'What one run establishes is still there in the next one.',
    pages: ['features']
  },
  { id: 'extensibility', eyebrow: 'Extensibility', title: 'MCP, skills and rules', pages: ['features'] }
]

/** Blurbs for the tool-catalog groups. The grouping logic lives in tools.ts. */
export const TOOL_GROUP_BLURBS: Record<string, string> = {
  'Files & code': 'Read, search and edit the working tree directly.',
  'Code intelligence':
    'Keyword and semantic search over a locally built index, plus language-server queries.',
  Terminal: 'A real shell in your workspace.',
  Git: 'Inspect, stage and commit without leaving the run.',
  GitHub: 'Open and review pull requests, file issues.',
  Browser: 'Drive a real browser — navigate, click, type, read the page back.',
  MCP: 'Discover and pin tools, resources and prompts from connected MCP servers.',
  Skills: 'Load an enabled marketplace skill or plugin rule set into the run.',
  'Agent instances': 'Fan work out to child runs on their own git worktree, then merge back.',
  'Planning & memory': 'Track work, set goals, switch modes and keep notes across runs.'
}

/* ------------------------------------------------------- the allowlists - */

/**
 * Every tool the site may name. These appear individually on /features, so a
 * new one is a new public claim about what the agent can do.
 */
export const APPROVED_TOOLS: string[] = [
  // files & code
  'read',
  'edit',
  'search',
  'glob',
  'grep',
  'list_dir',
  'str_replace',
  'delete',
  'edit_notebook',
  // code intelligence
  'codebase_search',
  'concept_search',
  'lsp',
  'diagnostics',
  'run_tests',
  // terminal
  'terminal',
  // git
  'git_status',
  'git_diff',
  'git_commit',
  'git_apply',
  // github
  'github_pr_create',
  'github_pr_review',
  'github_issue',
  // browser
  'browser_search',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_fill',
  'browser_tabs',
  'browser_back',
  'browser_forward',
  'browser_wait_for_selector',
  'browser_wait_for_url',
  'browser_press_key',
  'browser_select_option',
  'browser_hover',
  'browser_wait_for_text',
  'browser_handle_dialog',
  // mcp
  'mcp_list_tools',
  'request_mcp_tools',
  'release_mcp_tools',
  'mcp_list_resources',
  'mcp_read_resource',
  'mcp_list_prompts',
  'mcp_get_prompt',
  // skills
  'Skill',
  // agent instances
  'spawn_agent_instance',
  'await_agent_instance',
  'pull_agent_instance',
  'merge_agent_instance',
  'cancel_agent_instance',
  // planning & memory
  'todo_write',
  'create_plan',
  'create_goal',
  'update_goal',
  'ask_question',
  'switch_mode',
  'memory_list',
  'memory_read',
  'memory_write'
]

/** Model providers the site may show a logo and a name for. */
export const APPROVED_PROVIDERS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  ollama: 'Ollama',
  deepseek: 'DeepSeek',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  mistral: 'Mistral',
  custom: 'Custom OpenAI-compatible',
  opencode: 'OpenCode Go'
}

/** Marketplace packages the site may list. The label is checked too, because a
    rename is new copy on a public page. */
export const APPROVED_PACKAGES: Record<string, string> = {
  // MCP servers
  github: 'GitHub',
  gmail: 'Gmail',
  'google-drive': 'Google Drive',
  'google-calendar': 'Google Calendar',
  filesystem: 'Filesystem',
  memory: 'Memory',
  'sequential-thinking': 'Sequential thinking',
  fetch: 'Fetch',
  git: 'Git',
  time: 'Time',
  context7: 'Context7',
  deepwiki: 'DeepWiki',
  huggingface: 'Hugging Face',
  'cloudflare-docs': 'Cloudflare Docs',
  linear: 'Linear',
  notion: 'Notion',
  sentry: 'Sentry',
  asana: 'Asana',
  vercel: 'Vercel',
  supabase: 'Supabase',
  figma: 'Figma',
  canva: 'Canva',
  atlassian: 'Atlassian',
  intercom: 'Intercom',
  stripe: 'Stripe',
  slack: 'Slack',
  hubspot: 'HubSpot',
  playwright: 'Playwright',
  'chrome-devtools': 'Chrome DevTools',
  // skills
  'implement-feature': 'Implement feature',
  'fix-bug': 'Fix bug',
  'review-code': 'Review code',
  'write-tests': 'Write tests',
  'explain-code': 'Explain code',
  'create-skill': 'Create skill',
  goal: 'Goal',
  'frontend-design': 'Frontend design',
  accessibility: 'Accessibility',
  'api-design': 'API design',
  'persona-builder': 'Persona builder',
  'incident-triage': 'Incident triage',
  'pr-review-reply': 'PR review reply',
  'standup-digest': 'Standup digest',
  'dependency-upgrade': 'Dependency upgrade',
  'release-notes': 'Release notes',
  'repo-onboarding': 'Repo onboarding',
  'flake-hunter': 'Flake hunter',
  // plugin rule sets
  devtools: 'Devtools',
  'electron-app': 'Electron app',
  quality: 'Quality',
  shipping: 'Shipping'
}

/* -------------------------------------------------------------- the gate - */

/**
 * Compares what the application ships against what has been approved, and
 * throws on anything unapproved. Astro imports this module while building every
 * page, so the throw is a build failure: an unreviewed capability cannot reach
 * a rendered page, let alone a deploy.
 */
/**
 * Catches edits to this file that would otherwise go quiet. A claim filed under
 * a section that does not exist renders nowhere and reports nothing, which is
 * the one way an approved claim can disappear without anyone noticing — so it
 * is a build failure rather than an absence.
 */
function assertConsistent(): void {
  const problems: string[] = []

  const seen = new Set<string>()
  for (const claim of CLAIMS) {
    if (seen.has(claim.id)) problems.push(`two claims share the id ${claim.id}`)
    seen.add(claim.id)
  }

  const sections = new Set<string>(SECTION_META.map((s) => s.id))
  for (const claim of CLAIMS) {
    if (!sections.has(claim.section)) {
      problems.push(`claim ${claim.id} is filed under "${claim.section}", which no section defines`)
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `\n\n  landing/src/lib/showcase.ts does not hold together:\n\n` +
        problems.map((p) => `    · ${p}`).join('\n') +
        `\n`
    )
  }
}

function assertApproved(): void {
  const problems: string[] = []

  const unapprovedTools = app.tools.names.filter((n) => !APPROVED_TOOLS.includes(n))
  if (unapprovedTools.length > 0) {
    problems.push(`tools not on the list: ${unapprovedTools.join(', ')}`)
  }

  for (const provider of app.providers.list) {
    const approved = APPROVED_PROVIDERS[provider.id]
    if (approved === undefined) {
      problems.push(`provider not on the list: ${provider.id} ("${provider.label}")`)
    } else if (approved !== provider.label) {
      problems.push(`provider ${provider.id} is now labelled "${provider.label}", approved as "${approved}"`)
    }
  }

  for (const pkg of ext.list) {
    const approved = APPROVED_PACKAGES[pkg.id]
    if (approved === undefined) {
      problems.push(`package not on the list: ${pkg.id} ("${pkg.name}")`)
    } else if (approved !== pkg.name) {
      problems.push(`package ${pkg.id} is now named "${pkg.name}", approved as "${approved}"`)
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `\n\n  The website may only show capabilities that have been approved.\n` +
        `  ${problems.length} need a decision:\n\n` +
        problems.map((p) => `    · ${p}`).join('\n') +
        `\n\n  Approve them in landing/src/lib/showcase.ts, or take them out of the app.\n`
    )
  }
}

assertConsistent()
assertApproved()

/* ---------------------------------------------------------- what renders - */

const live = CLAIMS.filter((c) => c.approved)

export type ShowcaseSection = {
  id: SectionId
  eyebrow: string
  title: string
  body?: string
  lead: boolean
  display: 'rows' | 'cards'
  claims: Claim[]
}

/**
 * The approved sections for one page, in declaration order.
 *
 * A section with nothing approved in it is dropped entirely, so unapproving its
 * last claim also removes the heading, the anchor and the jump-nav entry rather
 * than leaving an empty shell.
 */
function sectionsFor(page: Page): ShowcaseSection[] {
  return SECTION_META.filter((meta) => meta.pages.includes(page))
    .map((meta) => ({
      id: meta.id,
      eyebrow: meta.eyebrow,
      title: meta.title,
      body: meta.body,
      lead: meta.lead ?? false,
      display: meta.display?.[page] ?? 'rows',
      claims: live.filter((c) => c.section === meta.id)
    }))
    .filter((section) => section.claims.length > 0)
}

export const HOME_SECTIONS: ShowcaseSection[] = sectionsFor('home')
export const FEATURE_SECTIONS: ShowcaseSection[] = sectionsFor('features')
