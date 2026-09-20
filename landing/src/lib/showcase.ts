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
    id: 'U4',
    approved: true,
    featured: true,
    /* Titled "routine" rather than "recurring", and the fourth bullet says each
       task runs once. A delegated task carries a single optional scheduledAt
       instant — there is no cron and no recurrence — so a title promising
       recurring work would be read as a weekly standup that fires itself. */
    title: 'Hand the routine work to a teammate',
    bullets: [
      'What shipped, what is in flight and what is blocked, assembled from git and your tracker.',
      'Release notes written for the people who use the product, not scraped from commit subjects.',
      'Set a goal and it works toward it across turns, pausing for you rather than running forever.',
      'Queue a task for a named teammate now, or set it to start at a time you choose. Each one runs once.',
      'Scheduled work runs while Agent V is open. There is no hosted service running it for you.'
    ],
    packages: ['standup-digest', 'release-notes', 'goal']
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

/* --------------------------------------------------- teammate scenarios - */

/**
 * When a teammate is worth the ceremony, written as the situation you are in
 * rather than the feature that answers it.
 *
 * Source is docs/teammates.md §16, whose header states it describes implemented
 * behaviour. The doc's own vocabulary is not always safe to lift: it titles one
 * of these "Recurring ops teammate", but a delegated task carries a single
 * optional scheduledAt instant and there is no cron, so W3 says outright that
 * each task runs once.
 *
 * `limit` is a field rather than a footnote on the section. Every constraint
 * here comes from §15 or §10 and belongs to one specific scenario — the closed
 * app to the scheduled one, the hand-authored file to the per-repository one.
 * Attaching it to the claim means the qualifier cannot drift away from the
 * thing it qualifies, or be dropped by a later edit that keeps the promise.
 */
export type TeammateScenario = {
  /** Stable handle. Quoted in review and in build errors; never rendered. */
  id: string
  /** false hides it from the site without discarding the copy. */
  approved: boolean
  /** The situation, in the reader's terms. */
  when: string
  /** What a teammate does about it. */
  then: string
  /** The constraint that keeps `then` honest. Rendered, never decorative. */
  limit?: string
}

export const TEAMMATE_SCENARIOS: TeammateScenario[] = [
  {
    id: 'W1',
    approved: true,
    when: 'You keep re-explaining the same conventions',
    then: 'Give the project its own teammate. It keeps a private memory tree per workspace, so what you established once is still there in the next session.',
    limit: 'Two teammates in one repository never read each other’s notes, and neither writes into the shared workspace brain.'
  },
  {
    id: 'W2',
    approved: true,
    when: 'You want work happening while you are away from the desk',
    then: 'Assign a task now, or set it to start at a time you choose. When it needs a decision it notifies you rather than hanging silently.',
    limit: 'Agent V has to still be running. A scheduled task cannot start with the application fully closed — that would need a hosted service, and there is not one.'
  },
  {
    id: 'W3',
    approved: true,
    when: 'Friday’s release steps are the same every week',
    then: 'Queue them up front. One teammate runs one task at a time, in order, and the queue is written to disk before it is acknowledged, so it survives a restart.',
    limit: 'Each task runs once. There is no repeating schedule — you queue the next set yourself.'
  },
  {
    id: 'W4',
    approved: true,
    when: 'A long run died when something restarted',
    then: 'Switch on auto-resume and a teammate-bound run picks itself back up at launch, with its identity, checkpoints and memory intact.',
    limit: 'A delegated task cut short by a restart is reported as failed instead, and waits for you to retry it, so a half-finished job never quietly runs twice.'
  },
  {
    id: 'W5',
    approved: true,
    when: 'You want to leave a chat running and come back to it',
    then: 'A chat message behaves like a task: you get a notification when it needs you, you can watch the browser it drives, and Stop always works.'
  },
  {
    id: 'W6',
    approved: true,
    when: 'One client repository needs a different tone',
    then: 'Commit a profile override into that repository, and everyone working in it gets the same house tone.',
    limit: 'That file is hand-authored today. The edit dialog writes the global profile only.'
  },
  {
    id: 'W7',
    approved: true,
    when: 'Not every job deserves your most expensive model',
    then: 'Pin a strong model to one teammate and a cheap one to another. Their chats and tasks use it automatically, and a manual pick still wins.'
  }
]

/**
 * The counterpart to the list above, from the same section's "Honest verdict".
 * It is deliberately not a scenario: the point of showing it is that it is the
 * case where the answer is no.
 */
export const TEAMMATE_NOT_WORTH_IT =
  'Not worth the ceremony when the work is a one-off you can explain fully in a single chat. A teammate earns its keep when you are repeating yourself, running workstreams that should not share a brain, or want work moving while you are away.'

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

  const scenarioIds = new Set<string>()
  for (const scenario of TEAMMATE_SCENARIOS) {
    if (scenarioIds.has(scenario.id)) {
      problems.push(`two teammate scenarios share the id ${scenario.id}`)
    }
    scenarioIds.add(scenario.id)
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

/** Approved teammate scenarios. An empty list drops the section entirely. */
export const LIVE_TEAMMATE_SCENARIOS: TeammateScenario[] = TEAMMATE_SCENARIOS.filter(
  (s) => s.approved
)

/** Approved use cases, in declaration order. */
export const LIVE_USE_CASES: UseCase[] = USE_CASES.filter((u) => u.approved)

/** The subset the homepage teases; /use-cases carries the full set. */
export const FEATURED_USE_CASES: UseCase[] = LIVE_USE_CASES.filter((u) => u.featured)

export const HOME_SECTIONS: ShowcaseSection[] = sectionsFor('home')
export const FEATURE_SECTIONS: ShowcaseSection[] = sectionsFor('features')
