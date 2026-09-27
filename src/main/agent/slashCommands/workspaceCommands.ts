import { basename, join } from 'path'
import type { SlashCommandDescriptor, SlashCommandResolveResult } from '../../../shared/ipc'
import { splitFrontmatter, stripQuotes } from '../../../shared/rules'
import { formatWorkspaceCommand, normalizeTrigger } from '../../../shared/slashCommands'
import {
  CACHE_TTL_MS,
  collectWorkspaceFiles,
  fingerprintWorkspaceFiles,
  type ScanDir
} from '../workspaceFileScan'

const COMMAND_EXTENSIONS = ['.md'] as const

const COMMAND_DIRS: (ScanDir & { source: 'vyotiq' | 'cursor' })[] = [
  { dir: join('.vyotiq', 'commands'), extensions: COMMAND_EXTENSIONS, source: 'vyotiq' },
  { dir: join('.cursor', 'commands'), extensions: COMMAND_EXTENSIONS, source: 'cursor' }
]

const MAX_COMMAND_FILES = 48

export type WorkspaceCommandFile = {
  trigger: string
  label: string
  description: string
  body: string
  relativePath: string
  absolutePath: string
  source: 'vyotiq' | 'cursor'
}

type CacheEntry = {
  fingerprint: string
  files: WorkspaceCommandFile[]
  builtAt: number
}

const cache = new Map<string, CacheEntry>()

export function clearWorkspaceCommandsCache(workspacePath?: string): void {
  if (workspacePath) cache.delete(workspacePath)
  else cache.clear()
}

/** Command frontmatter keys are laxer than rule keys: digits, `_`, and indentation all pass. */
const COMMAND_KEY_LINE = /^([A-Za-z0-9_-]+):\s*(.*)$/

function parseCommandMarkdown(
  raw: string,
  fallbackName: string
): {
  name: string
  description: string
  body: string
} {
  const { lines, body } = splitFrontmatter(raw)
  if (!lines) return { name: fallbackName, description: '', body: body.trim() }
  const fields: Record<string, string> = {}
  for (const line of lines) {
    const m = COMMAND_KEY_LINE.exec(line.trim())
    if (!m) continue
    fields[m[1]!] = stripQuotes(m[2]!).trim()
  }
  return {
    name: fields.name?.trim() || fallbackName,
    description: fields.description?.trim() || '',
    body: body.trim()
  }
}

export async function readWorkspaceCommands(
  workspacePath: string | null
): Promise<WorkspaceCommandFile[]> {
  if (!workspacePath) return []

  // Stats every command file, not just the directories: an in-place edit does
  // not touch the parent's mtime, so a directory-only fingerprint served the
  // stale body for the whole TTL.
  const fingerprint = await fingerprintWorkspaceFiles({
    workspacePath,
    dirs: COMMAND_DIRS,
    maxFiles: MAX_COMMAND_FILES
  })
  const cached = cache.get(workspacePath)
  if (cached && cached.fingerprint === fingerprint && Date.now() - cached.builtAt < CACHE_TTL_MS) {
    return cached.files
  }

  const files: WorkspaceCommandFile[] = []
  // Vyotiq first so it wins on trigger collision when we dedupe.
  for (const { dir, extensions, source } of COMMAND_DIRS) {
    await collectWorkspaceFiles<WorkspaceCommandFile>({
      workspacePath,
      dirPath: join(workspacePath, dir),
      extensions,
      maxFiles: MAX_COMMAND_FILES,
      out: files,
      transform: ({ raw, fileName, absolutePath, relativePath }) => {
        const stem = basename(fileName, '.md')
        const parsed = parseCommandMarkdown(raw, stem)
        const trigger = normalizeTrigger(parsed.name || stem)
        if (!trigger) return null
        return {
          trigger,
          label: parsed.name || stem,
          description: parsed.description,
          body: parsed.body,
          relativePath,
          absolutePath,
          source
        }
      }
    })
  }

  const byTrigger = new Map<string, WorkspaceCommandFile>()
  for (const file of files) {
    const key = file.trigger.toLowerCase()
    if (!byTrigger.has(key)) {
      byTrigger.set(key, file)
    } else if (file.source === 'vyotiq' && byTrigger.get(key)?.source === 'cursor') {
      byTrigger.set(key, file)
    }
  }

  const deduped = [...byTrigger.values()].sort((a, b) => a.trigger.localeCompare(b.trigger))
  cache.set(workspacePath, { fingerprint, files: deduped, builtAt: Date.now() })
  return deduped
}

export async function listWorkspaceCommands(
  workspacePath: string | null
): Promise<SlashCommandDescriptor[]> {
  const files = await readWorkspaceCommands(workspacePath)
  return files.map((file) => ({
    id: `workspace:${file.relativePath}`,
    trigger: file.trigger,
    label: file.label,
    description: file.description || `Workspace command (${file.source})`,
    kind: 'workspace' as const,
    group: 'Commands',
    availability: 'ready' as const
  }))
}

export async function resolveWorkspaceCommand(
  id: string,
  workspacePath: string | null,
  trailingText: string
): Promise<SlashCommandResolveResult | null> {
  if (!id.startsWith('workspace:') || !workspacePath) return null
  const files = await readWorkspaceCommands(workspacePath)
  const file = files.find((f) => `workspace:${f.relativePath}` === id)
  if (!file) return null
  return {
    action: 'send',
    message: formatWorkspaceCommand(file.body, trailingText)
  }
}
