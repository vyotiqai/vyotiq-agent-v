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

/** A goal that is nothing but a URL: `scheme://…`. A `://` mid-sentence is not one. */
const URL_GOAL = /^[a-z][a-z0-9+.-]*:\/\/\S*$/i

/** How much of a URL to keep — short enough to scan, long enough to recognise. */
const URL_TITLE_MAX = 48

/**
 * What to call a task whose goal is a URL. A pasted `vyotiq://run/<id>?ws=…`
 * points at another run, so the title names the target instead of reproducing
 * a query string: scheme + host + path segments, query and fragment dropped.
 * A URL with no path keeps its host; anything unparseable keeps its own text.
 */
export function taskTitleFromUrl(url: string): string {
  let parsed: URL | null = null
  try {
    parsed = new URL(url)
  } catch {
    parsed = null
  }
  const host = parsed?.host.replace(/^www\./i, '') ?? ''
  const segments = (parsed?.pathname ?? '')
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
  if (!host) return clipTitle(url)
  return clipTitle([host, ...segments].join('/'))
}

function clipTitle(title: string): string {
  if (title.length <= URL_TITLE_MAX) return title
  return `${title.slice(0, Math.max(1, URL_TITLE_MAX - 1)).trimEnd()}…`
}

/**
 * What a task is called, from its goal: the goal's first line without its
 * markdown. The navigator names a task by this, and so does everything that
 * tells you about one — a notification, a toast.
 *
 * A goal that is only a URL is a link, not an instruction — pasting a
 * `vyotiq://` deep link into the composer used to title the run with 80 chars
 * of percent-encoded path. It is named by its target instead, so the task is
 * still identifiable, never an empty title or a bare scheme.
 */
export function taskTitleFromGoal(goal: string): string {
  if (goal.trim().toLowerCase() === PLACEHOLDER_GOAL) return UNTITLED_TASK
  const text = goal.trim()
  if (URL_GOAL.test(text)) return taskTitleFromUrl(text)
  let plain = stripGoalMarkdown(goal)
  plain = plain.replace(SPAWN_PREFIX, '').trim()
  return plain || goal.trim()
}
