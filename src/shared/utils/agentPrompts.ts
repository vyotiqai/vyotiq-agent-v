/**
 * Briefs the app writes for the agent: /init and /review, and Changes'
 * "Review these changes". Shared, so a menu item and a slash command send the
 * same words.
 */

/**
 * /init: draft the instruction file Agent V (and Codex, Cursor, Claude Code)
 * reads first. It is written as an ordinary change, so it lands in Changes
 * to keep or undo like any other edit.
 */
export function initMessage(extra: string): string {
  return [
    'Write an AGENTS.md at the workspace root for coding agents working in this repository.',
    '',
    'Find out before writing anything:',
    '- How to install dependencies, build, run, test (all tests and one test), typecheck, lint and format: read the package manifest scripts, Makefile, CI workflows and README. Only list commands that exist here.',
    '- The layout: the top-level folders and what lives in each, the entry points, and where tests go.',
    '- Conventions the code actually follows (naming, imports, error handling, formatting gate), and anything a newcomer would get wrong.',
    '- Instruction files already here (AGENTS.md, CLAUDE.md, .cursor/rules, .github/copilot-instructions.md, .vyotiq/rules). If AGENTS.md exists, improve it in place instead of replacing it, and keep what is still true.',
    '',
    'Then write it: short sections (Commands, Layout, Conventions, Gotchas), bullets over prose, real commands in code spans, no generic advice that would fit any repository, and nothing you did not verify. Aim for under 120 lines.',
    ...(extra ? ['', `Also: ${extra}`] : [])
  ].join('\n')
}

/** What `/review` looks at: uncommitted changes (default), the branch, or this task's changes. */
export type ReviewScope = 'uncommitted' | 'branch' | 'task'

export function parseReviewScope(text: string): { scope: ReviewScope; focus: string } {
  const match = /^(uncommitted|changes|working|branch|task|this task)\b\s*/i.exec(text)
  if (!match) return { scope: 'uncommitted', focus: text }
  const word = match[1].toLowerCase()
  const scope: ReviewScope = word === 'branch' ? 'branch' : word === 'task' || word === 'this task' ? 'task' : 'uncommitted'
  return { scope, focus: text.slice(match[0].length).trim() }
}

const REVIEW_SCOPE_TEXT: Record<ReviewScope, string> = {
  uncommitted: 'the uncommitted changes in this workspace (git_status, then git_diff, staged and unstaged)',
  branch:
    "every change on this branch since it left the default branch (find the base with `git merge-base HEAD origin/HEAD`, or main/master, then `git diff <base>...HEAD`), plus anything uncommitted",
  task: 'the changes this task has made so far (the files you wrote, edited, moved or deleted in this conversation; read each one as it is now)'
}

/**
 * /review: a read-only code review, in the shape of the bundled code-review
 * skill (summary, severity-ordered findings, questions only when blocked).
 */
export function reviewMessage(text: string): string {
  const { scope, focus } = parseReviewScope(text)
  return [
    `Review ${REVIEW_SCOPE_TEXT[scope]}. This is a review: do not edit, commit or revert anything.`,
    '',
    'Read enough of the surrounding code to judge each change, not just the diff lines. Look for:',
    '- Bugs and regressions: wrong logic, unhandled cases, broken callers, race conditions, resource leaks.',
    '- Security and data handling: injection, secrets, unsafe paths, missing validation at a boundary.',
    '- Missing or now-wrong tests, and docs that no longer match.',
    '',
    'Answer as:',
    '1. Summary: what changed, and the riskiest part, in two or three sentences.',
    '2. Findings, most severe first. Each one: severity (high, medium, low), file:line, what goes wrong and when, and the concrete fix.',
    '3. Questions, only if something blocks a verdict.',
    'If nothing is wrong, say so plainly instead of inventing findings.',
    ...(focus ? ['', `Focus: ${focus}`] : [])
  ].join('\n')
}
