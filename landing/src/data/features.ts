/**
 * Agent V features catalog — single source of truth for /features and homepage.
 *
 * To add a feature: append an entry (set enabled: true, pick categoryId + order).
 * To remove: set enabled: false (or delete the entry).
 * To improve: edit title/summary/body/anchors only — UI reads this file.
 *
 * Claims must stay grounded in repo evidence (README / real tools). Do not invent.
 */

export type ShowcaseKey = 'parallel' | 'modes' | 'browser';

export type FeatureCategory = {
  id: string;
  title: string;
  description: string;
  order: number;
};

export type Feature = {
  id: string;
  categoryId: string;
  title: string;
  summary: string;
  /** Longer detail for the full tour; optional */
  body?: string;
  /** Honest tool / path anchors shown as mono chips */
  anchors?: string[];
  /** Include in homepage feature bands */
  homepage?: boolean;
  /** Optional interactive showcase on homepage + full tour */
  showcase?: ShowcaseKey;
  order: number;
  enabled: boolean;
  /** Where this claim is evidenced */
  evidence: string;
};

export const featureCategories: FeatureCategory[] = [
  {
    id: 'workspace-agent',
    title: 'Agent on your checkout',
    description: 'Act on the real repository — terminal, files, git, and verification — not pasted snippets alone.',
    order: 10,
  },
  {
    id: 'parallel',
    title: 'Parallel instances',
    description: 'Fan work out to child agents on isolated git worktrees, then merge results back.',
    order: 20,
  },
  {
    id: 'modes',
    title: 'Ask · Plan · Agent',
    description: 'Match the phase of the work: read-only, plan artifacts, or full agency.',
    order: 30,
  },
  {
    id: 'browser',
    title: 'Built-in browser',
    description: 'Automate a real browser when the task needs the open web.',
    order: 40,
  },
  {
    id: 'models',
    title: 'Models you bring',
    description: 'Bring your own providers and models — including local ones.',
    order: 50,
  },
  {
    id: 'memory',
    title: 'Memory & retrieval',
    description: 'Keep workspace notes and search the codebase on-device.',
    order: 60,
  },
  {
    id: 'extend',
    title: 'Extend the agent',
    description: 'Skills, marketplace resources, and MCP servers pin extra tools into the catalog.',
    order: 70,
  },
  {
    id: 'control',
    title: 'Stay in control',
    description: 'Approve gated tools and answer structured mid-run questions.',
    order: 80,
  },
  {
    id: 'ship',
    title: 'Goals & GitHub',
    description: 'Track goals and work with pull requests and issues from the agent.',
    order: 90,
  },
  {
    id: 'local',
    title: 'Local loop',
    description: 'Dictate on-device, run tests, and query language services without leaving the workspace.',
    order: 100,
  },
  {
    id: 'platforms',
    title: 'Desktop everywhere',
    description: 'Native installers for Windows, macOS, and Linux.',
    order: 110,
  },
];

export const features: Feature[] = [
  {
    id: 'tool-catalog',
    categoryId: 'workspace-agent',
    title: 'Full tool catalog on your repo',
    summary: 'Terminal, file tools, git, typecheck/lint/test runners, notebooks, and LSP queries — on the checked-out tree.',
    body: 'The agent uses a built-in catalog that includes terminal, read/edit/search/glob/grep/codebase search, git status/diff/commit/apply patch, and verification runners.',
    anchors: ['terminal', 'read', 'edit', 'search', 'git_*', 'diagnostics', 'run_tests', 'lsp'],
    homepage: true,
    order: 10,
    enabled: true,
    evidence: 'README Features — agent tool catalog',
  },
  {
    id: 'parallel-worktrees',
    categoryId: 'parallel',
    title: 'Parallel agents on isolated worktrees',
    summary: 'Spawn child instances on their own branches, await them, then merge back into the parent.',
    body: 'Each child runs on its own git worktree branch so parallel work stays isolated until you merge.',
    anchors: ['spawn_agent_instance', 'await_agent_instance', 'pull_agent_instance', 'merge_agent_instance', 'cancel_agent_instance'],
    homepage: true,
    showcase: 'parallel',
    order: 10,
    enabled: true,
    evidence: 'README Features — agent runs and instance worktrees',
  },
  {
    id: 'ask-plan-agent',
    categoryId: 'modes',
    title: 'Ask, Plan, and Agent modes',
    summary: 'Read-only Q&A, plan.md artifacts, or full tools — switch with the UI, slash commands, or switch_mode.',
    anchors: ['ask', 'plan', 'create_plan', 'switch_mode'],
    homepage: true,
    showcase: 'modes',
    order: 10,
    enabled: true,
    evidence: 'Landing AgentModes + app mode policy',
  },
  {
    id: 'browser-automation',
    categoryId: 'browser',
    title: 'Browser automation',
    summary: 'Drive a real browser when the task needs pages, flows, or visual checks.',
    anchors: ['browser_*'],
    homepage: true,
    showcase: 'browser',
    order: 10,
    enabled: true,
    evidence: 'README Features — browser automation',
  },
  {
    id: 'byo-providers',
    categoryId: 'models',
    title: 'Multi-provider chat',
    summary: 'OpenAI, Anthropic, Gemini, Ollama, DeepSeek, Groq, OpenRouter, xAI, Mistral, custom OpenAI-compatible, and OpenCode.',
    anchors: ['ProviderId', 'model lists'],
    homepage: true,
    order: 10,
    enabled: true,
    evidence: 'README Features — multi-provider chat',
  },
  {
    id: 'thinking-effort',
    categoryId: 'models',
    title: 'Thinking effort',
    summary: 'Dial reasoning effort per model when the provider supports it.',
    anchors: ['ThinkingEffort'],
    order: 20,
    enabled: true,
    evidence: 'Landing MoreFeatures — ThinkingEffort',
  },
  {
    id: 'workspace-memory',
    categoryId: 'memory',
    title: 'Long-term workspace memory',
    summary: 'Notes under .vyotiq/memory/ are kept in the workspace and re-read on later runs.',
    anchors: ['memory_list', 'memory_read', 'memory_write', '.vyotiq/memory/'],
    homepage: true,
    order: 10,
    enabled: true,
    evidence: 'README Features — long-term workspace memory',
  },
  {
    id: 'code-index',
    categoryId: 'memory',
    title: 'Local code index',
    summary: 'On-device indexing for retrieval over the checkout.',
    anchors: ['codeIndex'],
    order: 20,
    enabled: true,
    evidence: 'Landing MoreFeatures — Local code index',
  },
  {
    id: 'mcp',
    categoryId: 'extend',
    title: 'MCP client',
    summary: 'Connect Model Context Protocol servers and pin their tools into the agent catalog.',
    anchors: ['mcp__server__tool'],
    homepage: true,
    order: 10,
    enabled: true,
    evidence: 'README Features — MCP client',
  },
  {
    id: 'skills-marketplace',
    categoryId: 'extend',
    title: 'Skills and marketplace',
    summary: 'Ship skills as marketplace resources, load them into a run, and use plugin rules alongside skill files.',
    anchors: ['SKILL.md', '/marketplace', '/create-skill'],
    order: 20,
    enabled: true,
    evidence: 'README Features — skills and marketplace',
  },
  {
    id: 'tool-approval',
    categoryId: 'control',
    title: 'Tool approval',
    summary: 'Gate sensitive tools behind Allow / Deny so you stay in control of what runs.',
    anchors: ['isToolGated', 'Allow', 'Deny'],
    homepage: true,
    order: 10,
    enabled: true,
    evidence: 'Landing MoreFeatures — tool approval',
  },
  {
    id: 'ask-question',
    categoryId: 'control',
    title: 'Structured questions mid-run',
    summary: 'The agent can pause for structured answers when it needs your decision.',
    anchors: ['ask_question'],
    order: 20,
    enabled: true,
    evidence: 'Landing MoreFeatures — ask_question',
  },
  {
    id: 'run-todos',
    categoryId: 'control',
    title: 'Run task list',
    summary: 'Publish and update a structured todo list for the current run so progress stays visible.',
    body: 'The agent keeps an in-run task list via todo_write — useful alongside plans and longer agent loops.',
    anchors: ['todo_write'],
    order: 30,
    enabled: true,
    evidence: 'TOOL_REGISTRY — todo_write',
  },
  {
    id: 'goals',
    categoryId: 'ship',
    title: 'Goals',
    summary: 'Create and update goals so longer work stays tracked.',
    anchors: ['create_goal', 'update_goal'],
    order: 10,
    enabled: true,
    evidence: 'Landing MoreFeatures — Goals',
  },
  {
    id: 'github-tools',
    categoryId: 'ship',
    title: 'GitHub pull requests and issues',
    summary: 'Work with PRs and issues through GitHub tools in the catalog.',
    anchors: ['github_*'],
    order: 20,
    enabled: true,
    evidence: 'README Features — GitHub tools',
  },
  {
    id: 'whisper-dictation',
    categoryId: 'local',
    title: 'Local Whisper dictation',
    summary: 'Voice dictation runs entirely on your machine — no audio leaves the app.',
    anchors: ['Whisper', 'transformers.js'],
    homepage: true,
    order: 10,
    enabled: true,
    evidence: 'README Features — local Whisper dictation',
  },
  {
    id: 'verify-loop',
    categoryId: 'local',
    title: 'Verify with diagnostics and tests',
    summary: 'Run diagnostics, tests, and language-server queries as part of the loop.',
    anchors: ['diagnostics', 'run_tests', 'lsp'],
    order: 20,
    enabled: true,
    evidence: 'README Features — typecheck/lint/test + LSP',
  },
  {
    id: 'notebooks',
    categoryId: 'local',
    title: 'Notebook editing',
    summary: 'Edit notebooks when the workspace needs them.',
    anchors: ['edit_notebook'],
    order: 30,
    enabled: true,
    evidence: 'README Features — notebook editing',
  },
  {
    id: 'desktop-platforms',
    categoryId: 'platforms',
    title: 'Windows, macOS, and Linux',
    summary: 'NSIS on Windows; dmg/zip on macOS; AppImage, deb, and rpm on Linux.',
    anchors: ['electron-builder.yml'],
    order: 10,
    enabled: true,
    evidence: 'README Platforms',
  },
];

function categoryOrder(categoryId: string): number {
  return featureCategories.find((c) => c.id === categoryId)?.order ?? 999;
}

export function categoryById(categoryId: string): FeatureCategory | undefined {
  return featureCategories.find((c) => c.id === categoryId);
}

/** Enabled features sorted by category order, then feature order. */
export function enabledFeatures(): Feature[] {
  return features
    .filter((f) => f.enabled)
    .sort(
      (a, b) =>
        categoryOrder(a.categoryId) - categoryOrder(b.categoryId) ||
        a.order - b.order ||
        a.title.localeCompare(b.title),
    );
}

/** Flat tour sequence — same order as enabledFeatures. */
export function tourFeatures(): Feature[] {
  return enabledFeatures();
}

export function enabledCategories(): FeatureCategory[] {
  const used = new Set(enabledFeatures().map((f) => f.categoryId));
  return featureCategories
    .filter((c) => used.has(c.id))
    .sort((a, b) => a.order - b.order);
}

export function featuresInCategory(categoryId: string): Feature[] {
  return enabledFeatures()
    .filter((f) => f.categoryId === categoryId)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

export function homepageFeatures(): Feature[] {
  return enabledFeatures().filter((f) => f.homepage);
}

export function secondaryStackGroups(): { id: string; title: string; anchor: string; chips: { id: string; label: string; detail: string }[] }[] {
  // Compact “Also in Agent V” groups for homepage — derived from non-showcase catalog entries
  const byCat = enabledCategories().map((cat) => {
    const items = featuresInCategory(cat.id).filter((f) => !f.showcase);
    if (items.length === 0) return null;
    const anchors = items.flatMap((f) => f.anchors ?? []).slice(0, 3);
    return {
      id: cat.id,
      title: cat.title,
      anchor: anchors.join(' · ') || cat.id,
      chips: items.map((f) => ({
        id: f.id,
        label: f.title,
        detail: (f.anchors && f.anchors[0]) || f.summary.slice(0, 48),
      })),
    };
  });
  return byCat.filter((g): g is NonNullable<typeof g> => g !== null);
}
