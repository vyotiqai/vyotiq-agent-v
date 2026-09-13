import { existsSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { resolveInsideWorkspace, assertResolvedInsideWorkspace } from '../../workspace/safePath'
import { atomicWriteFile } from '@main/storage/atomicWrite'
import { withExclusiveWorkspaceMutation } from '@main/workspace/mutationQueue'
import { assertWritablePath } from './writeGuard'
import {
  workspaceLspRequest,
  workspaceLspStatus
} from '../../workspace/lspService'
import type { WorkspaceLspResponse } from '../../../shared/ipc'

export const LSP_ACTIONS = ['hover', 'completion', 'diagnostics', 'definition', 'rename'] as const
export type LspToolAction = (typeof LSP_ACTIONS)[number]

export const LSP_COMPLETION_LIST_CAP = 20

export function lspActionFromArgs(args?: Record<string, unknown>): LspToolAction {
  const raw = typeof args?.action === 'string' ? args.action : 'diagnostics'
  if (raw === 'hover' || raw === 'completion' || raw === 'definition' || raw === 'rename') {
    return raw
  }
  return 'diagnostics'
}

function lspOffset(text: string, line: number, character: number): number {
  let remaining = Math.max(0, line)
  let i = 0
  while (i < text.length && remaining > 0) {
    if (text.charCodeAt(i) === 10) remaining -= 1
    i += 1
  }
  return Math.min(text.length, i + Math.max(0, character))
}

function applyLspTextEdits(
  text: string,
  edits: Array<{
    startLine: number
    startCharacter: number
    endLine: number
    endCharacter: number
    newText: string
  }>
): string {
  const ordered = [...edits].sort(
    (a, b) => b.startLine - a.startLine || b.startCharacter - a.startCharacter
  )
  let next = text
  for (const edit of ordered) {
    const start = lspOffset(next, edit.startLine, edit.startCharacter)
    const end = lspOffset(next, edit.endLine, edit.endCharacter)
    next = next.slice(0, start) + edit.newText + next.slice(Math.max(start, end))
  }
  return next
}

function formatLspResponse(response: WorkspaceLspResponse): string {
  switch (response.kind) {
    case 'hover':
      return response.content?.trim() ? response.content : 'No hover information.'
    case 'completion': {
      const items = response.items.slice(0, LSP_COMPLETION_LIST_CAP)
      if (items.length === 0) return 'No completions.'
      const more =
        response.items.length > items.length
          ? `\n… ${response.items.length - items.length} more`
          : ''
      return (
        items
          .map((item) => (item.detail ? `${item.label} — ${item.detail}` : item.label))
          .join('\n') + more
      )
    }
    case 'diagnostics': {
      if (response.items.length === 0) return 'No diagnostics.'
      return response.items
        .map(
          (item) =>
            `${item.severity} ${item.line + 1}:${item.character + 1} ${item.message}`
        )
        .join('\n')
    }
    case 'definition':
      if (!response.path) return 'No definition.'
      return `${response.path}:${response.line + 1}:${response.character + 1}`
    case 'rename':
      if (response.edits.length === 0) return 'Rename produced no edits.'
      return response.edits
        .map(
          (edit) =>
            `${edit.path}:${edit.startLine + 1}:${edit.startCharacter + 1}`
        )
        .join('\n')
    default: {
      const _exhaustive: never = response
      return _exhaustive
    }
  }
}

export type LspToolResult = {
  ok: boolean
  summary: string
  content: string
  mutatedPaths: string[]
  pendingRenameEdits?: Array<{
    path: string
    startLine: number
    startCharacter: number
    endLine: number
    endCharacter: number
    newText: string
  }>
}

/**
 * Agent-facing wrapper around the Files-panel language servers.
 * Reads disk (not the unsaved editor buffer). Rename applies workspace edits.
 */
export async function toolLsp(
  workspaceRoot: string,
  args: Record<string, unknown>
): Promise<LspToolResult> {
  const rel = (typeof args.path === 'string' ? args.path : '').trim().replace(/\\/g, '/')
  if (!rel) {
    return { ok: false, summary: 'lsp', content: 'lsp requires path', mutatedPaths: [] }
  }
  const resolved = resolveInsideWorkspace(workspaceRoot, rel)
  if (!existsSync(resolved)) {
    return { ok: false, summary: rel, content: `File not found: ${rel}`, mutatedPaths: [] }
  }
  const action = lspActionFromArgs(args)
  const status = await workspaceLspStatus(workspaceRoot, rel)
  if (status.kind === 'unavailable') {
    return { ok: true, summary: rel, content: status.detail, mutatedPaths: [] }
  }
  const content = readFileSync(resolved, 'utf8')
  const line = typeof args.line === 'number' && Number.isFinite(args.line) ? Math.max(0, Math.floor(args.line)) : 0
  const character =
    typeof args.character === 'number' && Number.isFinite(args.character)
      ? Math.max(0, Math.floor(args.character))
      : 0
  const newName =
    typeof args.new_name === 'string'
      ? args.new_name.trim()
      : typeof args.newName === 'string'
        ? args.newName.trim()
        : undefined
  const response = await workspaceLspRequest({
    workspacePath: workspaceRoot,
    path: rel,
    content,
    action,
    newName,
    line,
    character
  })
  if (response.kind !== 'rename') {
    return { ok: true, summary: `${action} ${rel}`, content: formatLspResponse(response), mutatedPaths: [] }
  }
  if (response.edits.length === 0) {
    return { ok: true, summary: `rename ${rel}`, content: formatLspResponse(response), mutatedPaths: [] }
  }
  return {
    ok: true,
    summary: `rename ${rel}`,
    content: formatLspResponse(response),
    mutatedPaths: [],
    pendingRenameEdits: response.edits
  }
}

export async function applyLspRenameEdits(
  workspaceRoot: string,
  edits: NonNullable<LspToolResult['pendingRenameEdits']>
): Promise<string[]> {
  const byPath = new Map<string, NonNullable<LspToolResult['pendingRenameEdits']>>()
  for (const edit of edits) {
    const list = byPath.get(edit.path) ?? []
    list.push(edit)
    byPath.set(edit.path, list)
  }
  const mutatedPaths: string[] = []
  await withExclusiveWorkspaceMutation(workspaceRoot, () => {
    for (const [path, pathEdits] of byPath) {
      assertWritablePath(path)
      const abs = resolveInsideWorkspace(workspaceRoot, path)
      assertResolvedInsideWorkspace(workspaceRoot, dirname(abs))
      if (!existsSync(abs)) {
        throw new Error(`Rename target missing: ${path}`)
      }
      const original = readFileSync(abs, 'utf8')
      atomicWriteFile(abs, applyLspTextEdits(original, pathEdits))
      mutatedPaths.push(path)
    }
  })
  return mutatedPaths
}
