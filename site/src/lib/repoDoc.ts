/** Pulls the "**Effective date:** …" line out of a repository document's raw text. */
export function effectiveDate(raw: string): string | undefined {
  return raw.match(/\*\*Effective date:\*\*\s*(.+)/)?.[1].trim()
}
