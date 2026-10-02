/** "Spawn instances for:" and its variants, which an instance brief can open with. */
export const SPAWN_PREFIX =
  /^(?:Spawn(?:ed)?(?:\s+multiple)?(?:\s+parallel)?\s+instances?\s+for\s*:\s*)/i

/** A fence opener or closer: code starts or ends here, no title does. */
const FENCE_LINE = /^\s{0,3}(?:`{3,}|~{3,})/

/**
 * First-line plain text from a run goal (strip common markdown chrome).
 *
 * Only marks markdown would draw are dropped. A single `*` or `_` is
 * emphasis only where it opens on a letter or digit at a word's edge: an
 * identifier (`max_retry_count`) and a glob (`src/*.ts and lib/*.js`) keep
 * theirs — the old rule read "Rename max_retry_count" as "Rename maxretrycount".
 * Code spans are set aside first, so nothing inside one is touched.
 */
export function stripGoalMarkdown(goal: string): string {
  let s = goal.trim().split(/\r?\n/).find((line) => line.trim() && !FENCE_LINE.test(line)) ?? ''
  const code: string[] = []
  // Held aside under a private-use mark no goal contains.
  s = s.replace(/`([^`]+)`/g, (_m, span: string) => `${code.push(span) - 1}`)
  s = s.replace(/^#{1,6}\s+/, '')
  s = s.replace(/\[\[([^[\]]+)\]\]/g, '$1')
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
  s = s.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
  s = s.replace(/(?<![\p{L}\p{N}*])\*(?=[\p{L}\p{N}])(.+?)(?<=\S)\*(?![\p{L}\p{N}*])/gu, '$1')
  s = s.replace(/(?<![\p{L}\p{N}_])_(?=[\p{L}\p{N}])(.+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, '$1')
  s = s.replace(/(\d+)/g, (_m, i: string) => code[Number(i)] ?? '')
  s = s.replace(/^>\s+/, '')
  s = s.replace(/^[-*+]\s*\[[ xX]\]\s+/, '')
  s = s.replace(/^[-*+]\s+/, '')
  s = s.replace(/^\d+\.\s+/, '')
  return s.replace(/\s+/g, ' ').trim()
}

/** The goal stored when an instruction had no words of its own (runGoalFromUserText). */
export const PLACEHOLDER_GOAL = 'chat'
export const UNTITLED_TASK = 'Untitled task'

/**
 * What a task is called, from its goal: the goal's first line without its
 * markdown. The navigator names a task by this, and so does everything that
 * tells you about one — a notification, a toast.
 */
export function taskTitleFromGoal(goal: string): string {
  if (goal.trim().toLowerCase() === PLACEHOLDER_GOAL) return UNTITLED_TASK
  let plain = stripGoalMarkdown(goal)
  plain = plain.replace(SPAWN_PREFIX, '').trim()
  return plain || goal.trim()
}
