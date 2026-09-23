import type { WorkspaceFileEncoding, WorkspaceFileEol } from '@shared/ipc'

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  tsx: 'TypeScript React',
  js: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  jsx: 'JavaScript React',
  json: 'JSON',
  jsonc: 'JSON with comments',
  md: 'Markdown',
  mdx: 'MDX',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  html: 'HTML',
  htm: 'HTML',
  svg: 'SVG',
  xml: 'XML',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
  ini: 'INI',
  py: 'Python',
  rb: 'Ruby',
  rs: 'Rust',
  go: 'Go',
  java: 'Java',
  kt: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  cc: 'C++',
  hpp: 'C++',
  cs: 'C#',
  php: 'PHP',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  ps1: 'PowerShell',
  psm1: 'PowerShell',
  bat: 'Batch',
  cmd: 'Batch',
  sql: 'SQL',
  astro: 'Astro',
  vue: 'Vue',
  svelte: 'Svelte',
  txt: 'Plain text',
  log: 'Log'
}

const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: 'Dockerfile',
  makefile: 'Makefile',
  '.gitignore': 'Ignore',
  '.gitattributes': 'Git attributes',
  '.editorconfig': 'EditorConfig'
}

/** The file's type as its name says it — what an editor's status bar shows. */
export function languageName(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  const byName = LANGUAGE_BY_NAME[name]
  if (byName) return byName
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return 'Plain text'
  const extension = name.slice(dot + 1)
  return LANGUAGE_BY_EXTENSION[extension] ?? extension.toUpperCase()
}

export function encodingLabel(encoding: WorkspaceFileEncoding, bom: boolean): string {
  const base =
    encoding === 'utf8' ? 'UTF-8' : encoding === 'utf16le' ? 'UTF-16 LE' : encoding === 'utf16be' ? 'UTF-16 BE' : 'Binary'
  return bom && encoding !== 'binary' ? `${base} with BOM` : base
}

/** Line endings as read from disk; a file with one line has none to report. */
export function eolLabel(eol: WorkspaceFileEol): string | null {
  switch (eol) {
    case 'lf':
      return 'LF'
    case 'crlf':
      return 'CRLF'
    case 'cr':
      return 'CR'
    case 'mixed':
      return 'Mixed line endings'
    case 'none':
      return null
    default: {
      const _exhaustive: never = eol
      return _exhaustive
    }
  }
}
