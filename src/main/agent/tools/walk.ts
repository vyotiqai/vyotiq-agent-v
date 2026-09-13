import { realpathSync, promises as fsp } from 'fs'
import { basename, extname, join } from 'path'
import { gitignoreMatcherForDir } from './gitignore'
import {
  canonicalizeWorkspacePath,
  isWindowsStylePath
} from '../../../shared/utils/workspacePath'

/** Directories never worth walking, even when .gitignore does not mention them. */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.vyotiq',
  'dist',
  'out',
  'build',
  '.next',
  'coverage',
  '__pycache__',
  '.turbo',
  '.venv',
  'venv',
  '.pytest_cache',
  '.cache',
  '.mypy_cache',
  '.ruff_cache',
  'vendor',
  'dist-package',
  'dist-package-alt',
  'playwright-report',
  'test-results',
  '.output',
  '__snapshots__',
  '.nyc_output',
  '.parcel-cache',
  '.vite',
  '.nuxt',
  '.svelte-kit',
  '.yarn',
  '.pnpm-store',
  'bower_components',
  'jspm_packages',
  '.sass-cache',
  '.terraform',
  'Pods',
  'DerivedData',
  '.gradle',
  '.tox',
  '.eggs',
  'htmlcov',
  '.ipynb_checkpoints',
  'storybook-static',
  '.expo',
  '.angular',
  '.vercel',
  '.netlify',
  '.idea',
  '.vs',
  'target',
  'obj',
  'third_party',
  'deps',
  'extern',
  '.husky'
])

export const TEXT_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.json',
  '.jsonc',
  '.md',
  '.mdc',
  '.mdx',
  '.txt',
  '.rst',
  '.adoc',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.htm',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.cfg',
  '.xml',
  '.rs',
  '.go',
  '.py',
  '.pyi',
  '.java',
  '.kt',
  '.kts',
  '.swift',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hpp',
  '.hh',
  '.cs',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.bat',
  '.cmd',
  '.sql',
  '.vue',
  '.svelte',
  '.rb',
  '.php',
  '.dart',
  '.lua',
  '.r',
  '.m',
  '.mm',
  '.zig',
  '.nim',
  '.ex',
  '.exs',
  '.erl',
  '.hs',
  '.clj',
  '.cljs',
  '.cljc',
  '.fs',
  '.fsx',
  '.ml',
  '.mli',
  '.jl',
  '.pl',
  '.pm',
  '.sol',
  '.scala',
  '.groovy',
  '.proto',
  '.graphql',
  '.gql',
  '.prisma',
  '.tf',
  '.tfvars',
  '.ipynb'
])

/**
 * Docs, configs, styles, scripts, schemas, notebooks, and data dumps.
 * Live grep/glob may still list these; neither index stores them.
 */
const INDEX_EXCLUDE_EXTS = new Set([
  '.json',
  '.jsonc',
  '.txt',
  '.rst',
  '.adoc',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.htm',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.cfg',
  '.xml',
  '.md',
  '.mdc',
  '.mdx',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.bat',
  '.cmd',
  '.sql',
  '.pyi',
  '.kts',
  '.exs',
  '.fsx',
  '.proto',
  '.graphql',
  '.gql',
  '.prisma',
  '.tf',
  '.tfvars',
  '.ipynb'
])

/** Production source languages — shared by the code index. */
export const CODE_INDEX_EXTS = new Set(
  [...TEXT_EXTS].filter((ext) => !INDEX_EXCLUDE_EXTS.has(ext))
)

/** Docs still scanned by grep/search overlap even when trigram has source hits. */
export const DOC_TEXT_EXTS = new Set([
  '.md',
  '.mdc',
  '.mdx',
  '.txt',
  '.rst',
  '.adoc',
  '.docx'
])

const INDEX_CLUTTER_BASENAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'composer.lock',
  'gemfile.lock',
  'poetry.lock',
  'pdm.lock',
  'uv.lock',
  'pipfile.lock',
  'npm-shrinkwrap.json',
  'go.sum',
  'flake.lock',
  'pnpm-workspace.yaml',
  'makefile',
  'gnumakefile',
  'dockerfile',
  'cmakelists.txt',
  'gemfile',
  'podfile',
  'pipfile',
  'procfile',
  'justfile',
  'rakefile',
  'gruntfile.js',
  'gulpfile.js',
  'gulpfile.ts',
  'setup.py',
  'setup.cfg',
  'conftest.py',
  'manage.py'
])

/**
 * Generic indexer skip folders: tests, docs, configs, scripts, data/DB,
 * generated trees, CI, and temp — not production source.
 */
export const INDEX_SKIP_DIR_SEGMENTS = new Set([
  '__tests__',
  '__mocks__',
  '__fixtures__',
  '__snapshots__',
  'tests',
  'test',
  'testing',
  'spec',
  'specs',
  'e2e',
  'cypress',
  'playwright',
  'fixtures',
  'testdata',
  'test-data',
  'mocks',
  'snapshots',
  'golden',
  'goldens',
  'docs',
  'doc',
  'documentation',
  'wiki',
  'manuals',
  'config',
  'configs',
  'configuration',
  '.config',
  '.github',
  '.circleci',
  '.gitlab',
  '.azure-pipelines',
  '.buildkite',
  '.devcontainer',
  'scripts',
  'script',
  'data',
  'database',
  'databases',
  'db',
  'dbs',
  'dumps',
  'dump',
  'seeds',
  'migrations',
  'migrate',
  'alembic',
  'prisma',
  'generated',
  'codegen',
  '.storybook',
  'storybook',
  'stories',
  'examples',
  'example',
  'samples',
  'sample',
  'demo',
  'demos',
  'benchmarks',
  'bench',
  'assets',
  'static',
  'public',
  'media',
  'uploads',
  'tmp',
  'temp',
  'logs',
  'ci',
  // toolchain / vendor trees (e.g. an entire msys64 toolchain under .linux-vm)
  'msys64',
  'mingw',
  'mingw32',
  'mingw64',
  'ucrt64',
  'clang32',
  'clang64',
  'clangarm64'
])

const MINIFIED_OR_GENERATED_NAME_RE =
  /\.(?:min\.(?:js|mjs|cjs|css)|map|snap|generated\.[^.]+|gen\.(?:ts|tsx|js|jsx|mjs|cjs)|pb\.(?:go|ts|js)|bundle\.(?:js|mjs|cjs))$/i
const PROTO_PY_RE = /_pb2(?:_grpc)?\.py$/i
const TEST_OR_STORY_NAME_RE =
  /\.(?:test|tests|spec|specs|stories|story|e2e|int-test|integration-test|setup|setuptests)\./i
const LANGUAGE_TEST_NAME_RE =
  /(?:^test_.*|_test\.(?:go|py|rs|rb|php|exs|dart|lua)$|_spec\.(?:rb|php|dart|ts|js|jsx)$|^conftest\.py$|^test\.php$)/i
const PHP_TEST_NAME_RE = /Test\.php$/
const JVM_STYLE_TEST_NAME_RE = /(?:Test|Tests|TestCase)\.(?:java|kt|cs|swift|groovy|scala)$/
const INDEX_SKIP_CONFIG_NAME_RE = /\.(?:config|configs|conf)\.[^.]+$/i
const INDEX_SKIP_STUB_NAME_RE = /\.(?:d\.ts|pyi)$/i

function fileBaseName(relOrName: string): string {
  return basename(relOrName.replace(/\\/g, '/'))
}

/** Lockfiles, minified bundles, source maps, snapshots, codegen, and build entry files. */
export function isIndexClutterFileName(relOrName: string): boolean {
  const base = fileBaseName(relOrName)
  if (INDEX_CLUTTER_BASENAMES.has(base.toLowerCase())) return true
  if (MINIFIED_OR_GENERATED_NAME_RE.test(base)) return true
  if (PROTO_PY_RE.test(base)) return true
  return false
}

function hasIndexSkipDirSegment(rel: string): boolean {
  const parts = rel.replace(/\\/g, '/').split('/')
  for (let i = 0; i < parts.length - 1; i++) {
    if (INDEX_SKIP_DIR_SEGMENTS.has(parts[i]!.toLowerCase())) return true
  }
  return false
}

/**
 * Files grep/search still scan when trigram already returned source hits.
 * The source index omits `docs/` and `tests/` (and other skip dirs).
 */
export function isGrepOverlapRel(rel: string, full?: string): boolean {
  const path = (full ?? rel).replace(/\\/g, '/')
  const ext = extname(path).toLowerCase()
  if (DOC_TEXT_EXTS.has(ext)) return true
  if (!TEXT_EXTS.has(ext)) return false
  return hasIndexSkipDirSegment(rel)
}

function isIndexSkipFileName(base: string): boolean {
  if (base.startsWith('.')) return true
  if (INDEX_SKIP_STUB_NAME_RE.test(base)) return true
  if (TEST_OR_STORY_NAME_RE.test(base)) return true
  if (LANGUAGE_TEST_NAME_RE.test(base)) return true
  if (PHP_TEST_NAME_RE.test(base)) return true
  if (JVM_STYLE_TEST_NAME_RE.test(base)) return true
  if (INDEX_SKIP_CONFIG_NAME_RE.test(base)) return true
  return false
}

/**
 * True when a generic indexer should store this path. Production source only —
 * tests, docs, configs, scripts, databases, and clutter stay out.
 */
export function isIndexableSourcePath(rel: string, full?: string): boolean {
  const ext = extname(full ?? rel.replace(/\\/g, '/')).toLowerCase()
  if (!CODE_INDEX_EXTS.has(ext)) return false
  if (isIndexClutterFileName(rel)) return false
  if (hasIndexSkipDirSegment(rel)) return false
  if (isIndexSkipFileName(fileBaseName(rel))) return false
  return true
}

export function isDenseIndexPath(rel: string, full?: string): boolean {
  return isIndexableSourcePath(rel, full)
}

/** Yield the event loop so long scans stay responsive to abort/cancel. */
const YIELD_EVERY_DIRS = 64

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
}

export type WalkedFile = {
  /** Absolute path on disk. */
  full: string
  /** Workspace-relative path with forward slashes. */
  rel: string
}

function pathKey(path: string): string {
  return isWindowsStylePath(path) ? path.toLowerCase() : path
}

/**
 * Syscall-free containment check for walked entries. Walks never follow
 * symlinks (entries are excluded above) and every child path is joined onto
 * the already-resolved real root, so a prefix compare is sufficient — the
 * per-entry existsSync/realpathSync pair cost two syscalls per entry.
 */
function isContainedByConstruction(full: string, realRoot: string): boolean {
  const rootKey = pathKey(realRoot)
  const fullKey = pathKey(full)
  return fullKey === rootKey || fullKey.startsWith(rootKey + (isWindowsStylePath(realRoot) ? '\\' : '/'))
}

export type WorkspaceFilesPage = {
  files: WalkedFile[]
  /** Workspace-relative path of the last collected file, or null when empty. */
  lastRel: string | null
  /** True when the walk finished before hitting cap. */
  exhausted: boolean
  /** True when `startAfter` was set but that path was never seen (deleted / skipped). */
  cursorMissing: boolean
}

/** Notice when a live grep/glob/search walk hit its file cap. */
export function formatLiveScanCapNotice(cap: number): string {
  return `scan cap ${cap}; narrow the query or wait for index=`
}

function walkHitCap(count: number, cap: number | undefined): boolean {
  return cap != null && Number.isFinite(cap) && count >= cap
}

/**
 * Breadth-first workspace walk that honours .gitignore. Shared by search, glob
 * and grep so all three agree on what counts as part of the project.
 * Symlinks are skipped so walks cannot escape via links (same rule as safePath).
 *
 * When `startAfter` is set, files before that path in walk order are skipped
 * (identity resume). Lexicographic `rel <= startAfter` is not used — BFS order
 * is not sorted by path.
 */
export async function collectWorkspaceFilesPage(
  workspaceRoot: string,
  cap?: number,
  startAfter?: string,
  signal?: AbortSignal,
  exts?: ReadonlySet<string>,
  skipDirNames?: ReadonlySet<string>,
  keepRel?: (rel: string, full: string) => boolean
): Promise<WorkspaceFilesPage> {
  const files: WalkedFile[] = []
  let lastRel: string | null = null
  const realRoot = realpathSync(canonicalizeWorkspacePath(workspaceRoot))
  const queue: Array<{ dir: string; relDir: string }> = [{ dir: realRoot, relDir: '' }]
  let scanned = 0
  const cursor = startAfter?.trim() ? startAfter.replace(/\\/g, '/') : undefined
  let pastCursor = cursor == null
  let sawCursor = cursor == null

  while (queue.length > 0) {
    throwIfAborted(signal)
    if (walkHitCap(files.length, cap)) {
      return { files, lastRel, exhausted: false, cursorMissing: Boolean(cursor) && !sawCursor }
    }

    const next = queue.shift()!
    scanned += 1
    if (scanned > 1 && scanned % YIELD_EVERY_DIRS === 0) {
      await yieldToEventLoop()
      throwIfAborted(signal)
    }

    const dirMatcher = gitignoreMatcherForDir(workspaceRoot, next.relDir)
    let entries
    try {
      entries = await fsp.readdir(next.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      throwIfAborted(signal)
      if (walkHitCap(files.length, cap)) {
        return { files, lastRel, exhausted: false, cursorMissing: Boolean(cursor) && !sawCursor }
      }
      if (IGNORED_DIRS.has(entry.name)) continue
      // Never follow symlinks — a link inside the tree can point outside.
      if (entry.isSymbolicLink()) continue
      if (dirMatcher.shouldIgnoreEntry(entry.name, entry.isDirectory())) continue
      const full = join(next.dir, entry.name)
      const childRel = (next.relDir ? `${next.relDir}/${entry.name}` : entry.name).replace(
        /\\/g,
        '/'
      )
      if (!isContainedByConstruction(full, realRoot)) continue
      if (entry.isDirectory()) {
        const lowerName = entry.name.toLowerCase()
        // Build outputs with dist- variants (dist-verify, dist-package-alt, …)
        // are never source; untracked ones would otherwise pollute every walk.
        if (lowerName.startsWith('dist-') || skipDirNames?.has(lowerName)) continue
        queue.push({ dir: full, relDir: childRel })
      } else if (entry.isFile()) {
        if (exts && !exts.has(extname(entry.name).toLowerCase())) continue
        if (keepRel && !keepRel(childRel, full)) continue
        if (isIndexClutterFileName(entry.name)) continue
        if (!pastCursor) {
          if (childRel === cursor) {
            sawCursor = true
            pastCursor = true
            continue
          }
          continue
        }
        files.push({ full, rel: childRel })
        lastRel = childRel
      }
    }
  }

  return { files, lastRel, exhausted: true, cursorMissing: Boolean(cursor) && !sawCursor }
}

export async function collectWorkspaceFiles(
  workspaceRoot: string,
  cap?: number,
  signal?: AbortSignal,
  exts?: ReadonlySet<string>,
  skipDirNames?: ReadonlySet<string>,
  keepRel?: (rel: string, full: string) => boolean
): Promise<WalkedFile[]> {
  const page = await collectWorkspaceFilesPage(
    workspaceRoot,
    cap,
    undefined,
    signal,
    exts,
    skipDirNames,
    keepRel
  )
  return page.files
}

/**
 * Translate a glob to a regex. Supports `**`, `*`, `?` and `{a,b}` — the subset
 * models actually reach for, without pulling in a matcher dependency.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  let out = ''
  let i = 0

  while (i < normalized.length) {
    const ch = normalized[i]!
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // `**/` may match zero directories, so the slash is part of the group.
        if (normalized[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 3
          continue
        }
        out += '.*'
        i += 2
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    if (ch === '{') {
      const close = normalized.indexOf('}', i)
      if (close > i) {
        const alternatives = normalized
          .slice(i + 1, close)
          .split(',')
          .map((part) => part.replace(/[.+^${}()|[\]\\*?]/g, '\\$&'))
        out += `(?:${alternatives.join('|')})`
        i = close + 1
        continue
      }
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    i += 1
  }

  return new RegExp(`^${out}$`, 'i')
}
