/** Cross-platform basename without Node path dependency in renderer bundles. */
export function basename(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}
