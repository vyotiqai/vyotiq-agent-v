/**
 * What a view can show live and what its buttons can do in the app — the
 * closed vocabularies behind a `live` block and a `do`. Both are listed here
 * once, with the line a model reads about each, so the tool description, the
 * pinned view and the renderer never disagree about what exists.
 *
 * A live block names a source; the app fills it from its own reads (git, the
 * pull request, the task's edits, Usage) and keeps it current. Nothing in it
 * is typed by the model, so a live number is never made up.
 */

export const VIEW_SOURCE_IDS = ['git.changes', 'git.branch', 'git.commits', 'pr.checks', 'task.changes', 'usage.spend', 'usage.days'] as const
export type ViewSourceId = (typeof VIEW_SOURCE_IDS)[number]

export const VIEW_SOURCES: Record<ViewSourceId, string> = {
  'git.changes': 'uncommitted files with +/− lines; a click opens the diff',
  'git.branch': 'branch, commits ahead/behind, changed files and lines',
  'git.commits': "recent commits; a click opens the commit's files",
  'pr.checks': "CI checks on this branch's pull request",
  'task.changes': 'files this task changed, with +/− lines',
  'usage.spend': "this workspace's spend today, over 7 days and over 30 days",
  'usage.days': 'daily spend over the last 14 days, as a chart'
}

/** Sources that read one task's own record; a view pinned to Home has no task to read. */
export const TASK_VIEW_SOURCES: ReadonlySet<ViewSourceId> = new Set(['task.changes'])

export const VIEW_DO_ACTIONS = ['open', 'diff', 'stage', 'unstage', 'commit', 'run', 'panel', 'link'] as const
export type ViewDoAction = (typeof VIEW_DO_ACTIONS)[number]

/** Inspector tabs a `panel` action may open. */
export const VIEW_PANELS = ['changes', 'terminal', 'files', 'browser', 'pr', 'plan'] as const
export type ViewPanel = (typeof VIEW_PANELS)[number]

export const VIEW_DO: Record<ViewDoAction, string> = {
  open: '{"action":"open","path"} opens a workspace file',
  diff: '{"action":"diff","path"} opens its diff',
  stage: '{"action":"stage","paths":[…]} stages files',
  unstage: '{"action":"unstage","paths":[…]} unstages them',
  commit: `{"action":"commit","sha"} opens that commit's files`,
  run: '{"action":"run","command"} runs a command in the user\'s terminal once they confirm',
  panel: `{"action":"panel","panel"} opens a tab: ${VIEW_PANELS.join(', ')}`,
  link: '{"action":"link","url"} opens an https page'
}

/** One line per source, for a prompt. */
export function describeViewSources(ids: readonly ViewSourceId[] = VIEW_SOURCE_IDS): string {
  return ids.map((id) => `${id} — ${VIEW_SOURCES[id]}`).join('; ')
}

/** One line per action, for a prompt. */
export function describeViewDo(actions: readonly ViewDoAction[] = VIEW_DO_ACTIONS): string {
  return actions.map((a) => VIEW_DO[a]).join('; ')
}

/**
 * What a pinned view's buttons can do. On Home it has no task beside it: no terminal
 * of its own to run a command in, and no inspector to open a tab of. Nor stage or
 * unstage: their file list was written when the view was, so "Stage all" would
 * later stage only what was changed then.
 */
export const SCREEN_DO_ACTIONS: readonly ViewDoAction[] = ['open', 'diff', 'link']
