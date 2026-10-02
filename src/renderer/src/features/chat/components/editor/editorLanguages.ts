import { StreamLanguage, type StreamParser } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

/**
 * Which grammar a file gets in the editor. The first group ships with the
 * editor chunk (Lezer grammars); everything else is a CodeMirror 5 mode from
 * `@codemirror/legacy-modes`, loaded on first use so a file in one language
 * never pays for the other forty.
 */
export type EditorLanguageId =
  | 'tsx'
  | 'typescript'
  | 'jsx'
  | 'javascript'
  | 'json'
  | 'markdown'
  | 'python'
  | 'css'
  | 'html'
  | 'yaml'
  | 'go'
  | 'rust'
  | 'java'
  | 'kotlin'
  | 'scala'
  | 'dart'
  | 'c'
  | 'cpp'
  | 'objectivec'
  | 'csharp'
  | 'swift'
  | 'shell'
  | 'powershell'
  | 'sql'
  | 'toml'
  | 'dockerfile'
  | 'ruby'
  | 'lua'
  | 'diff'
  | 'properties'
  | 'cmake'
  | 'xml'
  | 'protobuf'
  | 'groovy'
  | 'perl'
  | 'r'
  | 'haskell'
  | 'nginx'
  | 'julia'

/** Whole file names (lower-cased) that say the language better than an extension. */
const FILENAMES: Record<string, EditorLanguageId> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  'cmakelists.txt': 'cmake',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.bash_aliases': 'shell',
  '.bash_logout': 'shell',
  '.profile': 'shell',
  '.zshrc': 'shell',
  '.zshenv': 'shell',
  '.zprofile': 'shell',
  '.zlogin': 'shell',
  '.envrc': 'shell',
  '.env': 'properties',
  '.editorconfig': 'properties',
  '.gitconfig': 'properties',
  '.npmrc': 'properties',
  '.gitattributes': 'properties',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  vagrantfile: 'ruby',
  brewfile: 'ruby',
  jenkinsfile: 'groovy',
  'nginx.conf': 'nginx',
  'cargo.lock': 'toml',
  'poetry.lock': 'toml',
  'pipfile': 'toml',
  'go.mod': 'go',
  'go.work': 'go'
}

const EXTENSIONS: Record<string, EditorLanguageId> = {
  tsx: 'tsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  jsx: 'jsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  md: 'markdown',
  mdc: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  py: 'python',
  pyi: 'python',
  pyw: 'python',
  css: 'css',
  scss: 'css',
  less: 'css',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  yaml: 'yaml',
  yml: 'yaml',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  sc: 'scala',
  dart: 'dart',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  'c++': 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  ino: 'cpp',
  m: 'objectivec',
  mm: 'objectivec',
  cs: 'csharp',
  csx: 'csharp',
  swift: 'swift',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  sql: 'sql',
  toml: 'toml',
  dockerfile: 'dockerfile',
  rb: 'ruby',
  gemspec: 'ruby',
  rake: 'ruby',
  lua: 'lua',
  diff: 'diff',
  patch: 'diff',
  ini: 'properties',
  cfg: 'properties',
  conf: 'properties',
  properties: 'properties',
  env: 'properties',
  cmake: 'cmake',
  xml: 'xml',
  svg: 'xml',
  plist: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  csproj: 'xml',
  fsproj: 'xml',
  vbproj: 'xml',
  props: 'xml',
  targets: 'xml',
  resx: 'xml',
  proto: 'protobuf',
  groovy: 'groovy',
  gradle: 'groovy',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  hs: 'haskell',
  jl: 'julia'
}

function baseName(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase()
}

/** The language a path opens in, or null for plain text. */
export function editorLanguageFor(path: string): EditorLanguageId | null {
  const name = baseName(path)
  if (!name) return null
  const byName = FILENAMES[name]
  if (byName) return byName
  // `Dockerfile.dev`, `api.Dockerfile`; `.env.local`, `.env.production`.
  if (name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return 'dockerfile'
  if (name.startsWith('.env.')) return 'properties'
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const ext = name.slice(dot + 1)
  return EXTENSIONS[ext] ?? null
}

/** Languages whose Lezer grammar ships in the editor chunk; TextCodeEditor builds them synchronously. */
export const BUNDLED_EDITOR_LANGUAGES: ReadonlySet<EditorLanguageId> = new Set<EditorLanguageId>([
  'tsx',
  'typescript',
  'jsx',
  'javascript',
  'json',
  'markdown',
  'python',
  'css',
  'html',
  'yaml'
])

type Loader = () => Promise<Extension>

/**
 * Each legacy loader is its own `import()`, so Vite emits a chunk per mode and
 * the editor chunk only carries this table. `StreamLanguage` comes from
 * `@codemirror/language`, which the editor loads anyway.
 */
function stream<T>(load: () => Promise<StreamParser<T>>): Promise<Extension> {
  return load().then((parser) => StreamLanguage.define(parser))
}

const LEGACY: Partial<Record<EditorLanguageId, Loader>> = {
  go: () => stream(() => import('@codemirror/legacy-modes/mode/go').then((m) => m.go)),
  rust: () => stream(() => import('@codemirror/legacy-modes/mode/rust').then((m) => m.rust)),
  java: () => stream(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.java)),
  kotlin: () => stream(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.kotlin)),
  scala: () => stream(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.scala)),
  dart: () => stream(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.dart)),
  c: () => stream(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.c)),
  cpp: () => stream(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.cpp)),
  objectivec: () => stream(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.objectiveC)),
  csharp: () => stream(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.csharp)),
  swift: () => stream(() => import('@codemirror/legacy-modes/mode/swift').then((m) => m.swift)),
  shell: () => stream(() => import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell)),
  powershell: () => stream(() => import('@codemirror/legacy-modes/mode/powershell').then((m) => m.powerShell)),
  sql: () => stream(() => import('@codemirror/legacy-modes/mode/sql').then((m) => m.standardSQL)),
  toml: () => stream(() => import('@codemirror/legacy-modes/mode/toml').then((m) => m.toml)),
  dockerfile: () => stream(() => import('@codemirror/legacy-modes/mode/dockerfile').then((m) => m.dockerFile)),
  ruby: () => stream(() => import('@codemirror/legacy-modes/mode/ruby').then((m) => m.ruby)),
  lua: () => stream(() => import('@codemirror/legacy-modes/mode/lua').then((m) => m.lua)),
  diff: () => stream(() => import('@codemirror/legacy-modes/mode/diff').then((m) => m.diff)),
  properties: () => stream(() => import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties)),
  cmake: () => stream(() => import('@codemirror/legacy-modes/mode/cmake').then((m) => m.cmake)),
  xml: () => stream(() => import('@codemirror/legacy-modes/mode/xml').then((m) => m.xml)),
  protobuf: () => stream(() => import('@codemirror/legacy-modes/mode/protobuf').then((m) => m.protobuf)),
  groovy: () => stream(() => import('@codemirror/legacy-modes/mode/groovy').then((m) => m.groovy)),
  perl: () => stream(() => import('@codemirror/legacy-modes/mode/perl').then((m) => m.perl)),
  r: () => stream(() => import('@codemirror/legacy-modes/mode/r').then((m) => m.r)),
  haskell: () => stream(() => import('@codemirror/legacy-modes/mode/haskell').then((m) => m.haskell)),
  nginx: () => stream(() => import('@codemirror/legacy-modes/mode/nginx').then((m) => m.nginx)),
  julia: () => stream(() => import('@codemirror/legacy-modes/mode/julia').then((m) => m.julia))
}

const loaded = new Map<EditorLanguageId, Promise<Extension>>()

/**
 * The grammar for a language that is not bundled, loaded once per window. A
 * failed chunk load resolves to no grammar (plain text) and is not cached, so
 * the next open retries.
 */
export function loadLegacyEditorLanguage(id: EditorLanguageId): Promise<Extension> {
  const cached = loaded.get(id)
  if (cached) return cached
  const loader = LEGACY[id]
  if (!loader) return Promise.resolve([])
  const pending = loader().catch((): Extension => {
    loaded.delete(id)
    return []
  })
  loaded.set(id, pending)
  return pending
}

/** True when `id` has a grammar: bundled, or a legacy mode to load. */
export function hasEditorLanguageGrammar(id: EditorLanguageId): boolean {
  return BUNDLED_EDITOR_LANGUAGES.has(id) || Boolean(LEGACY[id])
}
