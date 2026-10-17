/**
 * Names from the open workspace for a transcriber to listen for. Said aloud,
 * `takeController` or `VoiceSection` come back as English ("take controller",
 * "voice section"); OpenAI's gpt-transcribe takes a list of literal terms to
 * expect, as hints it will not force into the words.
 *
 * Only names that could not be plain English go in: camelCase and PascalCase
 * file and folder names. The API rejects a request with a keyword holding
 * `<`, `>` or a line break, and fails near a thousand of them; these are
 * letters and digits only, and far fewer.
 */

export const MAX_DICTATION_KEYWORDS = 150

const NAME = /^[A-Za-z][A-Za-z0-9]{3,39}$/
/** A lower-to-upper step, or an acronym running into a word: `takeController`, `IPCHandler`. */
const MIXED_CASE = /[a-z][A-Z]|[A-Z]{2}[a-z]/

const byFiles = new WeakMap<readonly string[], string[]>()

/** A path segment without its extensions: `takeController.test.ts` → `takeController`. */
function stem(segment: string): string {
  const dot = segment.indexOf('.', 1)
  return dot > 0 ? segment.slice(0, dot) : segment
}

/** The names most used across the tree first — a folder of twenty files outranks one file. */
export function dictationKeywordsFromFiles(files: readonly string[]): string[] {
  const cached = byFiles.get(files)
  if (cached) return cached
  const counts = new Map<string, number>()
  for (const rel of files) {
    for (const segment of rel.split('/')) {
      const name = stem(segment)
      if (!NAME.test(name) || !MIXED_CASE.test(name)) continue
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  const out = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DICTATION_KEYWORDS)
    .map(([name]) => name)
  byFiles.set(files, out)
  return out
}

/**
 * Words voice mode's own talk is full of, for a listener that takes hints
 * (Deepgram Flux, AssemblyAI, OpenAI Realtime): the app's name and the git
 * words its approvals turn on. "And tomato." was heard 18 s before "I said
 * commit." (2026-10-17, a listener that takes none).
 */
export const VOICE_APP_TERMS = ['Agent V', 'commit', 'push', 'pull request', 'branch', 'worktree', 'workspace', 'diff', 'repo'] as const

/** A top-level folder's name as said: letters, digits, `-` and `_`, not hidden, not a build folder. */
const FOLDER = /^[A-Za-z][A-Za-z0-9_-]{2,39}$/
const NOT_SAID = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'tmp', 'temp', 'vendor', 'src', 'lib', 'bin', 'obj'])

/**
 * Voice mode's hints: the app's words, the workspace's top-level folders
 * (`aether`, `aether-ci`: all lower case, so the names above leave them out),
 * then its mixed-case names, `max` in all.
 */
export function voiceKeyterms(files: readonly string[], max = 100): string[] {
  const folders = new Map<string, number>()
  for (const rel of files) {
    const slash = rel.indexOf('/')
    if (slash <= 0) continue
    const top = rel.slice(0, slash)
    if (!FOLDER.test(top) || NOT_SAID.has(top.toLowerCase())) continue
    folders.set(top, (folders.get(top) ?? 0) + 1)
  }
  const byUse = [...folders.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
  const out: string[] = []
  const seen = new Set<string>()
  for (const term of [...VOICE_APP_TERMS, ...byUse, ...dictationKeywordsFromFiles(files)]) {
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(term)
    if (out.length >= max) break
  }
  return out
}
