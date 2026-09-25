import { app } from './site'
import { TOOL_GROUP_BLURBS } from './showcase'

/**
 * Groups the baked tool names into the categories the site displays. Anything
 * unmatched lands in "Other", and the total is asserted, so a new tool in the
 * app is never silently dropped from the website.
 *
 * Only the grouping lives here. Each group's blurb is approved copy and comes
 * from showcase.ts, which also decides whether a tool may be named at all —
 * importing it is what makes an unapproved tool fail the build.
 */

export type ToolGroup = { title: string; blurb: string; names: string[] }

const EXPLICIT: { title: string; match: (n: string) => boolean }[] = [
  {
    title: 'Files & code',
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
    match: (n) => ['codebase_search', 'concept_search', 'lsp', 'diagnostics', 'run_tests'].includes(n)
  },
  {
    title: 'Terminal',
    match: (n) => n === 'terminal'
  },
  {
    title: 'Git',
    match: (n) => n.startsWith('git_')
  },
  {
    title: 'GitHub',
    match: (n) => n.startsWith('github_')
  },
  {
    title: 'Browser',
    match: (n) => n.startsWith('browser_')
  },
  {
    title: 'MCP',
    match: (n) => n.startsWith('mcp_') || n.endsWith('_mcp_tools')
  },
  {
    title: 'Skills',
    match: (n) => n === 'Skill'
  },
  {
    title: 'Agent instances',
    match: (n) => n.endsWith('_agent_instance')
  },
  {
    title: 'Agent-written tools',
    match: (n) => n === 'build_tool'
  },
  {
    title: 'Planning & memory',
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
    if (matched.length === 0) continue
    matched.forEach((n) => claimed.add(n))

    const blurb = TOOL_GROUP_BLURBS[spec.title]
    if (blurb === undefined) {
      throw new Error(`no approved blurb for tool group "${spec.title}" — add one in showcase.ts`)
    }
    groups.push({ title: spec.title, blurb, names: matched })
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
