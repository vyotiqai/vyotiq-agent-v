/**
 * Entry names hidden from the Files explorer tree by default (dependency and
 * build-output noise). The Files panel's "Show ignored files" toggle bypasses
 * the filter; the filter text field also always searches ignored names.
 */
const WORKSPACE_IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.cache',
  '.git',
  '.gradle',
  '.hg',
  '.mypy_cache',
  '.next',
  '.nuxt',
  '.pytest_cache',
  '.ruff_cache',
  '.svn',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'CVS',
  'dist',
  'dist-package',
  'dist-package-alt',
  'node_modules',
  'out'
])

const WORKSPACE_IGNORED_FILE_NAMES: ReadonlySet<string> = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini'
])

/** True when a tree entry with this name is hidden unless ignored files are shown. */
export function isIgnoredWorkspaceEntryName(name: string): boolean {
  return WORKSPACE_IGNORED_DIRECTORY_NAMES.has(name) || WORKSPACE_IGNORED_FILE_NAMES.has(name)
}
