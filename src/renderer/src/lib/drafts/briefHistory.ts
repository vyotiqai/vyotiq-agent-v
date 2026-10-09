/**
 * Briefs you sent from New task, newest first, across tasks and workspaces:
 * ↑ in an empty brief brings the last one back, ↑ again the one before, ↓
 * goes the other way and past the newest clears the field. Shell history,
 * for briefs. Kept in this window's storage; losing it loses nothing else.
 */

const STORAGE_KEY = 'vyotiq.briefHistory'
export const BRIEF_HISTORY_MAX = 50
/** A brief longer than this is not kept: history is for re-sending, not archiving. */
const BRIEF_MAX_CHARS = 20_000

export function readBriefHistory(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** Remember a sent brief: newest first, once. */
export function recordBrief(text: string): void {
  const brief = text.trim()
  if (!brief || brief.length > BRIEF_MAX_CHARS) return
  const next = [brief, ...readBriefHistory().filter((item) => item !== brief)].slice(0, BRIEF_HISTORY_MAX)
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage full or blocked: history is a convenience.
  }
}

export type BriefHistoryCursor = {
  /** The next older brief, or null when ↑ should do what it does anyway. */
  older: (current: string) => string | null
  /** The next newer brief, '' past the newest, or null when ↓ is not walking history. */
  newer: (current: string) => string | null
  /** Back to the start: after a send, or once the field is edited. */
  reset: () => void
}

/**
 * Walks the history only from an empty field, or while the field still holds
 * the brief it last brought back: once you edit it, ↑ and ↓ move the caret again.
 */
export function createBriefHistoryCursor(read: () => string[] = readBriefHistory): BriefHistoryCursor {
  let index = -1
  let shown: string | null = null
  const walking = (current: string): boolean =>
    shown === null ? current.trim() === '' : current.trim() === shown.trim()
  return {
    older(current) {
      if (!walking(current)) {
        index = -1
        shown = null
        return null
      }
      const items = read()
      if (index + 1 >= items.length) return null
      index += 1
      shown = items[index]!
      return shown
    },
    newer(current) {
      if (index < 0 || !walking(current)) return null
      index -= 1
      shown = index >= 0 ? read()[index] ?? null : null
      return shown ?? ''
    },
    reset() {
      index = -1
      shown = null
    }
  }
}
