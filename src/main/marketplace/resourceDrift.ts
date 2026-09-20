/**
 * Has a bundled text resource (MCP manifest, SKILL.md) drifted from its
 * installed copy in a way worth repairing?
 *
 * Bundled resources reach the installed store from two bundles that share one
 * userData dir: the dev checkout and the packaged app. A package built from an
 * autocrlf checkout carries CRLF where the dev checkout has LF, so a byte
 * compare made every boot "repair" the other bundle's line endings — the log
 * reported drift forever and the installed file flapped between the two. Line
 * endings carry no meaning for JSON or Markdown, so only the rest is compared.
 */
export function resourceTextDrifted(next: string, prev: string): boolean {
  if (next === prev) return false
  return normalizeLineEndings(next) !== normalizeLineEndings(prev)
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}
