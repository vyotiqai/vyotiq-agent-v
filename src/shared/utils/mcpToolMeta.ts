export type McpToolKind = 'file' | 'browse' | 'search' | 'command' | 'other'

/** Classify an MCP tool by name for grouping and labels. */
export function mcpToolKind(toolName: string): McpToolKind {
  const n = toolName.toLowerCase()
  if (
    n.includes('read_text') ||
    n.includes('read_file') ||
    /^read_/.test(n) ||
    /^get_.*file/.test(n)
  ) {
    return 'file'
  }
  if (
    n.includes('directory') ||
    n.includes('tree') ||
    n.includes('allowed_director') ||
    /^list_/.test(n) ||
    n.includes('browse')
  ) {
    return 'browse'
  }
  if (/^(search|grep|find|glob)/.test(n) || n.includes('_search')) {
    return 'search'
  }
  if (/^(run|exec|shell|terminal)/.test(n)) {
    return 'command'
  }
  return 'other'
}

/** Turn snake_case tool names into readable titles. */
export function humanizeSnakeCase(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

/** Past-tense label for a homogeneous MCP tool group or nested row verb. */
export function mcpDoneLabel(toolName: string): string {
  const n = toolName.toLowerCase()
  if (n.includes('read') && (n.includes('file') || n.includes('text'))) return 'Read file'
  if (n.includes('allowed_director')) return 'Listed directories'
  if (n.includes('directory') || n.includes('tree')) return 'Browsed directories'
  if (n.startsWith('list_')) return 'Listed'
  if (/^(search|grep|find|glob)/.test(n) || n.includes('_search')) return 'Searched'
  if (/^(run|exec|shell)/.test(n)) return 'Ran command'
  return humanizeSnakeCase(toolName)
}

/** Present-tense label while an MCP tool is running. */
export function mcpRunningLabel(toolName: string): string {
  const n = toolName.toLowerCase()
  if (n.includes('read') && (n.includes('file') || n.includes('text'))) return 'Reading file'
  if (n.includes('allowed_director')) return 'Listing directories'
  if (n.includes('directory') || n.includes('tree')) return 'Browsing directories'
  if (n.startsWith('list_')) return 'Listing'
  if (/^(search|grep|find|glob)/.test(n) || n.includes('_search')) return 'Searching'
  if (/^(run|exec|shell)/.test(n)) return 'Running command'
  return `Calling ${humanizeSnakeCase(toolName)}`
}
