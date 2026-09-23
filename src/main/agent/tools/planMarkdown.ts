/** Drop a leading `# H1` — the title is written back from the `title` argument. */
function stripLeadingH1(markdown: string): string {
  return markdown.replace(/^\s*#\s+[^\n]+\n*/, '').trim()
}

/** Extract the first-line `# H1` title from plan markdown, if present. */
function deriveTitleFromPlan(plan: string): string {
  const match = plan.match(/^\s*#\s+(.+?)[ \t]*\r?\n/)
  return match ? match[1]!.trim() : ''
}

/**
 * The plan.md `create_plan` writes for these arguments, or null when they
 * name no title and no plan. Shared with the rewind replay of done-when
 * checks, so a replayed plan is the very plan that was written.
 */
export function planMarkdownFromArgs(args: Record<string, unknown>): { title: string; markdown: string } | null {
  const plan = typeof args.plan === 'string' ? args.plan.trim() : ''
  const argTitle = typeof args.title === 'string' ? args.title.trim() : ''
  const title = argTitle || deriveTitleFromPlan(plan)
  if (!title || !plan) return null
  return { title, markdown: `# ${title}\n\n${stripLeadingH1(plan)}\n` }
}
