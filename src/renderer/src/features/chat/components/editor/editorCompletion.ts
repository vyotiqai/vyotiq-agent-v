import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource
} from '@codemirror/autocomplete'

/** One completion from the language server, as the IPC returns it. */
export type LspCompletionItem = { label: string; detail: string | null }

/**
 * Fetch completions at a 0-based LSP position in `content` (the editor's text
 * now); null when there is no server or it failed.
 */
export type LspCompletionFetch = (
  line: number,
  character: number,
  content: string
) => Promise<readonly LspCompletionItem[] | null>

const WORD_CHAR = /[\p{L}\p{N}_$]/u
const WORD_GLOBAL = /[\p{L}\p{N}_$]+/gu
const WORD_BEFORE = /[\p{L}\p{N}_$]+$/u
/** What a result stays valid for while the person keeps typing the same word. */
const WORD_VALID_FOR = /^[\p{L}\p{N}_$]*$/u

/** Words shorter than this are not worth offering. */
const MIN_WORD_LENGTH = 3
/** Typed characters before the popup opens on its own (Ctrl Space opens it at any length). */
const MIN_PREFIX = 2
/** A huge file is scanned in a window around the caret, not whole. */
const SCAN_WINDOW = 200_000
const MAX_WORD_OPTIONS = 300
/** A slow server must not hold the word list back. */
const LSP_WAIT_MS = 1_500

/**
 * The distinct words in `text`, nearest the caret first, leaving out the word
 * the caret is in (it is what is being typed, not a suggestion) unless it
 * also appears elsewhere. Pure, for the word source and its test.
 */
export function collectDocumentWords(
  text: string,
  caret: number,
  options: { minLength?: number; limit?: number; window?: number } = {}
): string[] {
  const minLength = options.minLength ?? MIN_WORD_LENGTH
  const limit = options.limit ?? MAX_WORD_OPTIONS
  const half = Math.floor((options.window ?? SCAN_WINDOW) / 2)
  const from = Math.max(0, caret - half)
  const slice = text.slice(from, Math.min(text.length, caret + half))
  // The word under the caret, both sides of it.
  let start = caret
  while (start > 0 && WORD_CHAR.test(text[start - 1]!)) start--
  let end = caret
  while (end < text.length && WORD_CHAR.test(text[end]!)) end++

  const distance = new Map<string, number>()
  for (const match of slice.matchAll(WORD_GLOBAL)) {
    const word = match[0]
    if (word.length < minLength || /^\d/.test(word)) continue
    const at = from + (match.index ?? 0)
    if (at === start && at + word.length === end) continue
    const d = Math.abs(at - caret)
    const seen = distance.get(word)
    if (seen === undefined || d < seen) distance.set(word, d)
  }
  return [...distance.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, limit)
    .map(([word]) => word)
}

function wordOptions(context: CompletionContext, prefix: string): Completion[] {
  const text = context.state.doc.toString()
  // No type and no detail, so a language source offering the same name
  // (a JS local, a CSS property) collapses into one row.
  return collectDocumentWords(text, context.pos)
    .filter((word) => word !== prefix)
    .map((label) => ({ label }))
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

/**
 * The editor's own completion source: the language server's items when one
 * answers, then words from the open document that it did not already offer.
 * `fetchLsp` is read on every call so a server that appears later is used.
 */
export function editorCompletionSource(getFetchLsp: () => LspCompletionFetch | null | undefined): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const word = context.matchBefore(WORD_BEFORE)
    const prefix = word ? word.text : ''
    const memberAccess = !word && /(?:\.|::|->)$/.test(context.state.sliceDoc(Math.max(0, context.pos - 2), context.pos))
    if (!context.explicit && !memberAccess && prefix.length < MIN_PREFIX) return null
    const from = word ? word.from : context.pos

    const fetchLsp = getFetchLsp()
    let lspItems: readonly LspCompletionItem[] | null = null
    if (fetchLsp) {
      const line = context.state.doc.lineAt(context.pos)
      lspItems = await withTimeout(
        fetchLsp(line.number - 1, context.pos - line.from, context.state.doc.toString()),
        LSP_WAIT_MS
      )
      if (context.aborted) return null
    }

    const options: Completion[] = []
    const offered = new Set<string>()
    for (const item of lspItems ?? []) {
      const label = item.label.trim()
      if (!label || offered.has(label)) continue
      offered.add(label)
      options.push({ label, ...(item.detail ? { detail: item.detail } : {}), boost: 1 })
    }
    // After a `.` the words of the file are noise; the server is the only source.
    if (!memberAccess) {
      for (const option of wordOptions(context, prefix)) {
        if (offered.has(option.label)) continue
        offered.add(option.label)
        options.push(option)
      }
    }
    if (options.length === 0) return null
    return { from, options, validFor: WORD_VALID_FOR }
  }
}
