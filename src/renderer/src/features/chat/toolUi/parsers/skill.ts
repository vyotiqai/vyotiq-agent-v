import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'

export type SkillParsed = {
  name: string
  relPath: string
  kind: 'markdown' | 'directory' | 'message'
  dirPath: string
  files: string[]
  content: string
  message: string
}

/** Parse Skill tool content: skill markdown, bundled-file dumps, or directory listings. */
export function parseSkillData(tool: UiToolRow): SkillParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const content = (tool.content ?? '').trim()
  const parsed: SkillParsed = {
    name: typeof args?.name === 'string' ? args.name.trim() : '',
    relPath: typeof args?.path === 'string' ? args.path.trim() : '',
    kind: 'message',
    dirPath: '',
    files: [],
    content: '',
    message: content
  }
  if (!content) return parsed

  const dirMatch = content.match(/^Directory:\s*(.+?)\r?\n([\s\S]*)$/)
  if (dirMatch) {
    const files = dirMatch[2]!
      .split(/\r?\n/)
      .map((line) => /^-\s+(.+)$/.exec(line.trim())?.[1]?.trim() ?? '')
      .filter((file) => file.length > 0)
    return {
      ...parsed,
      kind: 'directory',
      dirPath: dirMatch[1]!,
      files,
      message: files.length === 0 ? content : ''
    }
  }

  const headerLine = content.split(/\r?\n/, 1)[0] ?? ''
  // `# Skill file: <name> / <relPath>` — names may contain '/', so split on the last ' / '.
  const fileHeader = /^# Skill file:\s*(.+)$/.exec(headerLine)
  if (fileHeader) {
    const target = fileHeader[1]!.trim()
    const sep = target.lastIndexOf(' / ')
    return {
      ...parsed,
      kind: 'markdown',
      name: parsed.name || (sep > 0 ? target.slice(0, sep).trim() : target),
      relPath: parsed.relPath || (sep > 0 ? target.slice(sep + 3).trim() : ''),
      content,
      message: ''
    }
  }

  const skillHeader = /^# Skill:\s*(.+)$/.exec(headerLine)
  if (skillHeader) {
    return {
      ...parsed,
      kind: 'markdown',
      name: parsed.name || skillHeader[1]!.trim(),
      content,
      message: ''
    }
  }

  return parsed
}
