import { existsSync, readFileSync } from 'fs'
import { dirname, extname } from 'path'
import { resolveInsideWorkspace, assertResolvedInsideWorkspace } from '../../workspace/safePath'
import { atomicWriteFile } from '@main/storage/atomicWrite'
import { withWorkspaceMutation } from '@main/workspace/mutationQueue'
import { assertWritablePath } from './writeGuard'
import { existingFileMode } from './edit'
import { countOccurrences, replaceFirstLiteral } from './strReplace'

export const NOTEBOOK_LANGUAGES = [
  'python',
  'markdown',
  'javascript',
  'typescript',
  'r',
  'sql',
  'shell',
  'raw',
  'other'
] as const

export type NotebookLanguage = (typeof NOTEBOOK_LANGUAGES)[number]

type NotebookCell = {
  cell_type: 'code' | 'markdown' | 'raw'
  source: string | string[]
  metadata?: Record<string, unknown>
  outputs?: unknown[]
  execution_count?: number | null
}

type NotebookFile = {
  nbformat: number
  nbformat_minor?: number
  metadata?: Record<string, unknown>
  cells: NotebookCell[]
}

export type EditNotebookArgs = {
  target_notebook: string
  cell_idx: number
  is_new_cell?: boolean
  cell_language?: NotebookLanguage
  old_string?: string
  new_string: string
}

function cellSource(cell: NotebookCell): string {
  if (Array.isArray(cell.source)) return cell.source.join('')
  return typeof cell.source === 'string' ? cell.source : ''
}

function toSourceLines(text: string): string[] {
  if (text === '') return []
  const parts = text.split('\n')
  return parts.map((line, i) => (i === parts.length - 1 ? line : `${line}\n`))
}

function cellTypeForLanguage(lang: NotebookLanguage): NotebookCell['cell_type'] {
  if (lang === 'markdown') return 'markdown'
  if (lang === 'raw' || lang === 'other') return 'raw'
  return 'code'
}

function makeCell(language: NotebookLanguage, source: string): NotebookCell {
  const cell_type = cellTypeForLanguage(language)
  const cell: NotebookCell = {
    cell_type,
    source: toSourceLines(source),
    metadata: language === 'markdown' || language === 'raw' || language === 'other'
      ? {}
      : { language }
  }
  if (cell_type === 'code') {
    cell.outputs = []
    cell.execution_count = null
  }
  return cell
}

function emptyNotebook(): NotebookFile {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' }
    },
    cells: []
  }
}

function parseNotebook(raw: string, rel: string): NotebookFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${rel} is not valid notebook JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${rel} is not a Jupyter notebook object`)
  }
  const rec = parsed as Record<string, unknown>
  if (rec.nbformat !== 4) {
    throw new Error(`${rel} must be nbformat 4`)
  }
  if (!Array.isArray(rec.cells)) {
    throw new Error(`${rel} is missing cells[]`)
  }
  return rec as NotebookFile
}

/** Jupyter writes notebooks with a one-space indent. */
const JUPYTER_INDENT = 1

/**
 * The indent a notebook was saved with, so a one-cell edit does not rewrite
 * every line of a Jupyter (indent 1) file as indent 2.
 */
function notebookIndent(raw: string): number {
  const match = /^\{\r?\n( +)"/.exec(raw)
  return match ? match[1]!.length : JUPYTER_INDENT
}

function serializeNotebook(notebook: NotebookFile, indent: number): string {
  return `${JSON.stringify(notebook, null, indent)}\n`
}

/**
 * Cell-level edit of a nbformat v4 notebook. Does not execute kernels.
 */
export function toolEditNotebook(workspaceRoot: string, args: EditNotebookArgs): string {
  const rel = (args.target_notebook ?? '').trim().replace(/\\/g, '/')
  if (!rel) throw new Error('edit_notebook requires target_notebook')
  if (extname(rel).toLowerCase() !== '.ipynb') {
    throw new Error('edit_notebook requires a .ipynb path')
  }
  const cellIdx = args.cell_idx
  if (!Number.isInteger(cellIdx) || cellIdx < 0) {
    throw new Error('edit_notebook requires a non-negative cell_idx')
  }
  const newString = args.new_string ?? ''
  const isNew = args.is_new_cell === true
  const resolved = resolveInsideWorkspace(workspaceRoot, rel)
  assertResolvedInsideWorkspace(workspaceRoot, dirname(resolved))
  assertWritablePath(rel)

  const existed = existsSync(resolved)
  if (!existed && !isNew) {
    throw new Error(`Notebook not found: ${rel}`)
  }

  const raw = existed ? readFileSync(resolved, 'utf8') : ''
  const notebook = existed ? parseNotebook(raw, rel) : emptyNotebook()
  const indent = existed ? notebookIndent(raw) : JUPYTER_INDENT
  const mode = existingFileMode(resolved)
  const cells = Array.isArray(notebook.cells) ? [...notebook.cells] : []

  if (isNew) {
    const language = args.cell_language ?? 'python'
    if (cellIdx > cells.length) {
      throw new Error(`cell_idx ${cellIdx} is past the end (${cells.length} cells); use ${cells.length} to append`)
    }
    cells.splice(cellIdx, 0, makeCell(language, newString))
    notebook.cells = cells
    atomicWriteFile(resolved, serializeNotebook(notebook, indent), mode)
    return existed
      ? `Inserted ${language} cell ${cellIdx} in ${rel}`
      : `Created ${rel} with ${language} cell 0`
  }

  if (cellIdx >= cells.length) {
    throw new Error(`cell_idx ${cellIdx} is out of range (${cells.length} cells)`)
  }
  const oldString = args.old_string ?? ''
  if (!oldString) {
    throw new Error('edit_notebook replace requires old_string (or is_new_cell: true to insert)')
  }
  const cell = cells[cellIdx]!
  const source = cellSource(cell)
  const matches = countOccurrences(source, oldString)
  if (matches === 0) {
    throw new Error(`old_string not found in cell ${cellIdx} of ${rel}`)
  }
  if (matches > 1) {
    throw new Error(
      `old_string matched ${matches} times in cell ${cellIdx} of ${rel}; provide a unique snippet`
    )
  }
  cell.source = toSourceLines(replaceFirstLiteral(source, oldString, newString))
  if (args.cell_language) {
    cell.cell_type = cellTypeForLanguage(args.cell_language)
    if (cell.cell_type === 'code') {
      cell.metadata = { ...(cell.metadata ?? {}), language: args.cell_language }
      cell.outputs = cell.outputs ?? []
      cell.execution_count = cell.execution_count ?? null
    }
  }
  notebook.cells = cells
  atomicWriteFile(resolved, serializeNotebook(notebook, indent), mode)
  return `Updated cell ${cellIdx} in ${rel}`
}

export async function toolEditNotebookAsync(
  workspaceRoot: string,
  args: EditNotebookArgs
): Promise<string> {
  return withWorkspaceMutation(workspaceRoot, args.target_notebook, () =>
    toolEditNotebook(workspaceRoot, args)
  )
}
