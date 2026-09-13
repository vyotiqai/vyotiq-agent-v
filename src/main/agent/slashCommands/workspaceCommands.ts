import { readdir, readFile, stat } from 'fs/promises'
import { existsSync, statSync, type Dirent } from 'fs'
import { basename, join, relative, sep } from 'path'
import type { SlashCommandDescriptor, SlashCommandResolveResult } from '../../../shared/ipc'
import { formatWorkspaceCommand, normalizeTrigger } from '../../../shared/slashCommands'

const COMMAND_DIRS = [
  { dir: join('.vyotiq', 'commands'), source: 'vyotiq' as const },
  { dir: join('.cursor', 'commands'), source: 'cursor' as const }
]

const CACHE_TTL_MS = 30_000
const MAX_FILE_BYTES = 64 * 1024
const MAX_COMMAND_FILES = 48
const MAX_DIR_DEPTH = 3

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

function fingerprintFor(workspacePath: string): string {
  const parts: string[] = []
  for (const { dir } of COMMAND_DIRS) {
    const p = join(workspacePath, dir)
    try {
      parts.push(existsSync(p) ? `${dir}:${statSync(p).mtimeMs}` : `${dir}:-`)
    } catch {
      parts.push(`${dir}:?`)
    }
  }
  return parts.join('|')
}

function parseCommandMarkdown(raw: string, fallbackName: string): {
  name: string
  description: string
  body: string
} {
  const trimmed = raw.replace(/^\uFEFF/, '')
  if (!trimmed.startsWith('---')) {
    return { name: fallbackName, description: '', body: trimmed.trim() }
  }
  const end = trimmed.indexOf('\n---', 3)
  if (end < 0) {
    return { name: fallbackName, description: '', body: trimmed.trim() }
  }
  const yaml = trimmed.slice(3, end).trim()
  const body = trimmed.slice(end + 4).replace(/^\r?\n/, '')
  const fields: Record<string, string> = {}
  for (const line of yaml.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (!m) continue
    fields[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return {
    name: fields.name?.trim() || fallbackName,
    description: fields.description?.trim() || '',
    body: body.trim()
  }
}

async function readCapped(filePath: string): Promise<string | null> {
  try {
    const info = await stat(filePath)
    if (!info.isFile() || info.size === 0) return null
    const text = await readFile(filePath, 'utf8')
    if (text.length <= MAX_FILE_BYTES) return text
    return `${text.slice(0, MAX_FILE_BYTES)}\n… (truncated)`
  } catch {
    return null
  }
}

async function collectFromDir(
  workspacePath: string,
  dirPath: string,
  source: 'vyotiq' | 'cursor',
  depth: number,
  out: WorkspaceCommandFile[]
): Promise<void> {
  if (depth > MAX_DIR_DEPTH || out.length >= MAX_COMMAND_FILES) return
  let entries: Dirent[]
  try {
    entries = await readdir(dirPath, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of sorted) {
    if (out.length >= MAX_COMMAND_FILES) return
    const full = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      await collectFromDir(workspacePath, full, source, depth + 1, out)
      continue
    }
    if (!entry.name.toLowerCase().endsWith('.md')) continue
    const raw = await readCapped(full)
    if (!raw) continue
    const stem = basename(entry.name, '.md')
    const parsed = parseCommandMarkdown(raw, stem)
    const trigger = normalizeTrigger(parsed.name || stem)
    if (!trigger) continue
    out.push({
      trigger,
      label: parsed.name || stem,
      description: parsed.description,
      body: parsed.body,
      relativePath: relative(workspacePath, full).split(sep).join('/'),
      absolutePath: full,
      source
    })
  }
}

export async function readWorkspaceCommands(
  workspacePath: string | null
): Promise<WorkspaceCommandFile[]> {
  if (!workspacePath) return []

  const fingerprint = fingerprintFor(workspacePath)
  const cached = cache.get(workspacePath)
  if (cached && cached.fingerprint === fingerprint && Date.now() - cached.builtAt < CACHE_TTL_MS) {
    return cached.files
  }

  const files: WorkspaceCommandFile[] = []
  // Vyotiq first so it wins on trigger collision when we dedupe.
  for (const { dir, source } of COMMAND_DIRS) {
    await collectFromDir(workspacePath, join(workspacePath, dir), source, 0, files)
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
