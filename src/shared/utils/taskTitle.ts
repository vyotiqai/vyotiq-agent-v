/** "Spawn instances for:" and its variants, which an instance brief can open with. */
export const SPAWN_PREFIX =
  /^(?:Spawn(?:ed)?(?:\s+multiple)?(?:\s+parallel)?\s+instances?\s+for\s*:\s*)/i

/** First-line plain text from a run goal (strip common markdown chrome). */
export function stripGoalMarkdown(goal: string): string {
  let s = goal.trim().split(/\r?\n/, 1)[0] ?? ''
  s = s.replace(/^#{1,6}\s+/, '')
  s = s.replace(/\*\*(.+?)\*\*/g, '$1')
  s = s.replace(/__(.+?)__/g, '$1')
  s = s.replace(/\*(.+?)\*/g, '$1')
  s = s.replace(/_(.+?)_/g, '$1')
  s = s.replace(/`([^`]+)`/g, '$1')
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
