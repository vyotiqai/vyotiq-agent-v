import app from '../data/app.json'

/**
 * Everything the website says about what Agent V does.
 *
 * Nothing about the product reaches a page except through this file. The pages
 * decide layout; the words that make a claim about the product live here, so
 * reviewing what the site says is reading one file instead of grepping eight
 * templates.
 *
 * Two kinds of thing are governed:
 *
 *  1. CLAIMS — hand-written copy. Each one carries an id you can quote in
 *     review and an `approved` flag. Setting it to false takes the claim off
 *     every page without deleting the wording. A claim can also name a tool it
 *     `requires`; it renders only when the app the site is built from ships
 *     that tool, so the site never describes a feature ahead of the release.
 *
 *  2. The allowlists — every tool, provider and marketplace package the site
 *     may name. src/data/app.json is baked from the application's own source on
 *     every build, so without a gate a tool added to the app would appear on the
 *     website by name with nobody having read it. assertApproved() turns that
 *     into a build failure. Approve the new entry here, or take it out of the
 *     app; never loosen the gate.
 *
 * How the copy is written, so later edits keep the same voice:
 *  - Say what the reader gets first. The mechanism goes in `detail`, which
 *    renders smaller and quieter.
 *  - Plain words, short sentences, no em dashes.
 *  - State things once. A trust fact (no account, keys in the keychain) is
 *    said in one place on each page, not repeated in every section.
 *  - Never promise more than the code does. Where a claim sits close to an
 *    over-promise, the comment above it says exactly where the line is.
 */

const tools: string[] = app.tools.names
const ext = app.extensions
const providers = app.providers

/* ------------------------------------------------------------- the claims - */

export type Claim = {
  /** Stable handle. Quoted in review and in build errors; never rendered. */
  id: string
  /** false hides it from the site without discarding the copy. */
  approved: boolean
  title: string
  body: string
  /** How it works, for readers who want the mechanism. Rendered quieter. */
  detail?: string
  /** Rendered only when the app being described ships this tool. */
  requires?: string
}

export const CLAIMS: Claim[] = [
  /* -- how a task goes (home) ---------------------------------------------- */
  {
    id: 'K1',
    approved: true,
    title: 'Say what you want',
    body: 'Describe the change in your own words. In Ask mode it only reads and answers. In Agent mode it can change things.'
  },
  /* Agent mode writes its plan as a file in the run (M3), but a small job may
     not need one, so this says "bigger jobs" rather than "always". */
  {
    id: 'K2',
    approved: true,
    title: 'It reads first',
    body: 'It searches the repository and reads the files that matter. For bigger jobs it writes a plan you can read before it edits anything.'
  },
  {
    id: 'K3',
    approved: true,
    title: 'It makes the change',
    body: 'It edits the files, then runs commands and tests in a real terminal to check its own work.'
  },
  {
    id: 'K4',
    approved: true,
    title: 'You review it',
    body: 'Each edit shows up as a diff. Keep what you want, roll back the rest, and commit when you’re happy.'
  },

  /* -- working in your repository ----------------------------------------- */
  {
    id: 'A1',
    approved: true,
    title: 'It works in your checkout',
    body: `It isn’t a chat window you paste snippets into. Agent V opens the repository you point it at and works right there, with ${tools.length} built-in tools for the file tree, a real terminal, git, GitHub, a browser and a language server.`
  },
  {
    id: 'E1',
    approved: true,
    title: 'A real terminal',
    body: 'A shell in your workspace that you and the agent share. You choose which shell it runs.',
    detail: 'It’s backed by a real PTY.'
  },
  {
    id: 'E2',
    approved: true,
    title: 'Git and GitHub',
    body: 'Status, diffs, staging, commits with a written message, branches, blame and conflict resolution. Pull requests and issues go through the GitHub CLI you’re already signed in to.'
  },
  {
    id: 'E3',
    approved: true,
    title: 'A built-in browser',
    body: 'The agent can open pages, click, fill in forms and read the page back. You can watch it work, take over at any time, and limit it to a list of domains.'
  },
  {
    id: 'E4',
    approved: true,
    title: 'Notebooks, PDFs and Word files',
    body: 'It edits Jupyter notebook cells and pulls the text out of PDFs and Word documents, so they can be part of what it reads.'
  },
  /* src/shared/dictation.ts ships whisper-tiny.en and whisper-small.en, both
     English-only. The weights are not in the installer; they download once. */
  {
    id: 'E5',
    approved: true,
    title: 'Dictation that stays on your machine',
    body: 'Talk instead of typing. A Whisper model runs inside the app and transcribes on your computer, so no recording is sent anywhere. The model downloads once, the first time you use it. English only.'
  },

  /* -- staying in control -------------------------------------------------- */
  {
    id: 'M1',
    approved: true,
    title: 'Ask mode',
    body: 'Read-only. It can search and read the repository and answer questions, but it can’t edit files, run the terminal or touch git. Good for getting to know code you didn’t write.'
  },
  /* Describes Ask and Agent without counting modes: 1.0.0 also has Plan, and
     the release after it folds Plan into Agent. Both statements hold for both. */
  {
    id: 'M3',
    approved: true,
    title: 'Agent mode',
    body: 'Every tool is available. It looks around, writes a plan you can read, then edits files, runs commands, commits and opens pull requests. You decide which tools it may use without asking first.',
    detail: 'Switch between Ask and Agent in the middle of a run without losing the conversation.'
  },
  /* Describes the boundary and nothing more. The wrapper in
     src/main/agent/untrustedContent.ts covers all four sources named here and
     neutralises close-tag sequences, but the system prompt does not tell the
     model what the envelope means. So this must never be reworded into "the
     agent ignores instructions it finds in a web page". It says the text
     cannot break out of the envelope, which is what the code guarantees. */
  {
    id: 'A4',
    approved: true,
    title: 'Fetched text is fenced off',
    body: 'Anything it reads from a web page, an MCP server, a skill or a workspace rule file is wrapped in a labeled envelope that records where it came from. Closing tags inside that text are neutralized, so it can’t break out of the envelope.'
  },

  /* -- long runs ----------------------------------------------------------- */
  {
    id: 'R1',
    approved: true,
    title: 'Checkpoints on every write',
    body: 'Every file the agent writes is checkpointed with a SHA-256 of its contents. If the file changes underneath the run, the conflict is flagged, not silently overwritten.'
  },
  /* 1.0.0 has a fork backend (forkRun) but no control that reaches it, so the
     site must not offer forking until a release wires it up. Revert works at
     the level of a sent message, and it restores files a child agent wrote. */
  {
    id: 'R2',
    approved: true,
    title: 'Rewind',
    body: 'Go back to before any message you sent and carry on from there. The files the agent changed since then are put back the way they were.'
  },
  {
    id: 'R3',
    approved: true,
    title: 'Goals that survive a restart',
    body: 'Give it a goal and it keeps working toward it over several turns. If the app restarts in the middle of a run, the run picks up again on its own.'
  },
  {
    id: 'R4',
    approved: true,
    title: 'Automatic context compaction',
    body: 'When a long run fills its context, it compacts its own history and keeps going. A live meter shows how much room is left.'
  },

  /* -- parallel work ------------------------------------------------------- */
  /* Worktree isolation is the spawn tool's default, not the only mode: the
     agent may choose `shared` for small jobs with disjoint path scopes. */
  {
    id: 'P1',
    approved: true,
    title: 'Each child gets its own worktree',
    body: 'By default a child agent works in its own git worktree, on its own branch, so two children editing the same file can’t corrupt each other’s work. For small, separate jobs it can share your working tree instead, with each child kept to its own paths.'
  },
  {
    id: 'P2',
    approved: true,
    title: 'Spawn, await, pull, merge',
    body: 'The main run manages its children with five tools: spawn, await, pull, merge and cancel. It decides when each child’s work comes back, and merges the branch when it’s ready.'
  },

  /* -- finding its way around your code ----------------------------------- */
  {
    id: 'I1',
    approved: true,
    title: 'Keyword search that ranks',
    body: 'Each workspace gets a local search index in SQLite, with trigram matching and BM25 ranking. camelCase names work as you type them, and .gitignore is respected.'
  },
  {
    id: 'I2',
    approved: true,
    title: 'Semantic search on your machine',
    body: 'Search by meaning when you know the idea but not the words. Embeddings come from a MiniLM model that runs locally, so your code is never sent anywhere to be embedded.'
  },
  {
    id: 'I3',
    approved: true,
    title: 'Language server queries',
    body: 'Definitions, references and diagnostics come from a real language server, not from guessing at text matches.'
  },

  /* -- memory and rules ---------------------------------------------------- */
  {
    id: 'S1',
    approved: true,
    title: 'Workspace memory',
    body: 'Notes it keeps under .vyotiq/memory/ in your repository and reads again on later runs, so you don’t have to explain the same thing twice.'
  },
  {
    id: 'X3',
    approved: true,
    title: 'Rules',
    body: 'Standing instructions for a workspace, kept under .vyotiq/rules/, that apply to every run in that repository.'
  },

  /* -- models and privacy -------------------------------------------------- */
  {
    id: 'A2',
    approved: true,
    title: 'Your models, your keys',
    body: `${providers.total} providers, set up with your own API keys. Requests go straight from your computer to the provider. There’s no Vyotiq service in between, and nothing is metered or resold.`
  },
  /* "Stay on your disk" means stored there. It does not mean the code never
     leaves: a hosted model receives what the run sends it, which is why the
     last sentence is the one about Ollama. */
  {
    id: 'A3',
    approved: true,
    title: 'Local by default',
    body: 'Code, chats, run history and memory stay on your disk, and keys are kept in your OS keychain. Crash reporting is off unless you turn it on. Point it at Ollama and nothing leaves your machine at all.'
  },

  /* -- extending it -------------------------------------------------------- */
  {
    id: 'X1',
    approved: true,
    title: 'MCP servers',
    body: 'Connect Model Context Protocol servers over stdio or HTTP, OAuth included. See their tools, resources and prompts, and pin the ones you want.'
  },
  {
    id: 'X2',
    approved: true,
    title: 'Skills',
    body: 'Reusable instructions the agent loads into a run, called with a slash command. Write your own or install the ones that ship with the app.'
  },
  /* Grounded in docs/agent-tools.md and the approval bounds noted above
     build_tool in APPROVED_TOOLS. It claims no sandbox: the module runs with
     full Node privileges in a utility process, and approval is the control.
     1.0.0 does not ship build_tool, so this stays off the site until it does. */
  {
    id: 'X4',
    approved: true,
    requires: 'build_tool',
    title: 'Tools it writes for itself',
    body: 'The agent can write itself a new tool and use it from the next step like any built-in one. The tool is a Node module that runs in a separate utility process and stays available to later runs. Nothing runs unseen: you see the code on the approval card when the tool is written, and a tool whose file has changed asks you again before it runs.'
  },
  {
    id: 'H2',
    approved: true,
    title: `${ext.total} packages in the box`,
    body: `${ext.counts.mcp} MCP servers, ${ext.counts.skill} skills and ${ext.counts.plugin} plugins come bundled and install per workspace. You don’t need a registry account, and browsing them doesn’t touch the network.`
  },

  /* -- nothing goes through us (home) -------------------------------------- */
  {
    id: 'F1',
    approved: true,
    title: 'No account',
    body: 'There’s nothing to sign up for. Install it, add a key and start.'
  },
  {
    id: 'F2',
    approved: true,
    title: 'Keys in your keychain',
    body: 'API keys are kept in your operating system’s keychain.'
  },
  {
    id: 'F3',
    approved: true,
    title: 'History on your disk',
    body: 'Chats, run history and memory are saved on your machine. Crash reporting is off unless you turn it on.'
  },
  {
    id: 'F4',
    approved: true,
    title: 'Open source',
    body: 'The code is on GitHub under GPL-3.0-or-later. Read it, build it yourself or fork it.'
  }
]

/* ----------------------------------------------------------- the home page - */

/**
 * The home page, top to bottom. Headings here are claims too, so they live in
 * this file with everything else the site asserts.
 */
export const HOME = {
  hero: {
    lines: ['Describe the change.', 'Review the diff.'],
    /* A1 (works in your checkout), A2 (your model) and R2 (roll back). */
    lede: 'Agent V is a free, open-source coding agent for Windows, macOS and Linux. It works in your own checkout, with the model you pick, and you can roll back any edit it makes.'
  },
  steps: { title: 'How a task goes', claims: ['K1', 'K2', 'K3', 'K4'] },
  /* Each row pairs one idea with a screenshot from src/lib/media.ts. The body
     text restates the claims named in `from` for a first-time reader. */
  rows: [
    {
      id: 'rollback',
      media: 'rewind',
      from: ['R1', 'R2'],
      title: 'Roll back anything it wrote',
      body: 'Every file the agent writes is checkpointed. Go back to before any message you sent and carry on from there, and the files it changed since then are put back the way they were.',
      detail: 'Each checkpoint holds a SHA-256 of the file, so if a file changes underneath the run, the conflict is flagged, not silently overwritten.'
    },
    {
      id: 'parallel',
      media: 'parallel',
      from: ['P1', 'P2'],
      title: 'Run several tasks at once',
      body: 'Hand parts of a job to child agents. By default each one works in its own git worktree, on its own branch, so two of them can edit the same file without getting in each other’s way. The main run decides when to bring each one’s work back and merge it.',
      detail: 'Five tools run the whole thing: spawn, await, pull, merge and cancel.'
    },
    {
      id: 'control',
      media: 'approval',
      from: ['M1', 'M3', 'E3'],
      title: 'You decide what it can do',
      body: 'Ask mode can read and search your code but can’t change anything. In Agent mode you choose which tools run on their own and which stop and ask you first. The built-in browser can be limited to the sites you allow.',
      detail: 'Switch between Ask and Agent in the middle of a run without losing the conversation.'
    },
    {
      id: 'tools',
      media: 'terminal',
      from: ['E1', 'E2', 'E3'],
      title: 'A real terminal, git and a browser',
      body: 'The agent works in a real shell that you share. It checks status, reads diffs, stages and commits with a message it writes, and opens pull requests through the GitHub CLI you’re already signed in to. When a change needs to be seen, it opens the page in its browser and clicks through it.',
      detail: 'You can watch the browser while it works and take over at any time.'
    }
  ],
  models: {
    from: ['A2', 'A3'],
    title: 'Use the model you want',
    body: 'Add an API key for any of these providers. Requests go straight from your computer to the provider, and nothing is metered or resold. Ollama runs models on your own machine and needs no key.',
    detail: 'Model lists come live from each provider where its API allows.'
  },
  jobs: {
    title: 'Four jobs to start with',
    body: 'Each one is a skill that ships with the app. Install it in a workspace and call it with a slash command.',
    ids: ['U1', 'U2', 'U3', 'U5']
  },
  trust: { title: 'Nothing goes through us', claims: ['F1', 'F2', 'F3', 'F4'] },
  integrations: {
    title: 'Works with the tools you already use',
    /* Every package named here is checked against the baked catalog. */
    named: ['github', 'linear', 'sentry', 'notion', 'slack'],
    body: (names: string[]) =>
      `${ext.counts.mcp} MCP servers come with the app, including ${names.slice(0, -1).join(', ')} and ${names.at(-1)}. The hosted ones sign in with OAuth, and any other MCP server works too.`
  },
  cta: { title: 'Try it on a repository you know', body: 'Free for Windows, macOS and Linux.' }
}

/* ------------------------------------------------------- the features page - */

export type FeatureSection = {
  id: string
  title: string
  intro?: string
  claims: string[]
}

/** /features, in reading order. Jobs and the tool list are rendered after these. */
export const FEATURE_SECTIONS: FeatureSection[] = [
  { id: 'repository', title: 'Working in your repository', claims: ['A1', 'E1', 'E2', 'E3', 'E4', 'E5'] },
  { id: 'control', title: 'Staying in control', claims: ['M1', 'M3', 'A4'] },
  {
    id: 'runs',
    title: 'Long runs',
    intro: 'A run can go on for hours, survive a restart, and be wound back to any point along the way.',
    claims: ['R1', 'R2', 'R3', 'R4']
  },
  {
    id: 'parallel',
    title: 'Parallel work',
    intro: 'Work that would queue up on one checkout runs side by side instead.',
    claims: ['P1', 'P2']
  },
  { id: 'search', title: 'Finding its way around your code', claims: ['I1', 'I2', 'I3'] },
  {
    id: 'memory',
    title: 'Memory and rules',
    intro: 'What one run learns is still there in the next one.',
    claims: ['S1', 'X3']
  },
  { id: 'models', title: 'Models and privacy', claims: ['A2', 'A3'] },
  { id: 'extending', title: 'Extending it', claims: ['X1', 'X2', 'X4', 'H2'] }
]

/* ------------------------------------------------------------------- jobs - */

/**
 * Work people hand to Agent V, as opposed to what it is built from.
 *
 * Every line traces to something that ships: a bundled skill's own SKILL.md, a
 * tool in the catalog, or a claim above. Two describe a skill stopping short of
 * an irreversible step (posting a review reply, resolving an incident). Those
 * are instructions in the skill itself, so they are worded as what the skill
 * does: tool approval can be off, and nothing in the runtime would block it.
 *
 * `packages` is checked against the catalog, so dropping Sentry from the
 * marketplace fails the build instead of leaving a job that promises it.
 */
export type Job = {
  id: string
  approved: boolean
  title: string
  /** One paragraph, for the home page. */
  summary: string
  /** The fuller version, for /features. */
  steps: string[]
  packages: string[]
}

export const JOBS: Job[] = [
  {
    id: 'U1',
    approved: true,
    title: 'Review a pull request',
    summary:
      'It reads the diff for bugs, regressions, security problems and missing tests, works through open review comments and drafts your replies. Posting, resolving and pushing are left to you.',
    steps: [
      'Reviews a diff for correctness, regressions, security and missing tests.',
      'Works through open review threads, making the change each one asks for and drafting the reply.',
      'Uses the built-in browser to check the change renders.',
      'Stops before sending anything. Posting, resolving and pushing are left to you.'
    ],
    packages: ['review-code', 'pr-review-reply', 'github']
  },
  {
    id: 'U2',
    approved: true,
    title: 'Upgrade a dependency',
    summary:
      'One package at a time, with your tests run after each step and the risky ones kept apart. It pulls documentation for the exact version you’re moving to.',
    steps: [
      'Moves one dependency at a time and runs the test suite after each.',
      'Keeps the risky upgrades separate from the rest.',
      'Pulls documentation and examples for the version you’re moving to.',
      'Can try several upgrades at once, each in its own worktree and branch.'
    ],
    packages: ['dependency-upgrade', 'context7']
  },
  {
    id: 'U3',
    approved: true,
    title: 'Fix a bug from an alert',
    summary:
      'It reads the issue and stack trace from Sentry or Linear, reproduces the bug, fixes it at the right layer and adds a test that fails without the fix. It opens the pull request and leaves the incident for you to close.',
    steps: [
      'Reads the issue, stack trace, release and number of affected users from your tracker.',
      'Reproduces it against the code and says what else it touches before changing anything.',
      'Patches the smallest layer that fixes it and adds a test that fails without the fix.',
      'Reruns a suspect test to tell a flaky one from a real failure, then fixes the flake at its source.',
      'Opens the pull request and leaves resolving or muting the incident to you.'
    ],
    packages: ['incident-triage', 'fix-bug', 'flake-hunter', 'sentry', 'linear']
  },
  {
    id: 'U5',
    approved: true,
    title: 'Learn a codebase you didn’t write',
    summary:
      'Ask how something works and it traces the path through the real code, using a local search index of the repository. It can also answer questions about public GitHub repositories without cloning them.',
    steps: [
      'Explains what the project does, how it runs and where to start reading.',
      'Traces how a path actually works, through its contracts, data flow and tests.',
      'Searches a local index of the repository before it guesses.',
      'Answers questions about any public GitHub repository without cloning it.'
    ],
    packages: ['repo-onboarding', 'explain-code', 'deepwiki']
  },
  {
    id: 'U6',
    approved: true,
    title: 'More that comes with it',
    summary: 'Features, tests, accessibility audits, API design and your own skills.',
    steps: [
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
    ]
  }
]

/* -------------------------------------------------------- the tool groups - */

/** Blurbs for the tool reference on /features. The grouping lives in tools.ts. */
export const TOOL_GROUP_BLURBS: Record<string, string> = {
  'Files & code': 'Read, search and edit the working tree.',
  'Code intelligence': 'Keyword and semantic search over a local index, language-server queries and test runs.',
  Terminal: 'A real shell in your workspace.',
  Git: 'Inspect, stage and commit without leaving the run.',
  GitHub: 'Open and review pull requests, and file issues.',
  Browser: 'Drive a real browser: open pages, click, type and read them back.',
  MCP: 'Find, pin and use tools, resources and prompts from connected MCP servers.',
  Skills: 'Load an installed skill or plugin into the run.',
  'Agent instances': 'Hand work to child agents on their own worktrees, then merge it back.',
  'Agent-written tools': 'Write a Node tool that runs in a separate utility process.',
  'Planning & memory': 'Track work, set goals, switch modes and keep notes between runs.'
}

/* ------------------------------------------------------- the allowlists - */

/**
 * Every tool the site may name. The tool reference on /features lists them
 * all, so a new one is a new public claim about what the agent can do.
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
  'memory_write',
  // teammates: approved on feat/agent-teammates, carried here so that branch
  // merges without tripping the gate. The agent creates and directs durable
  // identities; the high-risk gate (edits, deletes, terminal, commits,
  // patches, connected servers) holds for every teammate whatever its
  // autonomy is set to. The site may say the agent runs the team; it may not
  // imply the team runs unsupervised.
  'teammate_list',
  'teammate_create',
  'teammate_update',
  'teammate_delete',
  'teammate_assign_task',
  'teammate_task',
  // agent-written tools: a run writes a module that later executes as Node in
  // a utility process. Approved because the claim is bounded by an approval
  // card on every call whose file changed, and by Node builtins only. The site
  // may say the agent can write itself a tool; it may not imply that tool runs
  // without the user seeing its code.
  'build_tool'
]

/** Model providers the site may show a mark and a name for. */
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
  'create-teammate': 'Create teammate',
  // skills vendored from github.com/mattpocock/skills (MIT), published under
  // their author's name rather than ours; the catalog entry carries the
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
  // plugins
  devtools: 'Devtools',
  'electron-app': 'Electron app',
  quality: 'Quality',
  shipping: 'Shipping'
}

/* -------------------------------------------------------------- the gate - */

/**
 * Catches edits to this file that would otherwise go quiet: a claim id used
 * twice, a page pointing at a claim that does not exist, a job or a home-page
 * line naming a package the catalog no longer ships.
 */
function assertConsistent(): void {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const claim of CLAIMS) {
    if (ids.has(claim.id)) problems.push(`two claims share the id ${claim.id}`)
    ids.add(claim.id)
  }

  const referenced = [
    ...HOME.steps.claims,
    ...HOME.trust.claims,
    ...HOME.rows.flatMap((row) => row.from),
    ...HOME.models.from,
    ...FEATURE_SECTIONS.flatMap((section) => section.claims)
  ]
  for (const id of referenced) {
    if (!ids.has(id)) problems.push(`a page refers to claim ${id}, which is not defined`)
  }

  const jobIds = new Set<string>()
  for (const job of JOBS) {
    if (jobIds.has(job.id)) problems.push(`two jobs share the id ${job.id}`)
    jobIds.add(job.id)
    for (const id of job.packages) {
      if (APPROVED_PACKAGES[id] === undefined) {
        problems.push(`job ${job.id} names the package "${id}", which is not on the approved list`)
      } else if (!ext.list.some((p) => p.id === id)) {
        problems.push(`job ${job.id} names the package "${id}", which the catalog does not ship`)
      }
    }
  }
  for (const id of HOME.jobs.ids) {
    if (!jobIds.has(id)) problems.push(`the home page refers to job ${id}, which is not defined`)
  }

  for (const id of HOME.integrations.named) {
    if (!ext.list.some((p) => p.id === id && p.kind === 'mcp')) {
      problems.push(`the home page names the MCP server "${id}", which the catalog does not ship`)
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

/** Compares what the application ships against what has been approved. */
function assertApproved(): void {
  const problems: string[] = []

  const unapprovedTools = tools.filter((n) => !APPROVED_TOOLS.includes(n))
  if (unapprovedTools.length > 0) {
    problems.push(`tools not on the list: ${unapprovedTools.join(', ')}`)
  }

  for (const provider of providers.list) {
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

const isLive = (claim: Claim): boolean =>
  claim.approved && (claim.requires === undefined || tools.includes(claim.requires))

const byId = new Map(CLAIMS.map((claim) => [claim.id, claim]))

/** The live claims among `ids`, in the order given. Unapproved ones drop out. */
export function claims(ids: string[]): Claim[] {
  return ids.map((id) => byId.get(id)).filter((c): c is Claim => c !== undefined && isLive(c))
}

/** True when every claim a piece of copy restates is live. */
export function allLive(ids: string[]): boolean {
  return ids.every((id) => {
    const claim = byId.get(id)
    return claim !== undefined && isLive(claim)
  })
}

/** /features sections with at least one live claim, in reading order. */
export const LIVE_FEATURE_SECTIONS = FEATURE_SECTIONS.map((section) => ({
  ...section,
  live: claims(section.claims)
})).filter((section) => section.live.length > 0)

export const LIVE_JOBS: Job[] = JOBS.filter((job) => job.approved)

export const HOME_JOBS: Job[] = HOME.jobs.ids
  .map((id) => LIVE_JOBS.find((job) => job.id === id))
  .filter((job): job is Job => job !== undefined)

/** Display names for a job's packages, split into skills and integrations. */
export function jobPackages(job: Job): { skills: string[]; uses: string[] } {
  const found = job.packages
    .map((id) => ext.list.find((p) => p.id === id))
    .filter((p): p is (typeof ext.list)[number] => p !== undefined)
  return {
    skills: found.filter((p) => p.kind === 'skill').map((p) => p.name),
    uses: found.filter((p) => p.kind === 'mcp').map((p) => p.name)
  }
}
