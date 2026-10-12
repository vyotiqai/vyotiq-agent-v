import { homedir } from 'os'
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
/** Copilot's prompt files: only `*.prompt.md` in `.github/prompts` is a command. */
const PROMPT_FILE_SUFFIX = '.prompt.md'

export type WorkspaceCommandSource = 'vyotiq' | 'claude' | 'cursor' | 'github' | 'personal'

type CommandDir = ScanDir & { source: WorkspaceCommandSource; promptFilesOnly?: boolean }

/** Workspace command folders, first wins on a name clash. */
const COMMAND_DIRS: CommandDir[] = [
  { dir: join('.vyotiq', 'commands'), extensions: COMMAND_EXTENSIONS, source: 'vyotiq' },
  { dir: join('.claude', 'commands'), extensions: COMMAND_EXTENSIONS, source: 'claude' },
  { dir: join('.cursor', 'commands'), extensions: COMMAND_EXTENSIONS, source: 'cursor' },
  { dir: join('.github', 'prompts'), extensions: COMMAND_EXTENSIONS, source: 'github', promptFilesOnly: true }
]

/** Your own commands, for every workspace, after the workspace's. Paths are from your home folder. */
const PERSONAL_COMMAND_DIRS: CommandDir[] = [
  { dir: join('.vyotiq', 'commands'), extensions: COMMAND_EXTENSIONS, source: 'personal' },
  { dir: join('.claude', 'commands'), extensions: COMMAND_EXTENSIONS, source: 'personal' }
]

/**
 * The home folder personal commands are read from. Unit tests see none unless
 * they set one, so a machine's own `~/.claude/commands` never leaks into them.
 */
let personalHomeOverride: string | null | undefined
export function setPersonalCommandsHomeForTests(home: string | null | undefined): void {
  personalHomeOverride = home
  cache.clear()
}
function personalHome(): string | null {
  if (personalHomeOverride !== undefined) return personalHomeOverride
  return process.env.VITEST ? null : homedir()
}

const MAX_COMMAND_FILES = 48

export type WorkspaceCommandFile = {
  trigger: string
  label: string
  description: string
  body: string
  relativePath: string
  absolutePath: string
  source: WorkspaceCommandSource
  /** The model the command asks for, as written (`model:`). */
  model?: string
  /** The mode the command asks for (`mode:`, or Copilot's `agent:`). */
  mode?: 'ask' | 'agent'
}

/**
 * Copilot prompt files say `mode:` (now `agent:`) with ask, edit or agent;
 * Edit has no twin here, so it runs as Agent. Anything else (a custom
 * agent's name) is not a mode and is left alone.
 */
function commandMode(value: string | undefined): 'ask' | 'agent' | undefined {
  const v = value?.trim().toLowerCase()
  if (v === 'ask') return 'ask'
  if (v === 'agent' || v === 'edit') return 'agent'
  return undefined
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
  model?: string
  mode?: 'ask' | 'agent'
} {
  const { lines, body } = splitFrontmatter(raw)
  if (!lines) return { name: fallbackName, description: '', body: body.trim() }
  const fields: Record<string, string> = {}
  for (const line of lines) {
    const m = COMMAND_KEY_LINE.exec(line.trim())
    if (!m) continue
    fields[m[1]!] = stripQuotes(m[2]!).trim()
  }
  const model = fields.model?.trim()
  const mode = commandMode(fields.mode ?? fields.agent)
  return {
    name: fields.name?.trim() || fallbackName,
    description: fields.description?.trim() || '',
    body: body.trim(),
    ...(model && model.toLowerCase() !== 'inherit' ? { model } : {}),
    ...(mode ? { mode } : {})
  }
}

export async function readWorkspaceCommands(
  workspacePath: string | null
): Promise<WorkspaceCommandFile[]> {
  if (!workspacePath) return []

  // Stats every command file, not just the directories: an in-place edit does
  // not touch the parent's mtime, so a directory-only fingerprint served the
  // stale body for the whole TTL.
  const home = personalHome()
  const fingerprint = [
    await fingerprintWorkspaceFiles({ workspacePath, dirs: COMMAND_DIRS, maxFiles: MAX_COMMAND_FILES }),
    home ? await fingerprintWorkspaceFiles({ workspacePath: home, dirs: PERSONAL_COMMAND_DIRS, maxFiles: MAX_COMMAND_FILES }) : ''
  ].join('#')
  const cached = cache.get(workspacePath)
  if (cached && cached.fingerprint === fingerprint && Date.now() - cached.builtAt < CACHE_TTL_MS) {
    return cached.files
  }

  const files: WorkspaceCommandFile[] = []
  const roots: { root: string; dirs: CommandDir[]; prefix: string }[] = [
    { root: workspacePath, dirs: COMMAND_DIRS, prefix: '' },
    ...(home ? [{ root: home, dirs: PERSONAL_COMMAND_DIRS, prefix: '~/' }] : [])
  ]
  // In precedence order: the first file to claim a trigger wins when we dedupe.
  for (const { root, dirs, prefix } of roots) {
    for (const { dir, extensions, source, promptFilesOnly } of dirs) {
      await collectWorkspaceFiles<WorkspaceCommandFile>({
        workspacePath: root,
        dirPath: join(root, dir),
        extensions,
        maxFiles: MAX_COMMAND_FILES,
        out: files,
        transform: ({ raw, fileName, absolutePath, relativePath }) => {
          if (promptFilesOnly && !fileName.toLowerCase().endsWith(PROMPT_FILE_SUFFIX)) return null
          const stem = promptFilesOnly ? fileName.slice(0, -PROMPT_FILE_SUFFIX.length) : basename(fileName, '.md')
          const parsed = parseCommandMarkdown(raw, stem)
          const trigger = normalizeTrigger(parsed.name || stem)
          if (!trigger) return null
          return {
            trigger,
            label: parsed.name || stem,
            description: parsed.description,
            body: parsed.body,
            relativePath: `${prefix}${relativePath}`,
            absolutePath,
            source,
            ...(parsed.model ? { model: parsed.model } : {}),
            ...(parsed.mode ? { mode: parsed.mode } : {})
          }
        }
      })
    }
  }

  const byTrigger = new Map<string, WorkspaceCommandFile>()
  for (const file of files) {
    const key = file.trigger.toLowerCase()
    if (!byTrigger.has(key)) byTrigger.set(key, file)
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
    description: file.description || (file.source === 'personal' ? 'Your command' : `Workspace command (${file.source})`),
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
    message: formatWorkspaceCommand(file.body, trailingText),
    ...(file.model ? { model: file.model } : {}),
    ...(file.mode ? { mode: file.mode } : {})
  }
}
