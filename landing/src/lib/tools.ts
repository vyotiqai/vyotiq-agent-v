import { app } from './site'

/**
 * Groups the real tool names into the categories the site displays.
 *
 * The names come from TOOL_REGISTRY via bake-app-data.mjs. Membership is by
 * prefix or explicit list, and anything unmatched falls into "Other" rather
 * than being silently dropped — the totals are asserted below, so adding a tool
 * to the app can never leave the website quietly under-reporting the catalog.
 */

export type ToolGroup = { title: string; blurb: string; names: string[] }

const EXPLICIT: { title: string; blurb: string; match: (n: string) => boolean }[] = [
  {
    title: 'Files & code',
    blurb: 'Read, search and edit the working tree directly.',
    match: (n) =>
      [
        'read',
        'edit',
        'str_replace',
        'delete',
        'search',
        'glob',
        'grep',
        'list_dir',
        'edit_notebook'
      ].includes(n)
  },
  {
    title: 'Code intelligence',
    blurb: 'Keyword and semantic search over a locally built index, plus language-server queries.',
    match: (n) => ['codebase_search', 'concept_search', 'lsp', 'diagnostics', 'run_tests'].includes(n)
  },
  {
    title: 'Terminal',
    blurb: 'A real shell in your workspace.',
    match: (n) => n === 'terminal'
  },
  {
    title: 'Git',
    blurb: 'Inspect, stage and commit without leaving the run.',
    match: (n) => n.startsWith('git_')
  },
  {
    title: 'GitHub',
    blurb: 'Open and review pull requests, file issues.',
    match: (n) => n.startsWith('github_')
  },
  {
    title: 'Browser',
    blurb: 'Drive a real browser — navigate, click, type, read the page back.',
    match: (n) => n.startsWith('browser_')
  },
  {
    title: 'MCP',
    blurb: 'Discover and pin tools, resources and prompts from connected MCP servers.',
    match: (n) => n.startsWith('mcp_') || n.endsWith('_mcp_tools')
  },
  {
    title: 'Agent instances',
    blurb: 'Fan work out to child runs on their own git worktree, then merge back.',
    match: (n) => n.endsWith('_agent_instance')
  },
  {
    title: 'Planning & memory',
    blurb: 'Track work, set goals, switch modes and keep notes across runs.',
    match: (n) =>
      n.startsWith('memory_') ||
      ['todo_write', 'create_plan', 'create_goal', 'update_goal', 'ask_question', 'switch_mode'].includes(n)
  }
]

const names: string[] = app.tools.names

export const TOOL_GROUPS: ToolGroup[] = (() => {
  const claimed = new Set<string>()
  const groups: ToolGroup[] = []

  for (const spec of EXPLICIT) {
    const matched = names.filter((n) => !claimed.has(n) && spec.match(n))
    matched.forEach((n) => claimed.add(n))
    if (matched.length > 0) groups.push({ title: spec.title, blurb: spec.blurb, names: matched })
  }

  const rest = names.filter((n) => !claimed.has(n))
  if (rest.length > 0) {
    groups.push({ title: 'Other', blurb: 'Additional tools in the catalog.', names: rest })
  }

  const grouped = groups.reduce((sum, g) => sum + g.names.length, 0)
  if (grouped !== names.length) {
    throw new Error(`tool grouping lost entries: grouped ${grouped} of ${names.length}`)
  }

  return groups
})()

export const TOOL_TOTAL = names.length
