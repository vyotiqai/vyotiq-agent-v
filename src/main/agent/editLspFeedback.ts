import { readFile } from 'fs/promises'
import { isAbsolute, relative, sep } from 'path'
import { lspErrorsAfterEdit, lspErrorsBeforeEdit, lspRunningFor, type StoredDiagnostic } from '../workspace/lspService'

/**
 * Errors an edit introduced, from a language server that is already running
 * for the file — the way Aider lints after each edit. The agent used to get a
 * reminder to run diagnostics and nothing else, so a broken import showed up
 * only if it remembered to ask. Nothing is started for this: with no server
 * running for the file's language, the edit result is unchanged.
 */

const LSP_FEEDBACK_TOOLS = new Set(['edit', 'str_replace'])

/** Errors listed in the result; the rest are counted. */
const MAX_LISTED_ERRORS = 8

/** That path, only when a language server for it is already running — else the edit is left alone. */
export function lspEditTarget(workspace: string, toolName: string, args: Record<string, unknown>): string | null {
  const rel = lspEditPath(workspace, toolName, args)
  return rel && lspRunningFor(workspace, rel) ? rel : null
}

/** The workspace-relative path (forward slashes) an edit targets, or null. */
export function lspEditPath(workspace: string, toolName: string, args: Record<string, unknown>): string | null {
  if (!LSP_FEEDBACK_TOOLS.has(toolName)) return null
  const raw = typeof args.path === 'string' ? args.path.trim() : ''
  if (!raw) return null
  const rel = isAbsolute(raw) ? relative(workspace, raw) : raw
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/').replace(/^\.\//, '')
}

/** Errors the server held for the file before the edit (null: none running, or it never looked). */
export function lspBaselineErrors(workspace: string, relPath: string): StoredDiagnostic[] | null {
  return lspErrorsBeforeEdit(workspace, relPath)
}

/** Errors after, minus those already there before (matched by message, each once). */
export function newErrorsSince(before: readonly StoredDiagnostic[] | null, after: readonly StoredDiagnostic[]): StoredDiagnostic[] {
  if (!before || before.length === 0) return [...after]
  const remaining = new Map<string, number>()
  for (const d of before) remaining.set(d.message, (remaining.get(d.message) ?? 0) + 1)
  const fresh: StoredDiagnostic[] = []
  for (const d of after) {
    const left = remaining.get(d.message) ?? 0
    if (left > 0) remaining.set(d.message, left - 1)
    else fresh.push(d)
  }
  return fresh
}

/** The note appended to the edit's result, or null when there is nothing to say. */
export function formatLspEditFeedback(
  server: string,
  relPath: string,
  errors: readonly StoredDiagnostic[],
  opts: { comparedWithBefore: boolean } = { comparedWithBefore: true }
): string | null {
  if (errors.length === 0) return null
  const listed = errors
    .slice(0, MAX_LISTED_ERRORS)
    .map((d) => `  ${d.line + 1}:${d.character + 1} ${d.message.replace(/\s+/g, ' ').trim()}`)
  const more = errors.length > MAX_LISTED_ERRORS ? [`  …and ${errors.length - MAX_LISTED_ERRORS} more`] : []
  // With no earlier report for the file, some of these may predate the edit.
  const kind = opts.comparedWithBefore ? 'new error' : 'error'
  const count = errors.length === 1 ? `1 ${kind}` : `${errors.length} ${kind}s`
  return [`[${server}: ${count} in ${relPath} after this edit]`, ...listed, ...more].join('\n')
}

/** Read the edited file and ask the running server; null when there is no server or nothing new. */
export async function lspEditFeedback(
  workspace: string,
  relPath: string,
  baseline: StoredDiagnostic[] | null
): Promise<string | null> {
  let content: string
  try {
    content = await readFile(`${workspace}${sep}${relPath.split('/').join(sep)}`, 'utf8')
  } catch {
    return null
  }
  const after = await lspErrorsAfterEdit(workspace, relPath, content)
  if (!after) return null
  return formatLspEditFeedback(after.server, relPath, newErrorsSince(baseline, after.errors), {
    comparedWithBefore: baseline !== null
  })
}
