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
  /* Deliberately describes the boundary and nothing more. The wrapper in
     src/main/agent/untrustedContent.ts is applied to all five sources named
     here, and it does neutralise close-tag sequences — but the system prompt
     does not yet tell the model what the envelope means, so this must not be
     read as "the agent ignores instructions it finds in a web page". */
  {
    id: 'A4',
    approved: true,
    section: 'principles',
    title: 'Fetched text arrives fenced',
    body: 'Whatever the agent reads from a web page, an MCP server, a skill or a workspace rule file is wrapped in a tagged envelope that records where it came from, and any closing sequence inside it is neutralised so the content cannot break out and pose as an instruction.'
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
    id: 'M3',
    approved: true,
    section: 'modes',
    title: 'Agent',
    body: 'Full catalog. Investigates, writes a plan as a real artefact in the run, then edits files, runs commands, commits and opens pull requests. Per-tool approval decides what it may do without asking first.'
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
  /* The catalogue in src/shared/dictation.ts ships whisper-tiny.en and
     whisper-small.en — both English-only, which is why this says so. The
     weights are not in the installer; they are fetched once on first use. */
  {
    id: 'E5',
    approved: true,
    section: 'environment',
    title: 'Dictation that never uploads audio',
    body: 'Talk instead of typing. A Whisper model runs inside the app and transcribes on your own machine, so no recording is sent anywhere. The weights are downloaded once the first time you use it. English only.'
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
  /* Grounded in docs/agent-tools.md plus the approval bounds recorded above
     `build_tool` in APPROVED_TOOLS. Says the agent can write itself a tool and
     that nothing it writes runs unseen; claims no sandbox — the module runs
     with full Node privileges in the utility process and approval is the
     control. */
  {
    id: 'X4',
    approved: true,
    section: 'extensibility',
    title: 'Tools it writes for itself',
    body: 'The agent can write a new tool for itself and use it from the next step like any built-in. What it writes is a Node module that executes in an isolated utility process and stays available to later runs. Nothing runs unseen: the code is on the approval card when the tool is written, and every call whose file changed shows an approval card again.'
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
    title: 'Two levels of autonomy',
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
    id: 'persistence',
    eyebrow: 'Persistence',
    title: 'It remembers between sessions',
    body: 'What one run establishes is still there in the next one.',
    pages: ['features']
  },
  { id: 'extensibility', eyebrow: 'Extensibility', title: 'MCP, skills and rules', pages: ['features'] }
]

/* ------------------------------------------------------------- use cases - */

/**
 * What people use Agent V for, as opposed to what it is built out of.
 *
 * Every bullet traces to something already shipped: a bundled skill's own
 * description or SKILL.md, a tool in the catalog, or an approved claim above.
 * Nothing here is written ahead of the code.
 *
 * Two bullets describe a skill stopping short of an irreversible action — not
 * posting a review reply, not resolving an incident. Those are instructions in
 * the skill's own SKILL.md, which is what ships and what the agent follows.
 * They are deliberately worded as what the skill does, because tool approval
 * defaults to off and nothing in the runtime would block the action.
 *
 * `packages` is not decoration. It names the marketplace entries a use case
 * leans on, and assertConsistent checks each against APPROVED_PACKAGES — so
 * dropping Sentry from the catalog fails the build instead of leaving a card
 * promising an integration nobody can install.
 */
export type UseCase = {
  /** Stable handle. Quoted in review and in build errors; never rendered. */
  id: string
  /** false hides it from the site without discarding the copy. */
  approved: boolean
  /** Also shown in the homepage teaser. */
  featured: boolean
  title: string
  bullets: string[]
  /** Marketplace ids this use case relies on; checked against the catalog. */
  packages: string[]
  href?: string
  linkLabel?: string
  visual?: 'incident' | 'upgrade'
}

export const USE_CASES: UseCase[] = [
  {
    id: 'U1',
    approved: true,
    featured: true,
    title: 'Review a pull request, and see it run',
    bullets: [
      'Review a diff for correctness, regressions, security, and the tests it is missing.',
      'Work through unresolved review threads: make the change each one asks for, and draft the reply.',
      'Drive the built-in browser to check the change renders — navigate, click, type, snapshot.',
      'The skill stops short of sending. It shows you the replies and the diff, and leaves posting, resolving and pushing to you.'
    ],
    packages: ['review-code', 'pr-review-reply', 'github'],
    href: '/features#tools',
    linkLabel: 'Every tool →'
  },
  {
    id: 'U2',
    approved: true,
    featured: false,
    title: 'Upgrade a dependency without a big-bang weekend',
    bullets: [
      'One dependency at a time, with the test suite run between each, and the risky ones kept separate.',
      'Pull version-correct documentation and examples for the library you are moving to.',
      'Fan the attempts out across child instances, each on its own git worktree and branch.'
    ],
    packages: ['dependency-upgrade', 'context7'],
    visual: 'upgrade'
  },
  {
    id: 'U3',
    approved: true,
    featured: true,
    title: 'Take an incident from alert to pull request',
    bullets: [
      'Read the issue, stack trace, release and affected-user count from your connected tracker.',
      'Reproduce it against the code, and state the blast radius before touching anything.',
      'Patch the smallest correct layer, and add a regression test that fails without the fix.',
      'Rerun a suspect test to tell a flake from a real failure, then fix the flake at its source.',
      'It opens the pull request, and leaves resolving or muting the incident to you.'
    ],
    packages: ['incident-triage', 'fix-bug', 'flake-hunter', 'sentry', 'linear'],
    visual: 'incident'
  },
  {
    id: 'U5',
    approved: true,
    featured: false,
    title: 'Land in a codebase you did not write',
    bullets: [
      'What it does, how it runs, and where to start reading.',
      'How a path actually works, traced through its contracts, data flow and tests.',
      'Ranked search over a local index of the repository, so it finds code before it guesses.',
      'Ask questions about any public GitHub repository without cloning it.'
    ],
    packages: ['repo-onboarding', 'explain-code', 'deepwiki'],
    href: '/features#environment',
    linkLabel: 'Your environment →'
  },
  {
    id: 'U6',
    approved: true,
    featured: false,
    title: 'And the rest of what ships with it',
    bullets: [
      'Implement a feature in the architecture and conventions the project already has.',
      'Add focused tests in the framework it already uses.',
      'Audit accessibility: semantics, keyboard, focus, contrast, names and motion.',
      'Design or change an HTTP, IPC or SDK contract.',
      'Write your own skill, or give the agent a persona.'
    ],
    packages: [
      'implement-feature',
      'write-tests',
      'accessibility',
      'api-design',
      'frontend-design',
      'create-skill',
      'persona-builder'
    ],
    href: '/extensions',
    linkLabel: 'Every package →'
  }
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
  'Agent-written tools':
    'build_tool writes a Node module that later executes in an isolated utility process.',
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
  // The agent records its own verdict on each done-when check, with the
  // evidence it saw. The site may say the run is judged against the checks;
  // it may not imply the app verifies them independently.
  'check_done_when',
  'ask_question',
  'switch_mode',
  'memory_list',
  'memory_read',
  'memory_write',
  // agent-written tools — a run writes a module that later executes as Node in
  // a utility process. Approved because the claim is bounded by an approval
  // card on every call whose file changed, and by Node builtins only. The site
  // may say the agent can write itself a tool; it may not imply that tool runs
  // without the user seeing its code.
  'build_tool'
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
  docs: 'Docs',
  refactor: 'Refactor',
  'analyze-api': 'Analyze API',
  // skills vendored from github.com/mattpocock/skills (MIT), published under
  // their author's name rather than ours — the catalog entry carries the
  // attribution the site renders.
  'ask-matt': 'Ask Matt',
  'review-changes': 'Review changes',
  'codebase-design': 'Codebase design',
  'diagnosing-bugs': 'Diagnosing bugs',
  'domain-modeling': 'Domain modeling',
  'grill-with-docs': 'Grill with docs',
  implement: 'Implement',
  'improve-codebase-architecture': 'Improve codebase architecture',
  prototype: 'Prototype',
  research: 'Research',
  'resolving-merge-conflicts': 'Resolving merge conflicts',
  'setup-matt-pocock-skills': 'Setup Matt Pocock skills',
  tdd: 'TDD',
  'to-spec': 'To spec',
  'to-tickets': 'To tickets',
  triage: 'Triage',
  wayfinder: 'Wayfinder',
  wizard: 'Wizard',
  'grill-me': 'Grill me',
  grilling: 'Grilling',
  handoff: 'Handoff',
  teach: 'Teach',
  'to-questionnaire': 'To questionnaire',
  'wait-what': 'Wait, what?',
  'writing-for-agents': 'Writing for agents',
  'setup-pre-commit': 'Setup pre-commit',
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

  const useCaseIds = new Set<string>()
  for (const useCase of USE_CASES) {
    if (useCaseIds.has(useCase.id)) problems.push(`two use cases share the id ${useCase.id}`)
    useCaseIds.add(useCase.id)

    /* A link needs both halves. An <a> with no text content fails the
       accessibility check in verify-site.mjs, and a label with nowhere to go
       renders nothing at all. */
    if (Boolean(useCase.href) !== Boolean(useCase.linkLabel)) {
      problems.push(`use case ${useCase.id} sets only one of href and linkLabel; it needs both or neither`)
    }

    /* A use case naming a package the catalog no longer ships would promise an
       integration nobody can install, so it is a build failure rather than a
       card that quietly stops being true. */
    for (const id of useCase.packages) {
      if (APPROVED_PACKAGES[id] === undefined) {
        problems.push(`use case ${useCase.id} names the package "${id}", which is not on the approved list`)
      }
    }
  }

  /* /use-cases is a hardcoded route in verify-site.mjs. Unapproving the last
     use case would leave the page an empty shell rather than removing it. */
  if (!USE_CASES.some((u) => u.approved)) {
    problems.push('no use case is approved, which would leave /use-cases empty — remove the route instead')
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

/** Approved use cases, in declaration order. */
export const LIVE_USE_CASES: UseCase[] = USE_CASES.filter((u) => u.approved)

/** The subset the homepage teases; /use-cases carries the full set. */
export const FEATURED_USE_CASES: UseCase[] = LIVE_USE_CASES.filter((u) => u.featured)

export const HOME_SECTIONS: ShowcaseSection[] = sectionsFor('home')
export const FEATURE_SECTIONS: ShowcaseSection[] = sectionsFor('features')
